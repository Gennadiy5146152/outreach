"""Private media archive: fake Telegram only, disposable local PostgreSQL."""
import asyncio
import hashlib
import importlib.util
import os
from pathlib import Path
import secrets
import re
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import patch
from uuid import uuid4
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/telegram-connection'))
from cabinet_worker import CabinetWorker
from telethon import types, events, errors
media = __import__('cabinet_media') if importlib.util.find_spec('cabinet_media') else None
UTC = timezone.utc
URL = os.environ.get('CABINET_TEST_DATABASE_URL')


def message(mid=101, uid=990000001, kind='voice', size=6, mime='audio/ogg'):
    attrs = ([types.DocumentAttributeAudio(duration=2, voice=kind == 'voice')]
             if kind in ('voice', 'audio') else
             [types.DocumentAttributeVideo(duration=3, w=40, h=40, round_message=kind == 'video_note')])
    doc = types.Document(id=12, access_hash=123, file_reference=b'test', date=datetime.now(UTC),
                         mime_type=mime, size=size, dc_id=2, attributes=attrs)
    return types.Message(id=mid, peer_id=types.PeerUser(uid), from_id=types.PeerUser(uid),
                         date=datetime.now(UTC), message='caption', media=types.MessageMediaDocument(document=doc))


class ExtractionTests(unittest.TestCase):
    def test_private_media_subsystem_exists(self):
        self.assertIsNotNone(media, 'Private media extraction and durable queue are missing')

    def test_classifies_voice_audio_video_round_without_photos_or_filename_trust(self):
        for kind in ('voice', 'audio', 'video', 'video_note'):
            m = message(kind=kind, mime='video/mp4' if kind.startswith('video') else 'audio/ogg')
            m.document.attributes.append(types.DocumentAttributeFilename('../../secret.mp4'))
            info = media.extract_media(m)
            self.assertEqual(info['kind'], kind)
            self.assertEqual(info['size_bytes'], 6)
            self.assertNotIn('filename', info)
        self.assertIsNone(media.extract_media(types.Message(id=1, peer_id=types.PeerUser(3), message='text')))

    def test_untrusted_mime_uses_octet_stream_and_unknown_size_is_explicit(self):
        info = media.extract_media(message(mime='text/html', size=None))
        self.assertEqual(info['mime_type'], 'application/octet-stream')
        self.assertIsNone(info['size_bytes'])


