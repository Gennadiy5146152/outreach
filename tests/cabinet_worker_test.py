"""No Telegram network calls: real PostgreSQL + fake Telegram RPCs."""
import asyncio
import base64
import hashlib
import os
from pathlib import Path
import secrets
import sys
import unittest
from datetime import datetime, time, timezone
from types import SimpleNamespace as NS
from unittest.mock import patch
from urllib.parse import urlparse
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy/telegram-connection"))
from cabinet_worker import CabinetWorker, decrypt_password, private_session_path, within_window, svg_for
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import psycopg
from telethon import types, errors, events

URL = os.environ.get("CABINET_TEST_DATABASE_URL")
UTC = timezone.utc


class PrimitiveTests(unittest.TestCase):
    def test_encrypted_password_keeps_spaces_and_rejects_tampering(self):
        secret = "test-only-" * 4
        nonce = secrets.token_bytes(12)
        cipher = nonce + AESGCM(hashlib.sha256(secret.encode()).digest()).encrypt(nonce, " пароль с пробелами ".encode(), None)
        self.assertEqual(decrypt_password(base64.b64encode(cipher), secret), " пароль с пробелами ")
        with self.assertRaises(Exception):
            decrypt_password(base64.b64encode(cipher[:-1] + bytes([cipher[-1] ^ 1])), secret)

    def test_paths_cannot_escape_and_qr_contains_no_script(self):
        with self.assertRaises(ValueError):
            private_session_path('/tmp/private', '../outside', 1)
        self.assertIn('<svg', svg_for('tg://login?token=test-only'))
        self.assertNotIn('<script', svg_for('tg://login?token=test-only'))

    def test_moscow_hours_and_weekends(self):
        window = {"window_start": time(9, 30), "window_end": time(11, 30)}
        self.assertTrue(within_window(window, datetime(2026, 11, 24, 6, 30, tzinfo=UTC)))
        self.assertFalse(within_window(window, datetime(2026, 11, 24, 8, 30, tzinfo=UTC)))
        self.assertFalse(within_window(window, datetime(2026, 11, 28, 7, 0, tzinfo=UTC)))


class QrTests(unittest.IsolatedAsyncioTestCase):
    async def test_waiter_starts_before_qr_is_visible_and_two_factor_password_is_cleared(self):
        worker = object.__new__(CabinetWorker)
        worker.secret = 'fake-test-secret-' * 3
        started = asyncio.Event()
        statuses, cleared, passwords = [], [], []
        nonce = secrets.token_bytes(12)
        cipher = base64.b64encode(nonce + AESGCM(hashlib.sha256(worker.secret.encode()).digest()).encrypt(nonce,b' spaces retained ',None)).decode()
        class QR:
            url = 'tg://login?token=fake-test'
            expires = datetime.now(UTC)
            async def wait(self,timeout):
                started.set()
                raise errors.SessionPasswordNeededError(request=None)
        class Client:
            async def is_user_authorized(self): return False
            async def qr_login(self): return QR()
            async def sign_in(self,password): passwords.append(password)
        class DB:
            async def execute(self,sql,args): cleared.append(sql)
        async def update(_db,_row,status,**fields):
            if status == 'qr_ready': self.assertTrue(started.is_set())
            statuses.append(status)
            return True
        async def state(_db,_row): return {'active':True,'generation':1,'status':'password_required','password_cipher':cipher}
        async def identity(_db,_row,_client): return True
        worker.update,worker.state,worker.identity = update,state,identity
        self.assertTrue(await worker.qr_login(DB(),{'id':uuid4(),'generation':1},Client()))
        self.assertEqual(statuses,['qr_ready','password_required'])
        self.assertEqual(passwords,[' spaces retained '])
        self.assertTrue(any('password_cipher=NULL' in sql for sql in cleared))

    async def test_expired_qr_is_removed_and_generation_race_does_not_connect(self):
        worker = object.__new__(CabinetWorker)
        statuses = []
        class QR:
            url='tg://login?token=fake-test'
            expires=datetime.now(UTC)
            async def wait(self,timeout): raise asyncio.TimeoutError()
        class Client:
            async def is_user_authorized(self): return False
            async def qr_login(self): return QR()
        async def update(_db,_row,status,**fields):
            statuses.append((status,fields))
            return True
        worker.update=update
        self.assertFalse(await worker.qr_login(None,{},Client()))
        self.assertEqual(statuses[-1][0],'expired')
        self.assertIsNone(statuses[-1][1]['qr_svg'])
        async def stale(*args,**kwargs): return False
        worker.update=stale
        self.assertFalse(await worker.qr_login(None,{},Client()))


