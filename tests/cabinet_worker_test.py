"""No Telegram network calls: real PostgreSQL + fake Telegram RPCs."""
import asyncio
import base64
import hashlib
import os
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import patch
from urllib.parse import urlparse
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy/telegram-connection"))
from cabinet_worker import CabinetWorker, RecoverySession, MSK, decrypt_password, private_session_path, within_window, svg_for
from recover_replies import recover
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import psycopg
from telethon import TelegramClient, types, errors, events, functions
from telethon.sessions import MemorySession, SQLiteSession
from psycopg.types.json import Jsonb

URL = os.environ.get("CABINET_TEST_DATABASE_URL")
UTC = timezone.utc


class PrimitiveTests(unittest.TestCase):
    def test_maintenance_cannot_advance_or_erase_live_update_cursor(self):
        with tempfile.TemporaryDirectory() as root:
            path = str(Path(root)/'test-only')
            initial = types.updates.State(pts=123, qts=4, date=datetime.now(UTC), seq=5, unread_count=0)
            live = SQLiteSession(path)
            live.set_update_state(0, initial)
            live.set_update_state(42, initial)
            live.save()
            live.close()
            maintenance = RecoverySession(path)
            newer = types.updates.State(pts=999, qts=9, date=datetime.now(UTC), seq=99, unread_count=0)
            maintenance.set_update_state(0, newer)
            maintenance.set_update_state(42, newer)
            maintenance.set_update_state(99, newer)
            maintenance.save()
            maintenance.close()
            restored = SQLiteSession(path)
            self.assertEqual(restored.get_update_state(0).pts, 123)
            self.assertEqual(restored.get_update_state(42).pts, 123)
            self.assertIsNone(restored.get_update_state(99))
            restored.close()
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


    def test_one_off_window_is_pinned_to_its_day_and_does_not_use_base_hours(self):
        job = {"window_start": time(12, 2), "window_end": time(13, 55),
               "one_off_day": datetime(2026, 11, 27).date(),
               "one_off_window_start": time(14), "one_off_window_end": time(15),
               "one_off_daily_limit": 12,
               "scheduled_at": datetime(2026, 11, 27, 11, 0, tzinfo=UTC)}
        self.assertTrue(within_window(job, datetime(2026, 11, 27, 11, 30, tzinfo=UTC)))
        self.assertFalse(within_window(job, datetime(2026, 11, 27, 12, 0, tzinfo=UTC)))
        # A later weekday inside the permanent window must not revive the grant.
        self.assertFalse(within_window(job, datetime(2026, 11, 30, 9, 30, tzinfo=UTC)))
        self.assertFalse(within_window(job, datetime(2026, 11, 27, 10, 0, tzinfo=UTC)))

    def test_approved_twenty_message_saturday_window_is_active_only_that_day(self):
        job = {"window_start": time(12, 2), "window_end": time(15, 55),
               "one_off_mode": "today_batch",
               "one_off_day": datetime(2026, 11, 28).date(),
               "one_off_window_start": time(12, 2), "one_off_window_end": time(15, 55),
               "one_off_daily_limit": 20,
               "scheduled_at": datetime(2026, 11, 28, 9, 2, tzinfo=UTC)}
        self.assertTrue(within_window(job, datetime(2026, 11, 28, 9, 30, tzinfo=UTC)))
        self.assertFalse(within_window(job, datetime(2026, 11, 28, 12, 55, tzinfo=UTC)))
        self.assertFalse(within_window(job, datetime(2026, 11, 29, 9, 30, tzinfo=UTC)))

    def test_partial_or_inconsistent_one_off_metadata_never_uses_ordinary_window(self):
        ordinary = {"window_start": time(12, 2), "window_end": time(13, 55)}
        at = datetime(2026, 11, 27, 9, 30, tzinfo=UTC)
        self.assertTrue(within_window(ordinary, at))
        for changes in (
            {"one_off_day": at.date()},
            {"one_off_day": at.date(), "one_off_window_start": time(14),
             "one_off_window_end": time(15), "one_off_daily_limit": 12,
             "scheduled_at": datetime(2026, 11, 26, 11, tzinfo=UTC)},
        ):
            with self.subTest(changes=changes):
                self.assertFalse(within_window({**ordinary, **changes}, at))


class TodayBatchQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def test_today_batch_tracks_current_limit_without_legacy_plus_two(self):
        worker = object.__new__(CabinetWorker)
        class DB:
            async def execute(self, *args):
                return self
            async def fetchone(self):
                return {"n": 10, "last_at": None}
        job = {"daily_limit": 10, "one_off_day": datetime(2026, 11, 28).date(),
               "one_off_daily_limit": 20, "one_off_mode": "today_batch"}
        self.assertFalse(await worker.quota_available(DB(), {"id": "fixture"}, job))
        self.assertTrue(await worker.quota_available(DB(), {"id": "fixture"}, {**job, "one_off_mode": None}))


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
        await self.db.execute('UPDATE cabinet_connections SET telegram_user_id=88888 WHERE id=%s', (self.connection['id'],))
        self.connection['telegram_user_id'] = 88888
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
            VALUES(%s,%s,'https://t.me/test_recipient',%s,'Точное согласованное сообщение','consent','Тест без отправки')
            ON CONFLICT(campaign_id,recipient_id) DO UPDATE SET address=EXCLUDED.address RETURNING id""", (self.owner, self.campaign, peer))).fetchone())['id']
        job = await (await self.db.execute("""INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,status,scheduled_at)
            VALUES(%s,%s,%s,%s,'https://t.me/test_recipient',%s,'Точное согласованное сообщение',%s,%s,now()-interval '1 minute') RETURNING *""", (self.owner, draft, self.campaign, self.connection['id'], peer, secrets.randbits(62)+1, status))).fetchone()
        if message_id:
            await self.db.execute('UPDATE cabinet_jobs SET telegram_message_id=%s,completed_at=now() WHERE id=%s',
                                  (message_id, job['id']))
            await self.db.execute("""INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at)
                VALUES(%s,%s,%s,%s,%s,'outbound','Исходящее',now()-interval '1 second')""", (self.owner, job['id'], self.connection['id'], peer, message_id))
        return job

    async def source_job(self, peer=None):
        job = await self.job(peer=peer)
        source = {'chat_id': '111222333', 'username': 'public_source_test', 'message_id': 42}
        address = 'tg://user?id=' + str(job['recipient_id'])
        await self.db.execute('UPDATE cabinet_drafts SET recipient_source=%s,address=%s WHERE id=%s',
                              (Jsonb(source), address, job['draft_id']))
        return await (await self.db.execute('UPDATE cabinet_jobs SET recipient_source=%s,address=%s WHERE id=%s RETURNING *',
                                           (Jsonb(source), address, job['id']))).fetchone()

    def source_client(self, uid=None, exception_stage=None, exception=None, callback=None):
        uid = uid or self.peer
        class Client:
            def __init__(self):
                self.requests, self.sent, self.fallback_calls = [], [], []
                self.channel = types.Channel(id=111222333, title='Public fixture', photo=types.ChatPhotoEmpty(),
                    date=datetime.now(UTC), username='public_source_test', megagroup=True, access_hash=12345)
                self.message = types.Message(id=42, peer_id=types.PeerChannel(111222333),
                    from_id=types.PeerUser(uid), date=datetime.now(UTC), message='Exact public source')
                self.author = types.User(id=uid, first_name='Public author', min=True)
                self.resolved = types.contacts.ResolvedPeer(peer=types.PeerChannel(111222333), chats=[self.channel], users=[])
                self.proof = types.messages.Messages(messages=[self.message], topics=[], chats=[self.channel], users=[self.author])
            async def get_input_entity(self, address):
                self.fallback_calls.append(address)
                return types.InputPeerUser(user_id=0, access_hash=0)
            async def __call__(self, request):
                self.requests.append(request)
                if isinstance(request, functions.contacts.ResolveUsernameRequest):
                    stage, result = 'resolve', self.resolved
                elif isinstance(request, functions.channels.GetMessagesRequest):
                    stage, result = 'proof', self.proof
                elif isinstance(request, functions.messages.SendMessageRequest):
                    stage = 'send'
                    self.sent.append(request)
                    result = NS(updates=[types.UpdateMessageID(id=201, random_id=request.random_id)])
                else:
                    raise AssertionError('Unexpected Telegram RPC: ' + type(request).__name__)
                if callback:
                    await callback(stage)
                if stage == exception_stage:
                    raise exception
                return result
        return Client()

    async def grant(self, job, day=None, start=time(0), end=time(23, 59), limit=12, offset_seconds=0):
        now = (await (await self.db.execute('SELECT now() at')).fetchone())['at'].astimezone(MSK)
        day = day or now.date()
        scheduled = datetime.combine(day, start, tzinfo=MSK) + timedelta(seconds=offset_seconds)
        await self.db.execute("""UPDATE cabinet_jobs SET scheduled_at=%s,one_off_day=%s,
            one_off_window_start=%s,one_off_window_end=%s,one_off_daily_limit=%s WHERE id=%s""",
            (scheduled, day, start, end, limit, job['id']))

    async def seed_attempts(self, count):
        offset = getattr(self, "seeded_attempts", 0)
        self.seeded_attempts = offset + count
        for i in range(count):
            previous = await self.job(peer=self.peer + i + offset + 100, status='failed')
            await self.db.execute("""UPDATE cabinet_jobs SET attempted_at=
                (date_trunc('day',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')
                WHERE id=%s""", (previous['id'],))

    async def job_state(self, job):
        return await (await self.db.execute('SELECT status,error_code,attempted_at FROM cabinet_jobs WHERE id=%s',
                                          (job['id'],))).fetchone()

    def event(self, mid, parent=None, peer=None, text='Ответ', private=True):
        sender = peer or self.peer
        message = types.Message(id=mid,peer_id=types.PeerUser(sender) if private else types.PeerChat(7777),
                                from_id=types.PeerUser(sender),date=datetime.now(UTC),message=text,out=False,
                                reply_to=types.MessageReplyHeader(reply_to_msg_id=parent) if parent else None)
        return events.NewMessage.Event(message)

    async def rows(self):
        return await (await self.db.execute('SELECT * FROM cabinet_messages WHERE owner_id=%s ORDER BY telegram_message_id', (self.owner,))).fetchall()

    async def test_explicit_replies_cannot_fall_back_to_unrelated_threads(self):
        await self.job(status='sent',message_id=101)
        await self.worker.incoming(self.connection,self.event(103,999))  # unrelated history
        await self.worker.incoming(self.connection,self.event(104,101,peer=self.peer+1))
        await self.worker.incoming(self.connection,self.event(105,101,private=False))
        self.assertEqual(len(await self.rows()),1)
        await self.worker.incoming(self.connection,self.event(106,101,text='Реальный ответ'))
        await self.worker.incoming(self.connection,self.event(107,106,text='Продолжение этой цепочки'))
        await self.worker.incoming(self.connection,self.event(106,101))  # duplicate update
        self.assertEqual([r['telegram_message_id'] for r in await self.rows()],[101,106,107])
        await self.db.execute("UPDATE cabinet_connections SET generation=2 WHERE id=%s", (self.connection['id'],))
        await self.worker.incoming(self.connection,self.event(108,101))
        self.assertEqual(len(await self.rows()),3)

    async def test_ordinary_reply_and_manual_continuation_are_recorded_once(self):
        job = await self.job(status='sent', message_id=101)
        answer = self.event(102, text='Да, сколько стоит?')
        await self.worker.incoming(self.connection, answer)
        await self.worker.incoming(self.connection, answer)
        manual = self.event(103, text='Какая у вас модель?')
        manual.message.out = True
        manual.message.from_id = types.PeerUser(88888)
        await self.worker.incoming(self.connection, manual)
        await self.worker.incoming(self.connection, self.event(104, text='L7'))
        rows = await self.rows()
        self.assertEqual([(r['telegram_message_id'], r['direction'], r['body']) for r in rows],
                         [(101, 'outbound', 'Исходящее'), (102, 'inbound', 'Да, сколько стоит?'),
                          (103, 'outbound', 'Какая у вас модель?'), (104, 'inbound', 'L7')])
        self.assertTrue(all(r['job_id'] == job['id'] for r in rows))
        self.assertIsNone(rows[1]['reply_to_message_id'])

    async def test_ordinary_messages_require_sent_anchor_correct_peer_time_and_live_connection(self):
        await self.job(status='sent', message_id=101)
        before = self.event(102)
        before.message.date -= timedelta(hours=1)
        for event in (before, self.event(100), self.event(103, peer=self.peer+1),
                      self.event(104, private=False)):
            await self.worker.incoming(self.connection, event)
        mismatched = self.event(105)
        mismatched.message.from_id = types.PeerUser(self.peer+1)
        await self.worker.incoming(self.connection, mismatched)
        await self.db.execute("UPDATE cabinet_connections SET status='disconnected' WHERE id=%s", (self.connection['id'],))
        await self.worker.incoming(self.connection, self.event(106))
        self.assertEqual(len(await self.rows()), 1)

    async def test_ordinary_messages_never_cross_owner_generation_or_unsent_job(self):
        job = await self.job(status='queued', message_id=101)
        await self.worker.incoming(self.connection, self.event(102))
        await self.db.execute("UPDATE cabinet_jobs SET status='sent' WHERE id=%s", (job['id'],))
        await self.worker.incoming({**self.connection, 'owner_id': uuid4()}, self.event(103))
        await self.worker.incoming({**self.connection, 'generation': 99}, self.event(104))
        await self.db.execute('UPDATE cabinet_accounts SET active=false WHERE id=%s', (self.owner,))
        await self.worker.incoming(self.connection, self.event(105))
        self.assertEqual(len(await self.rows()), 1)

    async def test_same_second_reply_is_not_lost_to_database_subsecond_precision(self):
        await self.job(status='sent', message_id=101)
        stamp = datetime.now(UTC).replace(microsecond=900000)
        await self.db.execute('UPDATE cabinet_messages SET sent_at=%s WHERE owner_id=%s', (stamp, self.owner))
        event = self.event(102)
        event.message.date = stamp.replace(microsecond=0)
        await self.worker.incoming(self.connection, event)
        self.assertEqual(len(await self.rows()), 2)

    async def test_reply_before_delayed_send_receipt_is_not_lost(self):
        job = await self.job(status='sent', message_id=101)
        receipt = datetime.now(UTC)
        await self.db.execute('UPDATE cabinet_jobs SET attempted_at=%s WHERE id=%s',
                              (receipt-timedelta(seconds=5), job['id']))
        event = self.event(102)
        event.message.date = receipt-timedelta(seconds=2)
        await self.worker.incoming(self.connection, event)
        explicit = self.event(103, 101)
        explicit.message.date = event.message.date
        await self.worker.incoming(self.connection, explicit)
        self.assertEqual(len(await self.rows()), 3)

    async def test_ordinary_reply_uses_latest_preceding_job_but_explicit_keeps_its_chain(self):
        old = await self.job(status='sent', message_id=101)
        new = await self.job(status='sent', message_id=201)
        await self.worker.incoming(self.connection, self.event(202))
        await self.worker.incoming(self.connection, self.event(203, 101))
        rows = {r['telegram_message_id']: r for r in await self.rows()}
        self.assertEqual(rows[202]['job_id'], new['id'])
        self.assertEqual(rows[203]['job_id'], old['id'])

    async def test_manual_outgoing_during_delivery_does_not_steal_service_receipt(self):
        await self.job(status='sent', message_id=101)
        await self.job(status='sending')
        event = self.event(202)
        event.message.out = True
        await self.worker.incoming(self.connection, event)
        self.assertEqual(len(await self.rows()), 1)

    async def test_reply_during_send_waits_for_verified_anchor(self):
        job = await self.job()
        pending = []
        test = self
        class Client:
            async def get_input_entity(self, _address): return types.InputPeerUser(test.peer, 123)
            async def __call__(self, request):
                pending.append(asyncio.create_task(test.worker.incoming(test.connection, test.event(202))))
                await asyncio.sleep(0.05)
                return NS(updates=[types.UpdateMessageID(id=201,random_id=request.random_id)])
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, Client())
        await asyncio.gather(*pending)
        rows = await self.rows()
        self.assertEqual([r['telegram_message_id'] for r in rows], [201,202])
        self.assertTrue(all(r['job_id'] == job['id'] for r in rows))

    def history_client(self, batches, *, wrong_identity=False):
        test = self
        class Client(TelegramClient):
            def __init__(self):
                super().__init__(MemorySession(), 12345, 'test-only-hash', receive_updates=False)
                self.requests = []
            async def get_me(self):
                return NS(id=88889 if wrong_identity else 88888, username='worker_test', bot=False)
            async def get_input_entity(self, peer):
                test.assertIn(peer, (types.PeerUser(test.peer), types.InputPeerUser(test.peer, 123)))
                return types.InputPeerUser(test.peer, 123)
            async def __call__(self, request):
                # Only scoped, non-mutating history RPCs are allowed by this double.
                test.assertIsInstance(request, functions.messages.GetHistoryRequest)
                test.assertEqual(request.peer.user_id, test.peer)
                test.assertEqual(request.min_id, 0)
                test.assertEqual(request.add_offset, -request.limit)
                test.assertGreater(request.offset_id, 101)
                self.requests.append(NS(offset_id=request.offset_id, min_id=request.min_id))
                result = batches[len(self.requests)-1]
                if isinstance(result, Exception): raise result
                if isinstance(result, types.messages.MessagesSlice): return result
                return types.messages.Messages(messages=result, topics=[], chats=[], users=[])
        return Client()

    async def test_recovery_imports_only_approved_peer_after_anchor_and_is_idempotent(self):
        job = await self.job(status='sent', message_id=101)
        since = datetime.now(UTC) - timedelta(hours=1)
        first, second = self.event(102), self.event(103, 102)
        until = datetime.now(UTC)
        for _ in range(2):
            result = await self.worker.recover_messages(self.connection,
                self.history_client([[second.message, first.message]]), [job['id']], since, until)
            self.assertEqual(result['complete'], True)
        self.assertEqual([r['telegram_message_id'] for r in await self.rows()], [101,102,103])

    async def test_recovery_rejects_other_jobs_stale_generation_wrong_identity_and_excessive_range(self):
        job = await self.job(status='sent', message_id=101)
        since, until = datetime.now(UTC)-timedelta(hours=1), datetime.now(UTC)
        for ids, row, client, start in (
            ([uuid4()], self.connection, self.history_client([]), since),
            ([job['id']], {**self.connection, 'generation': 99}, self.history_client([]), since),
            ([job['id']], self.connection, self.history_client([], wrong_identity=True), since),
            ([job['id']], self.connection, self.history_client([]), since-timedelta(days=2)),
        ):
            with self.subTest(ids=ids, start=start), self.assertRaises(ValueError):
                await self.worker.recover_messages(row, client, ids, start, until)
            self.assertEqual(client.requests, [])

    async def test_recovery_validates_returned_peer_and_reports_floodwait_without_retry(self):
        job = await self.job(status='sent', message_id=101)
        since, until = datetime.now(UTC)-timedelta(hours=1), datetime.now(UTC)
        wrong = self.event(102, peer=self.peer+1)
        client = self.history_client([[wrong.message]])
        with self.assertRaises(ValueError):
            await self.worker.recover_messages(self.connection, client, [job['id']], since, until)
        self.assertEqual(len(await self.rows()), 1)
        client = self.history_client([errors.FloodWaitError(request=None, capture=30)])
        with self.assertRaises(errors.FloodWaitError):
            await self.worker.recover_messages(self.connection, client, [job['id']], since, until)
        self.assertEqual(len(client.requests), 1)

    async def test_recovery_paginates_chronologically_and_does_not_silently_truncate(self):
        job = await self.job(status='sent', message_id=101)
        since = datetime.now(UTC)-timedelta(hours=1)
        batch = [self.event(mid).message for mid in range(201,101,-1)]
        tail = [self.event(202).message]
        until = datetime.now(UTC)
        slice_page = types.messages.MessagesSlice(count=101, messages=batch, topics=[], chats=[], users=[])
        client = self.history_client([slice_page, tail])
        await self.worker.recover_messages(self.connection, client, [job['id']], since, until)
        self.assertEqual(client.requests[1].offset_id, 202)
        self.assertEqual(len(await self.rows()), 102)
        with self.assertRaises(ValueError):
            await self.worker.recover_messages(self.connection, self.history_client([batch]),
                                               [job['id']], since, until, max_messages=10)

    async def test_recovery_follows_short_slices_using_real_telethon_iterator(self):
        job = await self.job(status='sent', message_id=101)
        since = datetime.now(UTC)-timedelta(hours=1)
        first, second = self.event(102), self.event(103)
        until = datetime.now(UTC)
        slice_page = types.messages.MessagesSlice(count=2, messages=[first.message], topics=[], chats=[], users=[])
        client = self.history_client([slice_page, [second.message]])
        await self.worker.recover_messages(self.connection, client, [job['id']], since, until)
        self.assertEqual([r['telegram_message_id'] for r in await self.rows()], [101,102,103])
        self.assertEqual(client.requests[1].offset_id, 103)

    async def test_recovery_does_not_import_outside_time_or_selected_jobs(self):
        first = await self.job(status='sent', message_id=101)
        selected_since = datetime.now(UTC)-timedelta(minutes=30)
        before = self.event(102)
        before.message.date = selected_since-timedelta(seconds=1)
        # Set the verified anchor earlier than the requested recovery interval.
        await self.db.execute("UPDATE cabinet_messages SET sent_at=%s WHERE job_id=%s",
                              (selected_since-timedelta(minutes=10), first['id']))
        latest = await self.job(status='sent', message_id=201)
        after = self.event(202)
        until = datetime.now(UTC)
        await self.worker.recover_messages(self.connection, self.history_client([[after.message, before.message]]),
                                           [first['id']], selected_since, until)
        self.assertEqual([r['telegram_message_id'] for r in await self.rows()], [101,201])

    async def test_maintenance_refuses_busy_connection_before_opening_session(self):
        job = await self.job(status='sent', message_id=101)
        args = NS(owner_id=self.owner, connection_id=self.connection['id'], job_id=[job['id']],
                  since=datetime.now(UTC)-timedelta(hours=1), until=datetime.now(UTC))
        key = 'cabinet-connection:' + str(self.connection['id'])
        await self.db.execute('SELECT pg_advisory_lock(hashtext(%s))', (key,))
        try:
            with patch('recover_replies.CabinetWorker', return_value=self.worker):
                with self.assertRaisesRegex(ValueError, 'recovery_connection_busy'):
                    await recover(args)
        finally:
            await self.db.execute('SELECT pg_advisory_unlock(hashtext(%s))', (key,))

    async def test_maintenance_disconnects_and_releases_lock_after_failed_recovery(self):
        job = await self.job(status='sent', message_id=101)
        args = NS(owner_id=self.owner, connection_id=self.connection['id'], job_id=[job['id']],
                  since=datetime.now(UTC)-timedelta(hours=1), until=datetime.now(UTC))
        client = self.history_client([errors.FloodWaitError(request=None, capture=30)])
        connected, disconnected = [], []
        async def connect(): connected.append(True)
        async def disconnect(): disconnected.append(True)
        client.connect, client.disconnect = connect, disconnect
        def maintenance_client(_path, *, receive_updates):
            self.assertFalse(receive_updates)
            return client
        self.worker.client = maintenance_client
        with tempfile.TemporaryDirectory() as root:
            self.worker.root = Path(root)
            private_session_path(self.worker.root, self.connection['id'], 1).touch()
            with patch('recover_replies.CabinetWorker', return_value=self.worker):
                with self.assertRaises(errors.FloodWaitError):
                    await recover(args)
        self.assertEqual((len(connected), len(disconnected)), (1,1))
        key = 'cabinet-connection:' + str(self.connection['id'])
        lock = await (await self.db.execute('SELECT pg_try_advisory_lock(hashtext(%s)) AS locked', (key,))).fetchone()
        self.assertTrue(lock['locked'])
        await self.db.execute('SELECT pg_advisory_unlock(hashtext(%s))', (key,))

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

    async def test_qr_reconnect_cannot_replace_an_already_bound_telegram_identity(self):
        logged_out=[]
        class Client:
            async def get_me(_self): return NS(id=88888,username='worker_test',bot=False)
            async def log_out(_self): logged_out.append(True)
        row={**self.connection,'telegram_user_id':77777}
        self.assertFalse(await self.worker.identity(self.db,row,Client()))
        self.assertEqual(logged_out,[True])

    async def test_unused_legacy_placeholder_does_not_prevent_private_qr_login(self):
        await self.db.execute("INSERT INTO outreach_telegram_profiles(sender,connection_status) VALUES('worker_test','awaiting_session')")
        class Client:
            async def get_me(_self): return NS(id=88888,username='worker_test',bot=False)
            async def log_out(_self): raise AssertionError('Unused placeholder must not block login')
        try:
            self.assertTrue(await self.worker.identity(self.db,self.connection,Client()))
        finally:
            await self.db.execute("DELETE FROM outreach_telegram_profiles WHERE sender='worker_test'")

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

    async def test_ordinary_job_cannot_use_one_off_capacity_after_ten_attempts(self):
        job = await self.job()
        await self.seed_attempts(10)
        client = self.client()
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        self.assertEqual((await self.job_state(job))['status'], 'queued')

    async def test_only_approved_jobs_can_reach_twelve_and_ordinary_job_stays_blocked(self):
        first, second = await self.job(), await self.job(peer=self.peer + 1)
        await self.grant(first)
        await self.grant(second, offset_seconds=1)
        # The permanent campaign window is deliberately closed; the job window is explicit.
        await self.db.execute("UPDATE cabinet_campaigns SET window_start='00:00',window_end='00:30' WHERE id=%s", (self.campaign,))
        await self.seed_attempts(10)
        client = self.client()
        await self.worker.send_one(self.db, self.connection, client)
        self.assertEqual((await self.job_state(first))['status'], 'sent')
        # Time passes between these two independent worker ticks.
        await self.db.execute("UPDATE cabinet_jobs SET attempted_at=now()-interval '4 minutes' WHERE id=%s", (first['id'],))
        second_client = self.client(peer=second['recipient_id'])
        await self.worker.send_one(self.db, self.connection, second_client)
        self.assertEqual((await self.job_state(second))['status'], 'sent')
        ordinary = await self.job(peer=self.peer + 2)
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, client)
        sent = client.sent + second_client.sent
        self.assertEqual(len(sent), 2)
        self.assertEqual([request.random_id for request in sent], [first['random_id'], second['random_id']])
        self.assertEqual((await self.job_state(ordinary))['status'], 'queued')
        campaign = await (await self.db.execute('SELECT daily_limit,window_start,window_end FROM cabinet_campaigns WHERE id=%s', (self.campaign,))).fetchone()
        self.assertEqual(campaign, {'daily_limit': 10, 'window_start': time(0), 'window_end': time(0, 30)})

    async def test_one_off_current_reduced_base_and_approved_ceiling_are_both_enforced(self):
        job = await self.job()
        await self.grant(job)
        await self.db.execute('UPDATE cabinet_campaigns SET daily_limit=8 WHERE id=%s', (self.campaign,))
        await self.seed_attempts(10)
        client = self.client()
        await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        # Raising the base must not enlarge the approved ceiling of twelve.
        await self.db.execute('UPDATE cabinet_campaigns SET daily_limit=20 WHERE id=%s', (self.campaign,))
        await self.seed_attempts(2)
        await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        self.assertIsNone((await self.job_state(job))['attempted_at'])

    async def test_explicit_twenty_ceiling_does_not_gain_two_more_when_base_is_twenty(self):
        await self.db.execute('UPDATE cabinet_campaigns SET daily_limit=20 WHERE id=%s', (self.campaign,))
        first, second = await self.job(), await self.job(peer=self.peer + 1)
        await self.grant(first, limit=20)
        await self.grant(second, limit=20, offset_seconds=1)
        await self.seed_attempts(19)
        client = self.client()
        await self.worker.send_one(self.db, self.connection, client)
        self.assertEqual((await self.job_state(first))['status'], 'sent')
        await self.db.execute("UPDATE cabinet_jobs SET attempted_at=now()-interval '4 minutes' WHERE id=%s", (first['id'],))
        await self.worker.send_one(self.db, self.connection, client)
        self.assertEqual(len(client.sent), 1)
        self.assertEqual((await self.job_state(second))['status'], 'queued')

    async def test_one_off_expired_day_and_window_cancel_without_attempt(self):
        now = (await (await self.db.execute('SELECT now() at')).fetchone())['at'].astimezone(MSK)
        for index, kind in enumerate(('day', 'window')):
            with self.subTest(kind=kind):
                job = await self.job(peer=self.peer + index)
                if kind == 'day':
                    await self.grant(job, day=now.date() - timedelta(days=1))
                else:
                    await self.grant(job, end=(now - timedelta(seconds=1)).time().replace(tzinfo=None))
                client = self.client()
                await self.worker.send_one(self.db, self.connection, client)
                state = await self.job_state(job)
                self.assertEqual(state, {'status': 'cancelled', 'error_code': 'one_off_window_expired', 'attempted_at': None})
                self.assertFalse(client.sent)

    async def test_expired_one_off_is_cancelled_even_when_campaign_paused(self):
        job = await self.job()
        now = (await (await self.db.execute('SELECT now() at')).fetchone())['at'].astimezone(MSK)
        await self.grant(job, day=now.date() - timedelta(days=1))
        await self.db.execute('UPDATE cabinet_campaigns SET paused=true WHERE id=%s', (self.campaign,))
        client = self.client()
        await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        self.assertEqual(await self.job_state(job), {
            'status': 'cancelled', 'error_code': 'one_off_window_expired', 'attempted_at': None})

    async def test_one_off_expiry_during_peer_resolution_never_starts_attempt(self):
        job = await self.job()
        await self.grant(job)
        client = self.client()
        # Advance only the worker's clock while peer resolution is awaiting Telegram.
        instant = (await (await self.db.execute('SELECT now() at')).fetchone())['at']
        class ClockMeta(type):
            def __instancecheck__(cls, instance):
                return isinstance(instance, datetime)
        class Clock(datetime, metaclass=ClockMeta):
            at = instant
            @classmethod
            def now(cls, tz=None):
                return cls.at.astimezone(tz) if tz else cls.at.replace(tzinfo=None)
        resolve = client.get_input_entity
        async def resolving(address):
            peer = await resolve(address)
            Clock.at += timedelta(days=1)
            return peer
        client.get_input_entity = resolving
        with patch('cabinet_worker.datetime', Clock):
            await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        state = await self.job_state(job)
        self.assertEqual(state['status'], 'cancelled')
        self.assertEqual(state['error_code'], 'one_off_window_expired')
        self.assertIsNone(state['attempted_at'])

    async def test_one_off_still_requires_spacing_and_matching_recipient(self):
        job = await self.job()
        await self.grant(job)
        previous = await self.job(peer=self.peer + 1, status='failed')
        await self.db.execute('UPDATE cabinet_jobs SET attempted_at=now() WHERE id=%s', (previous['id'],))
        client = self.client(peer=self.peer + 1)
        await self.worker.send_one(self.db, self.connection, client)
        self.assertEqual((await self.job_state(job))['status'], 'queued')
        await self.db.execute("UPDATE cabinet_jobs SET attempted_at=now()-interval '4 minutes' WHERE id=%s", (previous['id'],))
        await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        state = await self.job_state(job)
        self.assertEqual(state['error_code'], 'telegram_recipient_changed')
        self.assertIsNone(state['attempted_at'])

    async def test_one_off_does_not_bypass_delivery_stops_or_connection_generation(self):
        job = await self.job()
        await self.grant(job)
        client = self.client()
        mutations = (
            ('cabinet_campaigns', self.campaign, 'paused', True, False),
            ('cabinet_drafts', job['draft_id'], 'stopped', True, False),
            ('cabinet_accounts', self.owner, 'active', False, True),
            ('cabinet_connections', self.connection['id'], 'generation', 2, 1),
            ('cabinet_connections', self.connection['id'], 'status', 'disconnected', 'connected'),
        )
        for table, key, column, stopped, restored in mutations:
            with self.subTest(stop=column):
                await self.db.execute(f'UPDATE {table} SET {column}=%s WHERE id=%s', (stopped, key))
                await self.worker.send_one(self.db, self.connection, client)
                self.assertFalse(client.sent)
                self.assertIsNone((await self.job_state(job))['attempted_at'])
                await self.db.execute(f'UPDATE {table} SET {column}=%s WHERE id=%s', (restored, key))
        self.worker.enabled = False
        await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        self.assertIsNone((await self.job_state(job))['attempted_at'])

    async def test_one_off_rate_limit_and_uncertain_delivery_pause_without_retry(self):
        for index, (exception, status, code) in enumerate((
            (errors.FloodWaitError(request=None, capture=60), 'failed', 'telegram_rate_limit'),
            (asyncio.TimeoutError(), 'uncertain', 'telegram_delivery_uncertain'),
        )):
            with self.subTest(code=code):
                await self.db.execute('UPDATE cabinet_campaigns SET paused=false WHERE id=%s', (self.campaign,))
                # Isolate each external failure while retaining the account-wide usage check.
                await self.db.execute("UPDATE cabinet_jobs SET attempted_at=now()-interval '4 minutes' WHERE owner_id=%s", (self.owner,))
                job = await self.job(peer=self.peer + index * 2)
                await self.grant(job)
                other = await self.job(peer=self.peer + index * 2 + 1)
                client = self.client(peer=job['recipient_id'], exception=exception)
                await self.worker.send_one(self.db, self.connection, client)
                await self.worker.send_one(self.db, self.connection, client)
                self.assertEqual(len(client.sent), 1)
                state = await self.job_state(job)
                self.assertEqual((state['status'], state['error_code']), (status, code))
                self.assertIsNotNone(state['attempted_at'])
                self.assertEqual((await self.job_state(other))['status'], 'cancelled')

    async def test_source_metadata_is_strict_and_rejected_before_any_rpc(self):
        source = {'chat_id': '111222333', 'username': 'public_source_test', 'message_id': 42}
        malformed = (False, 0, [], {}, {**source, 'unexpected': 1},
            {**source, 'chat_id': 111222333}, {**source, 'chat_id': '0'},
            {**source, 'chat_id': '-100111222333'}, {**source, 'chat_id': '0111222333'},
            {**source, 'chat_id': '9223372036854775808'},
            {**source, 'username': 'Public_source_test'}, {**source, 'username': 'abcd'},
            {**source, 'username': 't.me/public_source_test'}, {**source, 'username': 'a' * 33},
            {**source, 'message_id': True}, {**source, 'message_id': '42'},
            {**source, 'message_id': 42.0}, {**source, 'message_id': 0},
            {**source, 'message_id': 2147483648})
        for value in malformed:
            with self.subTest(source=value):
                client = self.source_client()
                job = {'recipient_source': value, 'recipient_id': self.peer, 'address': 'tg://user?id=' + str(self.peer)}
                with self.assertRaisesRegex(ValueError, '^telegram_source_invalid$'):
                    await self.worker.source_peer(job, client)
                self.assertFalse(client.requests)
                self.assertFalse(client.fallback_calls)
        for address in ('https://t.me/test_recipient', 'tg://user?id=999', 'tg://user?id=0990000001'):
            with self.subTest(address=address):
                client = self.source_client()
                with self.assertRaisesRegex(ValueError, '^telegram_source_invalid$'):
                    await self.worker.source_peer({'recipient_source': source, 'recipient_id': self.peer, 'address': address}, client)
                self.assertFalse(client.requests)

    async def test_source_recipient_sends_only_after_exact_public_proof_with_stable_id(self):
        job = await self.source_job()
        async def check_durable_attempt(stage):
            state = await self.job_state(job)
            if stage == 'send':
                self.assertEqual(state['status'], 'sending')
                self.assertIsNotNone(state['attempted_at'])
            else:
                self.assertIsNone(state['attempted_at'])
        client = self.source_client(callback=check_durable_attempt)
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, client)
            await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.fallback_calls)
        self.assertEqual([type(request) for request in client.requests], [
            functions.contacts.ResolveUsernameRequest, functions.channels.GetMessagesRequest,
            functions.messages.SendMessageRequest])
        self.assertEqual(client.requests[0].username, 'public_source_test')
        read = client.requests[1]
        self.assertIsInstance(read.channel, types.InputChannel)
        self.assertEqual(read.channel.channel_id, 111222333)
        self.assertEqual([(type(item), item.id) for item in read.id], [(types.InputMessageID, 42)])
        sent = client.sent[0]
        self.assertIsInstance(sent.peer, types.InputPeerUserFromMessage)
        self.assertIsInstance(sent.peer.peer, types.InputPeerChannel)
        self.assertEqual((sent.peer.peer.channel_id, sent.peer.msg_id, sent.peer.user_id), (111222333, 42, self.peer))
        self.assertEqual((sent.message, sent.random_id), (job['body'], job['random_id']))
        self.assertIsNone(sent.reply_to)
        self.assertIsNone(sent.allow_paid_stars)
        self.assertEqual((await self.job_state(job))['status'], 'sent')
        self.assertEqual([(row['recipient_id'], row['body']) for row in await self.rows()], [(self.peer, job['body'])])

    async def test_source_group_requires_pinned_public_megagroup_and_active_username(self):
        cases = (
            ('reassigned', lambda c: setattr(c.resolved, 'peer', types.PeerChannel(999))),
            ('user', lambda c: setattr(c.resolved, 'peer', types.PeerUser(self.peer))),
            ('no_group', lambda c: setattr(c.resolved, 'chats', [])),
            ('wrong_group', lambda c: setattr(c.channel, 'id', 999)),
            ('broadcast', lambda c: setattr(c.channel, 'broadcast', True)),
            ('not_megagroup', lambda c: setattr(c.channel, 'megagroup', False)),
            ('min', lambda c: setattr(c.channel, 'min', True)),
            ('no_hash', lambda c: setattr(c.channel, 'access_hash', None)),
            ('private', lambda c: setattr(c.channel, 'username', None)),
            ('inactive_alias', lambda c: (setattr(c.channel, 'username', None),
                setattr(c.channel, 'usernames', [types.Username(username='public_source_test', active=False)]))),
            ('forbidden', lambda c: setattr(c.resolved, 'chats', [types.ChannelForbidden(id=111222333,
                access_hash=12345, title='Not accessible', megagroup=True)])),
        )
        for index, (name, mutate) in enumerate(cases):
            with self.subTest(case=name):
                job = await self.source_job(peer=self.peer + index)
                client = self.source_client(uid=job['recipient_id'])
                mutate(client)
                with patch('cabinet_worker.within_window', return_value=True):
                    await self.worker.send_one(self.db, self.connection, client)
                self.assertFalse(client.sent)
                self.assertEqual(await self.job_state(job), {'status': 'failed', 'error_code': 'telegram_source_invalid', 'attempted_at': None})
                self.assertEqual(len(client.requests), 1)

    async def test_source_accepts_an_active_public_alias_without_user_access_hash(self):
        job = await self.source_job()
        client = self.source_client()
        client.channel.username = 'other_public_name'
        client.channel.usernames = [types.Username(username='public_source_test', active=True)]
        self.assertIsNone(client.author.access_hash)
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, client)
        self.assertEqual((await self.job_state(job))['status'], 'sent')
        self.assertEqual(len(client.sent), 1)

    async def test_source_post_and_direct_human_author_must_match_exactly(self):
        cases = (
            ('missing', lambda c: setattr(c.proof, 'messages', [])),
            ('extra_message', lambda c: c.proof.messages.append(c.message)),
            ('empty', lambda c: setattr(c.proof, 'messages', [types.MessageEmpty(id=42, peer_id=types.PeerChannel(111222333))])),
            ('service', lambda c: setattr(c.proof, 'messages', [types.MessageService(id=42,
                peer_id=types.PeerChannel(111222333), date=datetime.now(UTC), action=types.MessageActionEmpty())])),
            ('wrong_message', lambda c: setattr(c.message, 'id', 43)),
            ('wrong_chat', lambda c: setattr(c.message, 'peer_id', types.PeerChannel(999))),
            ('private_message', lambda c: setattr(c.message, 'peer_id', types.PeerUser(self.peer))),
            ('wrong_author', lambda c: setattr(c.message, 'from_id', types.PeerUser(999))),
            ('anonymous', lambda c: setattr(c.message, 'from_id', None)),
            ('channel_author', lambda c: setattr(c.message, 'from_id', types.PeerChannel(111222333))),
            ('forward', lambda c: setattr(c.message, 'fwd_from', types.MessageFwdHeader(date=datetime.now(UTC), from_id=types.PeerUser(c.author.id)))),
            ('no_user', lambda c: setattr(c.proof, 'users', [])),
            ('empty_user', lambda c: setattr(c.proof, 'users', [types.UserEmpty(id=c.author.id)])),
            ('wrong_user', lambda c: setattr(c.author, 'id', 999)),
            ('bot', lambda c: setattr(c.author, 'bot', True)),
            ('deleted', lambda c: setattr(c.author, 'deleted', True)),
        )
        for index, (name, mutate) in enumerate(cases):
            with self.subTest(case=name):
                job = await self.source_job(peer=self.peer + index)
                client = self.source_client(uid=job['recipient_id'])
                mutate(client)
                with patch('cabinet_worker.within_window', return_value=True):
                    await self.worker.send_one(self.db, self.connection, client)
                self.assertFalse(client.sent)
                self.assertEqual(await self.job_state(job), {'status': 'failed', 'error_code': 'telegram_source_invalid', 'attempted_at': None})
                self.assertEqual(len(client.requests), 2)

    async def test_source_read_errors_fail_without_attempt_or_automatic_retry(self):
        cases = (
            ('resolve', errors.UsernameInvalidError(request=None), 'telegram_source_invalid'),
            ('resolve', errors.UsernameNotOccupiedError(request=None), 'telegram_source_invalid'),
            ('proof', errors.ChannelPrivateError(request=None), 'telegram_source_unavailable'),
            ('proof', errors.UserBannedInChannelError(request=None), 'telegram_source_unavailable'),
            ('proof', errors.MsgIdInvalidError(request=None), 'telegram_source_invalid'),
            ('resolve', asyncio.TimeoutError(), 'telegram_source_unavailable'),
            ('proof', asyncio.TimeoutError(), 'telegram_source_unavailable'),
            ('proof', ConnectionError(), 'telegram_source_unavailable'),
        )
        for index, (stage, exception, code) in enumerate(cases):
            with self.subTest(stage=stage, exception=type(exception).__name__):
                job = await self.source_job(peer=self.peer + index)
                client = self.source_client(uid=job['recipient_id'], exception_stage=stage, exception=exception)
                with patch('cabinet_worker.within_window', return_value=True):
                    await self.worker.send_one(self.db, self.connection, client)
                    await self.worker.send_one(self.db, self.connection, client)
                self.assertFalse(client.sent)
                self.assertEqual(await self.job_state(job), {'status': 'failed', 'error_code': code, 'attempted_at': None})
                self.assertEqual(len(client.requests), 1 if stage == 'resolve' else 2)

    async def test_source_proof_flood_wait_pauses_and_cancels_queue_without_attempt(self):
        for index, (stage, exception) in enumerate((
            ('resolve', errors.FloodWaitError(request=None, capture=60)),
            ('proof', errors.FloodWaitError(request=None, capture=60)),
            ('resolve', errors.PeerFloodError(request=None)),
            ('proof', errors.PeerFloodError(request=None)),
        )):
            with self.subTest(stage=stage, exception=type(exception).__name__):
                await self.db.execute('UPDATE cabinet_campaigns SET paused=false WHERE id=%s', (self.campaign,))
                job = await self.source_job(peer=self.peer + index * 2)
                other = await self.job(peer=self.peer + index * 2 + 1)
                client = self.source_client(uid=job['recipient_id'], exception_stage=stage, exception=exception)
                with patch('cabinet_worker.within_window', return_value=True):
                    await self.worker.send_one(self.db, self.connection, client)
                self.assertFalse(client.sent)
                self.assertEqual(await self.job_state(job), {'status': 'failed', 'error_code': 'telegram_rate_limit', 'attempted_at': None})
                self.assertEqual((await self.job_state(other))['status'], 'cancelled')
                campaign = await (await self.db.execute('SELECT paused FROM cabinet_campaigns WHERE id=%s', (self.campaign,))).fetchone()
                self.assertTrue(campaign['paused'])

    async def test_source_proof_rechecks_every_delivery_stop_after_await(self):
        mutations = (
            ('cabinet_campaigns', 'paused', True), ('cabinet_drafts', 'stopped', True),
            ('cabinet_accounts', 'active', False), ('cabinet_connections', 'generation', 2),
            ('cabinet_connections', 'status', 'disconnected'),
            ('cabinet_connections', 'telegram_user_id', 77777),
            ('cabinet_connections', 'expected_username', 'different_sender'),
            ('cabinet_jobs', 'status', 'cancelled'),
        )
        for index, (table, column, value) in enumerate(mutations):
            with self.subTest(changed=column):
                job = await self.source_job(peer=self.peer + index)
                key = {'cabinet_campaigns': self.campaign, 'cabinet_drafts': job['draft_id'],
                       'cabinet_accounts': self.owner, 'cabinet_connections': self.connection['id'],
                       'cabinet_jobs': job['id']}[table]
                original = (await (await self.db.execute(f'SELECT {column} FROM {table} WHERE id=%s', (key,))).fetchone())[column]
                async def mutate(stage):
                    if stage == 'proof':
                        await self.db.execute(f'UPDATE {table} SET {column}=%s WHERE id=%s', (value, key))
                client = self.source_client(uid=job['recipient_id'], callback=mutate)
                with patch('cabinet_worker.within_window', return_value=True):
                    await self.worker.send_one(self.db, self.connection, client)
                self.assertFalse(client.sent)
                self.assertIsNone((await self.job_state(job))['attempted_at'])
                await self.db.execute(f'UPDATE {table} SET {column}=%s WHERE id=%s', (original, key))
                await self.db.execute("UPDATE cabinet_jobs SET status='cancelled' WHERE id=%s", (job['id'],))

    async def test_source_proof_rechecks_quota_and_spacing_after_await(self):
        job = await self.source_job()
        async def fill_quota(stage):
            if stage == 'proof':
                await self.seed_attempts(10)
        client = self.source_client(callback=fill_quota)
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        self.assertIsNone((await self.job_state(job))['attempted_at'])
        # Quota is available again, but a new account-wide attempt is too recent.
        await self.db.execute('UPDATE cabinet_campaigns SET daily_limit=20 WHERE id=%s', (self.campaign,))
        async def recent_attempt(stage):
            if stage == 'proof':
                await self.db.execute("UPDATE cabinet_jobs SET attempted_at=now() WHERE owner_id=%s AND status='failed'", (self.owner,))
        client = self.source_client(callback=recent_attempt)
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        self.assertIsNone((await self.job_state(job))['attempted_at'])

    async def test_source_one_off_expiry_during_proof_cancels_without_attempt(self):
        job = await self.source_job()
        await self.grant(job)
        instant = (await (await self.db.execute('SELECT now() at')).fetchone())['at']
        class ClockMeta(type):
            def __instancecheck__(cls, instance): return isinstance(instance, datetime)
        class Clock(datetime, metaclass=ClockMeta):
            at = instant
            @classmethod
            def now(cls, tz=None): return cls.at.astimezone(tz) if tz else cls.at.replace(tzinfo=None)
        async def expire(stage):
            if stage == 'proof': Clock.at += timedelta(days=1)
        client = self.source_client(callback=expire)
        with patch('cabinet_worker.datetime', Clock):
            await self.worker.send_one(self.db, self.connection, client)
        self.assertFalse(client.sent)
        self.assertEqual(await self.job_state(job), {'status': 'cancelled', 'error_code': 'one_off_window_expired', 'attempted_at': None})

    async def test_source_send_uncertainty_is_not_retried_and_pauses_remaining_jobs(self):
        job = await self.source_job()
        other = await self.job(peer=self.peer + 1)
        client = self.source_client(exception_stage='send', exception=asyncio.TimeoutError())
        with patch('cabinet_worker.within_window', return_value=True):
            await self.worker.send_one(self.db, self.connection, client)
            await self.worker.send_one(self.db, self.connection, client)
        self.assertEqual(len(client.sent), 1)
        state = await self.job_state(job)
        self.assertEqual((state['status'], state['error_code']), ('uncertain', 'telegram_delivery_uncertain'))
        self.assertIsNotNone(state['attempted_at'])
        self.assertEqual((await self.job_state(other))['status'], 'cancelled')

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