@unittest.skipUnless(URL, 'Set disposable local CABINET_TEST_DATABASE_URL')
class ArchiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        parsed = urlparse(URL)
        assert parsed.hostname in ('127.0.0.1', 'localhost') and re.fullmatch(r'/cabinet_test(?:_[a-z0-9]+)?',parsed.path)
        self.worker = object.__new__(CabinetWorker)
        self.worker.url, self.worker.enabled = URL, True
        self.db = await self.worker.db()
        self.owner = (await (await self.db.execute("INSERT INTO cabinet_accounts(login,display_name) VALUES(%s,'Media fixture') RETURNING id", ('media-'+uuid4().hex,))).fetchone())['id']
        self.row = await (await self.db.execute("""INSERT INTO cabinet_connections(owner_id,label,expected_username,username,telegram_user_id,status,generation)
             VALUES(%s,'Media fixture','media_fixture','media_fixture',88888,'connected',1) RETURNING *""", (self.owner,))).fetchone()
        self.campaign = (await (await self.db.execute("INSERT INTO cabinet_campaigns(owner_id,connection_id,name,paused) VALUES(%s,%s,'Media fixture',false) RETURNING id", (self.owner,self.row['id']))).fetchone())['id']
        self.peer = 990000001
        self.draft = (await (await self.db.execute("""INSERT INTO cabinet_drafts(owner_id,campaign_id,address,recipient_id,body,permission_kind,permission_evidence)
            VALUES(%s,%s,'https://t.me/media_fixture',%s,'Approved service text','consent','Test only') RETURNING id""", (self.owner,self.campaign,self.peer))).fetchone())['id']
        self.job = await (await self.db.execute("""INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,status,scheduled_at,telegram_message_id,completed_at)
            VALUES(%s,%s,%s,%s,'https://t.me/media_fixture',%s,'Approved service text',%s,'sent',now()-interval '1 hour',100,now()-interval '1 hour') RETURNING *""",
            (self.owner,self.draft,self.campaign,self.row['id'],self.peer,secrets.randbits(62)+1))).fetchone()
        await self.db.execute("""INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at)
            VALUES(%s,%s,%s,%s,100,'outbound','Approved service text',now()-interval '1 hour')""", (self.owner,self.job['id'],self.row['id'],self.peer))
        self.tmp = tempfile.TemporaryDirectory()
        self.archive = media.MediaArchive(self.worker, root=self.tmp.name, floor_bytes=0, cap_bytes=1024)

    async def asyncTearDown(self):
        for table in ('cabinet_media','cabinet_audit','cabinet_plans','cabinet_messages','cabinet_jobs','cabinet_drafts','cabinet_api_tokens','cabinet_campaigns'):
            await self.db.execute(f'DELETE FROM {table} WHERE owner_id=%s', (self.owner,))
        await self.db.execute('DELETE FROM cabinet_connections WHERE owner_id=%s', (self.owner,))
        await self.db.execute('DELETE FROM cabinet_accounts WHERE id=%s', (self.owner,))
        await self.db.close()
        self.tmp.cleanup()

    async def record(self, msg=None):
        msg = msg or message()
        result = await self.worker.incoming(self.row, events.NewMessage.Event(msg))
        return result

    async def stored(self):
        return await (await self.db.execute('SELECT * FROM cabinet_media WHERE owner_id=%s ORDER BY created_at', (self.owner,))).fetchall()

    def client(self, msg=None, chunks=None, error=None, callback=None):
        msg = msg or message()
        class Client:
            def __init__(client): client.reads=[]; client.downloads=0
            async def get_input_entity(client, peer):
                assert isinstance(peer, types.PeerUser)
                return types.InputPeerUser(peer.user_id,123)
            async def get_messages(client, peer, ids):
                client.reads.append((peer.user_id,ids))
                if error: raise error
                return [msg] if isinstance(ids,list) else msg
            def iter_download(client, document, **kwargs):
                client.downloads += 1
                async def stream():
                    if callback: await callback()
                    for chunk in (chunks if chunks is not None else [b'abc',b'def']): yield chunk
                return stream()
        return Client()

    async def test_queue_is_atomic_idempotent_and_bound_to_verified_message(self):
        self.assertTrue(await self.record())
        self.assertFalse(await self.record())
        rows = await self.stored()
        self.assertEqual(len(rows),1)
        self.assertEqual((rows[0]['kind'],rows[0]['status'],rows[0]['job_id']),('voice','queued',self.job['id']))
        self.assertFalse(await self.record(message(mid=99)))
        self.assertFalse(await self.record(message(mid=102,uid=9)))
        self.assertEqual(len(await self.stored()),1)

    async def test_ready_file_is_atomic_hashed_private_and_network_outside_transaction(self):
        await self.record()
        async def callback():
            active = await (await self.db.execute("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).fetchone()
            self.assertEqual(active['n'],0)
            async with await self.worker.db() as other:
                await other.execute("SELECT pg_advisory_lock(hashtext(%s))", ('cabinet-replies:'+str(self.row['id']),))
                await other.execute("SELECT pg_advisory_unlock(hashtext(%s))", ('cabinet-replies:'+str(self.row['id']),))
            self.assertFalse(list(Path(self.tmp.name).glob('*/*.ogg')))
        self.assertTrue(await self.archive.run_once(self.row,self.client(callback=callback)))
        row = (await self.stored())[0]
        self.assertEqual(row['status'],'ready')
        self.assertEqual(row['sha256'],hashlib.sha256(b'abcdef').hexdigest())
        self.assertEqual(row['stored_bytes'],6)
        path=Path(self.tmp.name)/row['storage_key']
        self.assertEqual(path.read_bytes(),b'abcdef')
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o640)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode),0o2750)
        self.assertFalse(list(Path(self.tmp.name).glob('*/*.part')))
        await self.db.execute("UPDATE cabinet_connections SET status='disconnected' WHERE id=%s",(self.row['id'],))
        self.assertFalse(await self.archive.run_once(self.row,self.client()))
        self.assertEqual((await self.stored())[0]['status'],'ready')

    async def test_wrong_peer_never_downloads(self):
        await self.record()
        client=self.client(message(uid=55))
        await self.archive.run_once(self.row,client)
        self.assertEqual(client.downloads,0)
        self.assertEqual((await self.stored())[0]['status'],'unavailable')

    async def test_generation_or_owner_revocation_prevents_read_and_finalize(self):
        await self.record()
        await self.db.execute('UPDATE cabinet_connections SET generation=2 WHERE id=%s',(self.row['id'],))
        client=self.client()
        self.assertFalse(await self.archive.run_once(self.row,client))
        self.assertFalse(client.reads)
        await self.db.execute('UPDATE cabinet_connections SET generation=1 WHERE id=%s',(self.row['id'],))
        async def revoke(): await self.db.execute('UPDATE cabinet_accounts SET active=false WHERE id=%s',(self.owner,))
        await self.archive.run_once(self.row,self.client(callback=revoke))
        self.assertNotEqual((await self.stored())[0]['status'],'ready')
        self.assertFalse(list(Path(self.tmp.name).glob('*/*.ogg')))

    async def test_known_size_cap_unknown_size_and_disk_floor_do_not_consume_attempts(self):
        for size,status,code in ((2048,'too_large','media_too_large'),(None,'waiting_storage','media_size_unknown'),(6,'waiting_storage','media_storage_low')):
            with self.subTest(size=size):
                await self.db.execute('DELETE FROM cabinet_media WHERE owner_id=%s',(self.owner,))
                await self.db.execute('DELETE FROM cabinet_messages WHERE owner_id=%s AND telegram_message_id=101',(self.owner,))
                await self.record(message(size=size))
                self.archive.floor_bytes = 10**18 if size==6 else 0
                client=self.client(message(size=size))
                await self.archive.run_once(self.row,client)
                row=(await self.stored())[0]
                self.assertEqual((row['status'],row['error_code'],row['attempts']),(status,code,0))
                self.assertEqual(client.downloads,0)

    async def test_disk_pressure_midstream_cleans_only_own_part_and_retries(self):
        await self.record()
        with patch.object(self.archive,'free_bytes',side_effect=[100,100,0]):
            await self.archive.run_once(self.row,self.client())
        row=(await self.stored())[0]
        self.assertEqual((row['status'],row['attempts']),('waiting_storage',0))
        self.assertFalse(list(Path(self.tmp.name).glob('*/*.part')))

    async def test_network_retry_bounded_and_flood_is_persisted_without_job_changes(self):
        await self.record()
        await self.archive.run_once(self.row,self.client(error=errors.FloodWaitError(request=None,capture=60)))
        self.assertFalse(await media.rpc_allowed(self.db,self.row['id']))
        self.assertEqual((await self.stored())[0]['error_code'],'telegram_rate_limit')
        campaign=await (await self.db.execute('SELECT paused,revision FROM cabinet_campaigns WHERE id=%s',(self.campaign,))).fetchone()
        self.assertEqual(campaign,{'paused':False,'revision':1})
        client=self.client()
        self.assertFalse(await media.MediaArchive(self.worker,root=self.tmp.name,floor_bytes=0).run_once(self.row,client))
        self.assertFalse(client.reads)
        await self.db.execute('DELETE FROM cabinet_media_rpc_state WHERE connection_id=%s',(self.row['id'],))
        for _ in range(5):
            await self.db.execute("UPDATE cabinet_media SET next_attempt_at=now()-interval '1 second' WHERE owner_id=%s",(self.owner,))
            await self.archive.run_once(self.row,self.client(error=OSError('test')))
        self.assertEqual((await self.stored())[0]['status'],'failed')

    async def test_global_lock_prevents_second_downloader(self):
        await self.record()
        async with await self.worker.db() as lock:
            await lock.execute("SELECT pg_advisory_lock(hashtext('cabinet-media-download'))")
            client=self.client()
            self.assertFalse(await self.archive.run_once(self.row,client))
            self.assertFalse(client.reads)

    async def test_expired_lease_restarts_and_only_generated_part_is_removed(self):
        await self.record()
        row=(await self.stored())[0]
        lease=uuid4()
        ownerdir=Path(self.tmp.name)/str(self.owner); ownerdir.mkdir()
        part=ownerdir/f"{row['id']}.{lease}.part";part.write_bytes(b'partial')
        unrelated=ownerdir/'keep.part';unrelated.write_bytes(b'keep')
        await self.db.execute("UPDATE cabinet_media SET status='downloading',lease_token=%s,lease_until=now()-interval '1 hour',stored_bytes=7 WHERE id=%s",(lease,row['id']))
        await self.archive.run_once(self.row,self.client())
        self.assertEqual((await self.stored())[0]['status'],'ready')
        self.assertFalse(part.exists());self.assertTrue(unrelated.exists())

    async def test_discovery_reads_exact_stored_ids_and_marks_missing_coverage(self):
        await self.record()
        await self.db.execute('DELETE FROM cabinet_media WHERE owner_id=%s',(self.owner,))
        await self.db.execute('UPDATE cabinet_messages SET media_checked_at=NULL WHERE owner_id=%s',(self.owner,))
        client=self.client()
        await self.archive.discover_once(self.row,client)
        self.assertTrue(client.reads)
        self.assertTrue(all(type(ids) is list and len(ids)<=20 and set(ids)<={100,101} for _,ids in client.reads))
        self.assertEqual(len(await self.stored()),1)
        missing=await (await self.db.execute('SELECT media_check_error FROM cabinet_messages WHERE owner_id=%s AND telegram_message_id=100',(self.owner,))).fetchone()
        self.assertEqual(missing['media_check_error'],'media_message_unavailable')

    async def test_discovery_retries_are_bounded_and_backed_off(self):
        await self.db.execute('UPDATE cabinet_messages SET media_checked_at=NULL WHERE owner_id=%s',(self.owner,))
        client=self.client(error=OSError('network unavailable'))
        for attempt in range(5):
            await self.archive.discover_once(self.row,client)
            count=len(client.reads)
            await self.archive.discover_once(self.row,client)
            self.assertEqual(len(client.reads),count,'discovery must back off between RPC failures')
            await self.db.execute("UPDATE cabinet_messages SET media_check_next_attempt_at=now()-interval '1 second' WHERE owner_id=%s",(self.owner,))
        self.assertFalse(await self.archive.discover_once(self.row,client))
        self.assertEqual(len(client.reads),5)
        coverage=await (await self.db.execute('SELECT media_checked_at,media_check_error FROM cabinet_messages WHERE owner_id=%s',(self.owner,))).fetchone()
        self.assertIsNone(coverage['media_checked_at'])
        self.assertEqual(coverage['media_check_error'],'media_discovery_failed')

    async def test_ready_rename_reconciles_after_db_commit_crash_without_redownload(self):
        await self.record()
        item=(await self.stored())[0]
        directory=self.archive.directory(self.owner)
        final=directory/(str(item['id'])+'.ogg')
        final.write_bytes(b'abcdef');final.chmod(0o640)
        client=self.client()
        await self.archive.run_once(self.row,client)
        self.assertEqual((await self.stored())[0]['status'],'ready')
        self.assertEqual(client.downloads,0)
        self.assertFalse(client.reads)

    async def test_active_lease_is_not_stolen_and_oversize_stream_is_not_published(self):
        await self.record()
        await self.db.execute("UPDATE cabinet_media SET status='downloading',lease_token=%s,lease_until=now()+interval '1 hour' WHERE owner_id=%s",(uuid4(),self.owner))
        client=self.client(chunks=[b'abcdefg'])
        self.assertFalse(await self.archive.run_once(self.row,client))
        self.assertFalse(client.reads)
        await self.db.execute("UPDATE cabinet_media SET lease_until=now()-interval '1 second' WHERE owner_id=%s",(self.owner,))
        await self.archive.run_once(self.row,client)
        item=(await self.stored())[0]
        self.assertEqual((item['status'],item['error_code']),('failed','media_size_mismatch'))
        self.assertFalse(list(Path(self.tmp.name).glob('*/*.ogg')))

    async def test_generated_symlink_never_reads_or_overwrites_external_file(self):
        await self.record()
        item=(await self.stored())[0]
        external=Path(self.tmp.name)/'external';external.write_bytes(b'private')
        final=self.archive.directory(self.owner)/(str(item['id'])+'.ogg')
        final.symlink_to(external)
        client=self.client()
        await self.archive.run_once(self.row,client)
        self.assertNotEqual((await self.stored())[0]['status'],'ready')
        self.assertEqual(external.read_bytes(),b'private')
        self.assertEqual(client.downloads,0)

    async def test_future_service_anchor_keeps_telegram_date_and_honest_fallback(self):
        from telethon import functions
        for exact in (datetime(2026,11,28,9,10,11,tzinfo=UTC),None):
            await self.db.execute('DELETE FROM cabinet_messages WHERE owner_id=%s',(self.owner,))
            await self.db.execute("UPDATE cabinet_jobs SET status='queued',attempted_at=NULL,telegram_message_id=NULL WHERE id=%s",(self.job['id'],))
            async def quota(*args): return True
            self.worker.quota_available=quota
            outer=self
            class Client:
                async def get_input_entity(self,address): return types.InputPeerUser(outer.peer,123)
                async def __call__(self,request):
                    outer.assertIsInstance(request,functions.messages.SendMessageRequest)
                    if exact:
                        return types.UpdateShortSentMessage(id=200,pts=1,pts_count=1,date=exact,out=True)
                    return NS(updates=[types.UpdateMessageID(id=200,random_id=outer.job['random_id'])])
            before=datetime.now(UTC)
            with patch('cabinet_worker.within_window',return_value=True):
                await self.worker.send_one(self.db,self.row,Client())
            anchor=await (await self.db.execute('SELECT sent_at,timestamp_source,media_checked_at FROM cabinet_messages WHERE job_id=%s',(self.job['id'],))).fetchone()
            self.assertIsNotNone(anchor)
            self.assertEqual(anchor['timestamp_source'],'telegram' if exact else 'service_receipt')
            if exact: self.assertEqual(anchor['sent_at'],exact)
            else: self.assertGreaterEqual(anchor['sent_at'],before)
            self.assertIsNotNone(anchor['media_checked_at'])

    async def test_media_cooldown_defers_queued_send_without_campaign_or_job_changes(self):
        await self.db.execute("UPDATE cabinet_jobs SET status='queued' WHERE id=%s",(self.job['id'],))
        await media.block_rpc(self.db,self.row['id'],60)
        class NoRPC:
            async def get_input_entity(self,*args): raise AssertionError('cooldown bypassed')
            async def __call__(self,*args): raise AssertionError('send bypassed cooldown')
        await self.worker.send_one(self.db,self.row,NoRPC())
        job=await (await self.db.execute('SELECT status,attempted_at,error_code FROM cabinet_jobs WHERE id=%s',(self.job['id'],))).fetchone()
        self.assertEqual(job,{'status':'queued','attempted_at':None,'error_code':None})
        campaign=await (await self.db.execute('SELECT paused,revision FROM cabinet_campaigns WHERE id=%s',(self.campaign,))).fetchone()
        self.assertEqual(campaign,{'paused':False,'revision':1})

    async def test_enqueue_rollback_cannot_leave_message_without_queue(self):
        original=media.enqueue_message
        async def fail(db,job,msg):
            await original(db,job,msg)
            raise RuntimeError('simulated queue transaction failure')
        with patch('cabinet_worker.enqueue_message',side_effect=fail):
            with self.assertRaises(RuntimeError): await self.record()
        self.assertFalse(await self.stored())
        count=await (await self.db.execute('SELECT count(*) n FROM cabinet_messages WHERE owner_id=%s AND telegram_message_id=101',(self.owner,))).fetchone()
        self.assertEqual(count['n'],0)

    async def test_revocation_at_finalization_does_not_publish_completed_file(self):
        await self.record()
        original=self.archive.finish
        async def revoke(db,row,item,final,digest,**kwargs):
            await self.db.execute('UPDATE cabinet_accounts SET active=false WHERE id=%s',(self.owner,))
            return await original(db,row,item,final,digest,**kwargs)
        with patch.object(self.archive,'finish',side_effect=revoke):
            await self.archive.run_once(self.row,self.client())
        self.assertNotEqual((await self.stored())[0]['status'],'ready')
        self.assertFalse(list(Path(self.tmp.name).glob('*/*.ogg')))

    async def test_unexpected_stream_failure_is_visible_and_not_retried_forever(self):
        await self.record()
        async def fail(): raise RuntimeError('unexpected stream failure')
        await self.archive.run_once(self.row,self.client(callback=fail))
        item=(await self.stored())[0]
        self.assertEqual((item['status'],item['error_code']),('failed','media_internal_error'))
        self.assertFalse(list(Path(self.tmp.name).glob('*/*.part')))

    async def test_exact_message_foreign_key_rejects_cross_scope(self):
        await self.record()
        import psycopg
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            await self.db.execute('UPDATE cabinet_media SET recipient_id=1 WHERE owner_id=%s',(self.owner,))