@unittest.skipUnless(URL, 'Set CABINET_TEST_DATABASE_URL to a migrated disposable local database')
class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        parsed = urlparse(URL)
        assert parsed.hostname in ('localhost', '127.0.0.1') and parsed.path in ('/cabinet_test','/cabinet_test_verify')
        self.worker = object.__new__(CabinetWorker)
        self.worker.url, self.worker.enabled = URL, True
        self.db = await self.worker.db()
        owner = await (await self.db.execute("INSERT INTO cabinet_accounts(login,display_name) VALUES(%s,'Test') RETURNING id", ('test-' + uuid4().hex,))).fetchone()
        self.owner = owner['id']
        self.connection = (await (await self.db.execute("""INSERT INTO cabinet_connections(owner_id,label,expected_username,username,status,generation)
            VALUES(%s,'Test','worker_test','worker_test','connected',1) RETURNING *""", (self.owner,))).fetchone())
        self.campaign = (await (await self.db.execute("INSERT INTO cabinet_campaigns(owner_id,connection_id,name,paused) VALUES(%s,%s,'Worker test',false) RETURNING id", (self.owner, self.connection['id']))).fetchone())['id']
        self.peer = 990000001

    async def asyncTearDown(self):
        for table in ('cabinet_audit','cabinet_plans','cabinet_messages','cabinet_jobs','cabinet_drafts','cabinet_api_tokens','cabinet_campaigns','cabinet_connections','cabinet_sessions','cabinet_invites'):
            await self.db.execute(f'DELETE FROM {table} WHERE owner_id=%s', (self.owner,))
        await self.db.execute('DELETE FROM cabinet_accounts WHERE id=%s', (self.owner,))
        await self.db.close()

    async def job(self, peer=None, status='queued', message_id=None):
        peer = peer or self.peer
        draft = (await (await self.db.execute("""INSERT INTO cabinet_drafts(owner_id,campaign_id,address,recipient_id,body,permission_kind,permission_evidence)
            VALUES(%s,%s,'https://t.me/test_recipient',%s,'Точное согласованное сообщение','consent','Тест без отправки') RETURNING id""", (self.owner, self.campaign, peer))).fetchone())['id']
        job = await (await self.db.execute("""INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,status,scheduled_at)
            VALUES(%s,%s,%s,%s,'https://t.me/test_recipient',%s,'Точное согласованное сообщение',%s,%s,now()-interval '1 minute') RETURNING *""", (self.owner, draft, self.campaign, self.connection['id'], peer, secrets.randbits(62)+1, status))).fetchone()
        if message_id:
            await self.db.execute("""INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at)
                VALUES(%s,%s,%s,%s,%s,'outbound','Исходящее',now())""", (self.owner, job['id'], self.connection['id'], peer, message_id))
        return job

    def event(self, mid, parent=None, peer=None, text='Ответ', private=True):
        sender = peer or self.peer
        message = types.Message(id=mid,peer_id=types.PeerUser(sender) if private else types.PeerChat(7777),
                                from_id=types.PeerUser(sender),date=datetime.now(UTC),message=text,out=False,
                                reply_to=types.MessageReplyHeader(reply_to_msg_id=parent) if parent else None)
        return events.NewMessage.Event(message)

    async def rows(self):
        return await (await self.db.execute('SELECT * FROM cabinet_messages WHERE owner_id=%s ORDER BY telegram_message_id', (self.owner,))).fetchall()

    async def test_only_explicit_replies_to_service_chain_are_imported(self):
        await self.job(status='sent',message_id=101)
        await self.worker.incoming(self.connection,self.event(102))  # ordinary private chat
        await self.worker.incoming(self.connection,self.event(103,999))  # unrelated history
        await self.worker.incoming(self.connection,self.event(104,101,peer=self.peer+1))
        await self.worker.incoming(self.connection,self.event(105,101,private=False))
        outgoing = self.event(109,101)
        outgoing.message.out = True
        await self.worker.incoming(self.connection,outgoing)
        self.assertEqual(len(await self.rows()),1)
        await self.worker.incoming(self.connection,self.event(106,101,text='Реальный ответ'))
        await self.worker.incoming(self.connection,self.event(107,106,text='Продолжение этой цепочки'))
        await self.worker.incoming(self.connection,self.event(106,101))  # duplicate update
        self.assertEqual([r['telegram_message_id'] for r in await self.rows()],[101,106,107])
        await self.db.execute("UPDATE cabinet_connections SET generation=2 WHERE id=%s", (self.connection['id'],))
        await self.worker.incoming(self.connection,self.event(108,101))
        self.assertEqual(len(await self.rows()),3)

    def client(self, peer=None, exception=None):
        test = self
        class FakeClient:
            sent = []
            async def get_input_entity(self,_address):
                return types.InputPeerUser(user_id=peer or test.peer,access_hash=123)
            async def __call__(self,request):
                self.sent.append(request)
                if exception:
                    raise exception
                return NS(updates=[types.UpdateMessageID(id=201,random_id=request.random_id)])
        return FakeClient()

    async def test_exact_approved_body_sent_once_with_stable_id_and_saved_outbound(self):
        job = await self.job()
        client = self.client()
        with patch('cabinet_worker.within_window',return_value=True):
            await self.worker.send_one(self.db,self.connection,client)
            await self.worker.send_one(self.db,self.connection,client)
        self.assertEqual(len(client.sent),1)
        self.assertEqual(client.sent[0].message,job['body'])
        self.assertEqual(client.sent[0].random_id,job['random_id'])
        self.assertEqual((await self.rows())[0]['body'],job['body'])
        status = await (await self.db.execute('SELECT status FROM cabinet_jobs WHERE id=%s',(job['id'],))).fetchone()
        self.assertEqual(status['status'],'sent')

    async def test_wrong_identity_never_sends(self):
        job = await self.job()
        client = self.client(peer=self.peer+1)
        with patch('cabinet_worker.within_window',return_value=True):
            await self.worker.send_one(self.db,self.connection,client)
        self.assertFalse(client.sent)
        status = await (await self.db.execute('SELECT status,error_code FROM cabinet_jobs WHERE id=%s',(job['id'],))).fetchone()
        self.assertEqual(status['error_code'],'telegram_recipient_changed')

    async def test_ambiguous_delivery_is_not_retried_and_pauses_remaining_queue(self):
        job = await self.job()
        other = await self.job(peer=self.peer+1)
        client = self.client(exception=asyncio.TimeoutError())
        with patch('cabinet_worker.within_window',return_value=True):
            await self.worker.send_one(self.db,self.connection,client)
            await self.worker.send_one(self.db,self.connection,client)
        self.assertEqual(len(client.sent),1)
        rows = await (await self.db.execute('SELECT id,status FROM cabinet_jobs WHERE owner_id=%s',(self.owner,))).fetchall()
        self.assertEqual({r['id']:r['status'] for r in rows},{job['id']:'uncertain',other['id']:'cancelled'})

    async def test_daily_quota_counts_all_campaigns_and_attempts(self):
        await self.job()
        # Make the connection's actual attempts reach its daily quota, from another campaign.
        await self.db.execute("UPDATE cabinet_campaigns SET daily_limit=1 WHERE id=%s",(self.campaign,))
        previous = await self.job(peer=self.peer+1,status='failed')
        await self.db.execute('UPDATE cabinet_jobs SET attempted_at=now() WHERE id=%s',(previous['id'],))
        client = self.client()
        with patch('cabinet_worker.within_window',return_value=True):
            await self.worker.send_one(self.db,self.connection,client)
        self.assertFalse(client.sent)

    async def test_paused_campaign_and_disabled_sender_never_send(self):
        await self.job()
        client = self.client()
        await self.db.execute('UPDATE cabinet_campaigns SET paused=true WHERE id=%s',(self.campaign,))
        with patch('cabinet_worker.within_window',return_value=True):
            await self.worker.send_one(self.db,self.connection,client)
            await self.db.execute('UPDATE cabinet_campaigns SET paused=false WHERE id=%s',(self.campaign,))
            await self.db.execute('UPDATE cabinet_accounts SET active=false WHERE id=%s',(self.owner,))
            await self.worker.send_one(self.db,self.connection,client)
        self.assertFalse(client.sent)


if __name__ == '__main__':
    unittest.main()
