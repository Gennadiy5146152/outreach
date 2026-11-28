"""Isolated cabinet Telegram worker. Never exposes sessions or general chat history."""
import asyncio
import base64
import hashlib
import io
import logging
import os
import re
import signal
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
import qrcode
import qrcode.image.svg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from telethon import TelegramClient, events, errors, functions, types
from telethon.sessions import SQLiteSession
from cabinet_media import MediaArchive, enqueue_message, rpc_allowed

logging.getLogger("telethon").setLevel(logging.CRITICAL)
MSK = timezone(timedelta(hours=3))
UTC = timezone.utc


class RecoverySession(SQLiteSession):
    """Reuse the server session without consuming the live worker's update cursor."""

    def set_update_state(self, entity_id, state):
        # Telethon connect/disconnect may save the current server pts even when
        # receive_updates=False. The live worker must retain its previous pts.
        pass


def private_session_path(root, connection_id, generation):
    # Only worker-generated paths. No user-provided file paths or exported strings.
    return Path(root) / f"{UUID(str(connection_id))}-{int(generation)}.session"


def decrypt_password(ciphertext, secret):
    if len(secret) < 32:
        raise ValueError("cabinet_secret_not_configured")
    data = base64.b64decode(ciphertext, validate=True)
    return AESGCM(hashlib.sha256(secret.encode()).digest()).decrypt(data[:12], data[12:], None).decode()


def svg_for(url):
    qr = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=5, border=4)
    out = io.BytesIO()
    qr.save(out)
    return out.getvalue().decode()


def reply_parent(event):
    """Extract only a local private-chat reply reference."""
    if not event.is_private or event.message.out or not event.sender_id or event.sender_id <= 0:
        return None
    header = event.message.reply_to
    if not header or getattr(header, "reply_to_peer_id", None):
        return None
    return getattr(header, "reply_to_msg_id", None)


def one_off_state(job, at):
    day, start, end, limit = (job.get(key) for key in (
        "one_off_day", "one_off_window_start", "one_off_window_end", "one_off_daily_limit"))
    if all(value is None for value in (day, start, end, limit)):
        return None
    scheduled = job.get("scheduled_at")
    if (type(day) is not date or type(start) is not time or type(end) is not time
            or start.tzinfo is not None or end.tzinfo is not None or start >= end
            or type(limit) is not int or not 1 <= limit <= 100
            or not isinstance(scheduled, datetime) or scheduled.utcoffset() is None):
        return "invalid"
    scheduled = scheduled.astimezone(MSK)
    if scheduled.date() != day or not start <= scheduled.time() < end:
        return "invalid"
    local = at.astimezone(MSK)
    if local.date() > day or (local.date() == day and local.time() >= end):
        return "expired"
    if local.date() != day or local.time() < start:
        return "waiting"
    return "active"


def within_window(job, at):
    one_off = one_off_state(job, at)
    if one_off is not None:
        return one_off == "active"
    local = at.astimezone(MSK)
    return local.weekday() < 5 and job["window_start"] <= local.time() < job["window_end"]


def message_id_from_result(result, random_id):
    if isinstance(result, types.UpdateShortSentMessage):
        return result.id
    for update in getattr(result, "updates", []):
        if isinstance(update, types.UpdateMessageID) and update.random_id == random_id:
            return update.id
    return None


def message_date_from_result(result, message_id):
    candidates = [result] if isinstance(result, types.UpdateShortSentMessage) else [
        getattr(update, 'message', None) for update in getattr(result, 'updates', [])]
    for message in candidates:
        value = getattr(message, 'date', None)
        if (getattr(message, 'id', None) == message_id and isinstance(value, datetime)
                and value.utcoffset() is not None):
            return value, 'telegram'
    return datetime.now(UTC), 'service_receipt'


class CabinetWorker:
    def __init__(self):
        self.url = os.environ["DATABASE_URL"]
        self.api_id = int(os.environ["CABINET_TELEGRAM_API_ID"])
        self.api_hash = os.environ["CABINET_TELEGRAM_API_HASH"]
        self.secret = os.environ.get("CABINET_SECRET", "")
        self.enabled = os.environ.get("CABINET_TELEGRAM_SEND_ENABLED", "false").lower() == "true"
        self.root = Path(os.environ.get("CABINET_SESSION_DIR", "/var/lib/cabinet-telegram"))
        self.tasks = {}
        self.stopping = asyncio.Event()

    async def db(self):
        return await psycopg.AsyncConnection.connect(self.url, autocommit=True, row_factory=dict_row, connect_timeout=8)

    def client(self, path, catch_up=False, receive_updates=True):
        session = str(path) if receive_updates else RecoverySession(str(path))
        return TelegramClient(session, self.api_id, self.api_hash, catch_up=catch_up,
                              receive_updates=receive_updates, sequential_updates=True,
                              connection_retries=1, request_retries=0, flood_sleep_threshold=0)

    @asynccontextmanager
    async def delivery_lock(self, db, owner_id, connection_id):
        await db.execute("SELECT pg_advisory_lock_shared(hashtext('outreach_delivery_control'))")
        try:
            await db.execute("SELECT pg_advisory_lock(hashtext(%s))", ("cabinet:" + str(owner_id),))
            try:
                # Incoming events can arrive before SendMessage returns. Let them wait
                # for the receipt rather than discard them or attach to an older job.
                await db.execute("SELECT pg_advisory_lock(hashtext(%s))", ("cabinet-replies:" + str(connection_id),))
                try:
                    yield
                finally:
                    await db.execute("SELECT pg_advisory_unlock(hashtext(%s))", ("cabinet-replies:" + str(connection_id),))
            finally:
                await db.execute("SELECT pg_advisory_unlock(hashtext(%s))", ("cabinet:" + str(owner_id),))
        finally:
            await db.execute("SELECT pg_advisory_unlock_shared(hashtext('outreach_delivery_control'))")

    async def state(self, db, row):
        return await (await db.execute("""SELECT c.*,a.active FROM cabinet_connections c
            JOIN cabinet_accounts a ON a.id=c.owner_id WHERE c.id=%s""", (row["id"],))).fetchone()

    async def update(self, db, row, status, **fields):
        allowed = {"qr_svg", "qr_expires_at", "password_cipher", "error_code", "heartbeat_at", "username", "telegram_user_id"}
        assert not set(fields) - allowed
        values = {"status": status, **fields}
        columns = ",".join(f"{key}=%s" for key in values)
        result = await db.execute(f"UPDATE cabinet_connections SET {columns} WHERE id=%s AND generation=%s AND status<>'disconnected'",
                                  (*values.values(), row["id"], row["generation"]))
        return result.rowcount > 0

    async def identity(self, db, row, client):
        me = await client.get_me()
        if (not me or getattr(me, 'bot', False) or (me.username or "").lower() != row["expected_username"]
                or row.get("telegram_user_id") not in (None, me.id)):
            await client.log_out()
            await self.update(db, row, "error", error_code="telegram_identity_mismatch", qr_svg=None, password_cipher=None)
            return False
        # A private cabinet cannot re-use an already managed legacy sender.
        conflict = await (await db.execute("""SELECT 1 FROM outreach_telegram_profiles
            WHERE telegram_user_id=%s OR (lower(sender)=%s AND connection_status='connected') LIMIT 1""", (me.id,row["expected_username"]))).fetchone()
        if conflict:
            await client.log_out()
            await self.update(db, row, "error", error_code="telegram_account_already_managed", qr_svg=None, password_cipher=None)
            return False
        try:
            return await self.update(db, row, "connected", telegram_user_id=me.id, username=me.username.lower(),
                                     qr_svg=None, qr_expires_at=None, password_cipher=None, error_code=None, heartbeat_at=datetime.now(UTC))
        except (psycopg.errors.UniqueViolation, psycopg.errors.CheckViolation):
            await client.log_out()
            await self.update(db, row, "error", error_code="telegram_account_already_managed", qr_svg=None, password_cipher=None)
            return False

    async def qr_login(self, db, row, client):
        # Persisted authorization is checked first; generation changes use a fresh file.
        if await client.is_user_authorized():
            return await self.identity(db, row, client)
        qr = await client.qr_login()
        # Telethon's waiter must be running before the QR is shown to the user.
        waiter = asyncio.create_task(qr.wait(timeout=90))
        await asyncio.sleep(0)
        try:
            if not await self.update(db, row, "qr_ready", qr_svg=svg_for(qr.url), qr_expires_at=qr.expires, error_code=None):
                return False
            try:
                await waiter
            except errors.SessionPasswordNeededError:
                await self.update(db, row, "password_required", qr_svg=None, qr_expires_at=None)
                deadline = datetime.now(UTC) + timedelta(minutes=5)
                while datetime.now(UTC) < deadline:
                    current = await self.state(db, row)
                    if not current or not current["active"] or current["generation"] != row["generation"] or current["status"] != "password_required":
                        return False
                    if current["password_cipher"]:
                        # Clear before decrypting/signing in; password never reaches logs.
                        await db.execute("UPDATE cabinet_connections SET password_cipher=NULL WHERE id=%s AND generation=%s", (row["id"], row["generation"]))
                        password = decrypt_password(current["password_cipher"], self.secret)
                        try:
                            await client.sign_in(password=password)
                            break
                        except errors.PasswordHashInvalidError:
                            await self.update(db, row, "password_required", error_code="telegram_password_invalid")
                        finally:
                            password = None
                    await asyncio.sleep(2)
                else:
                    await self.update(db, row, "expired", qr_svg=None, password_cipher=None, error_code="telegram_login_expired")
                    return False
            return await self.identity(db, row, client)
        except asyncio.TimeoutError:
            await self.update(db, row, "expired", qr_svg=None, qr_expires_at=None, password_cipher=None, error_code="telegram_qr_expired")
            return False
        finally:
            if not waiter.done():
                waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)

    async def incoming(self, row, event, allowed_job_ids=None):
        """Record only correspondence after a verified delivery to this exact peer."""
        message = event.message
        if not event.is_private or not isinstance(message, types.Message):
            return False
        peer = getattr(message.peer_id, 'user_id', None)
        if (type(peer) is not int or peer <= 0 or type(message.id) is not int or message.id <= 0
                or not isinstance(message.date, datetime) or message.date.utcoffset() is None
                or (not message.out and (event.sender_id != peer
                    or (message.from_id is not None and getattr(message.from_id, 'user_id', None) != peer)))):
            return False
        header = message.reply_to
        if header and (getattr(header, 'reply_to_peer_id', None) or not header.reply_to_msg_id):
            return False
        parent = header.reply_to_msg_id if header else None
        direction = 'outbound' if message.out else 'inbound'
        async with await self.db() as db:
            async with db.transaction():
                await db.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("cabinet-replies:" + str(row["id"]),))
                # Telegram timestamps have second precision; delivery receipts use DB microseconds.
                # A reply ID must still be strictly later than the service message ID.
                job = await (await db.execute("""SELECT j.id,j.owner_id,j.connection_id,j.recipient_id
                    FROM cabinet_jobs j JOIN cabinet_connections c ON c.id=j.connection_id AND c.owner_id=j.owner_id
                    JOIN cabinet_accounts a ON a.id=c.owner_id
                    JOIN cabinet_messages anchor ON anchor.job_id=j.id AND anchor.owner_id=j.owner_id
                        AND anchor.connection_id=j.connection_id AND anchor.recipient_id=j.recipient_id
                        AND anchor.telegram_message_id=j.telegram_message_id AND anchor.direction='outbound'
                    WHERE c.id=%s AND c.owner_id=%s AND c.generation=%s AND c.status='connected' AND a.active
                      AND j.status='sent' AND j.recipient_id=%s AND anchor.telegram_message_id<%s
                      AND date_trunc('second',COALESCE(j.attempted_at,anchor.sent_at))<=%s
                      AND (%s::bigint IS NULL OR EXISTS (
                          SELECT 1 FROM cabinet_messages p WHERE p.job_id=j.id AND p.owner_id=j.owner_id
                            AND p.connection_id=j.connection_id AND p.recipient_id=j.recipient_id
                            AND p.telegram_message_id=%s AND p.telegram_message_id<%s
                            AND date_trunc('second',CASE WHEN p.telegram_message_id=j.telegram_message_id
                                THEN COALESCE(j.attempted_at,p.sent_at) ELSE p.sent_at END)<=%s))
                      AND (%s=false OR NOT EXISTS (
                          SELECT 1 FROM cabinet_jobs sending WHERE sending.connection_id=j.connection_id
                            AND sending.recipient_id=j.recipient_id AND sending.status IN ('sending','uncertain')))
                    ORDER BY anchor.telegram_message_id DESC,anchor.sent_at DESC,j.id DESC LIMIT 1
                    FOR SHARE OF c,a""",
                    (row['id'], row['owner_id'], row['generation'], peer, message.id, message.date,
                     parent, parent, message.id, message.date, bool(message.out)))).fetchone()
                if not job or (allowed_job_ids is not None and job['id'] not in allowed_job_ids):
                    return False
                saved = await db.execute("""INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,
                    telegram_message_id,reply_to_message_id,direction,body,sent_at,timestamp_source)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'telegram')
                    ON CONFLICT(connection_id,telegram_message_id) DO NOTHING""",
                    (job['owner_id'], job['id'], job['connection_id'], peer, message.id, parent,
                     direction, (message.message or '')[:16000], message.date))
                await enqueue_message(db, job, message)
                return saved.rowcount == 1

    async def recover_messages(self, row, client, job_ids, since, until, *, max_messages=1000):
        """Server-only, explicit sent-job recovery. Caller must hold the connection lock."""
        if (not isinstance(since, datetime) or not isinstance(until, datetime)
                or since.utcoffset() is None or until.utcoffset() is None
                or not timedelta(0) < until-since <= timedelta(days=1)
                or until > datetime.now(UTC)+timedelta(seconds=1)
                or not 1 <= len(job_ids) <= 100 or len(set(job_ids)) != len(job_ids)
                or type(max_messages) is not int or not 1 <= max_messages <= 2000):
            raise ValueError('recovery_bounds_invalid')
        job_ids = [UUID(str(value)) for value in job_ids]
        async with await self.db() as db:
            jobs = await (await db.execute("""SELECT j.*,COALESCE(j.attempted_at,m.sent_at) AS anchor_at
                FROM cabinet_jobs j JOIN cabinet_connections c ON c.id=j.connection_id AND c.owner_id=j.owner_id
                JOIN cabinet_accounts a ON a.id=c.owner_id
                JOIN cabinet_messages m ON m.job_id=j.id AND m.connection_id=j.connection_id
                    AND m.owner_id=j.owner_id AND m.recipient_id=j.recipient_id
                    AND m.telegram_message_id=j.telegram_message_id AND m.direction='outbound'
                WHERE c.id=%s AND c.owner_id=%s AND c.generation=%s AND c.status='connected' AND a.active
                  AND j.status='sent' AND j.id=ANY(%s) AND m.sent_at<%s
                ORDER BY m.telegram_message_id,j.id""",
                (row['id'], row['owner_id'], row['generation'], job_ids, until))).fetchall()
        if len(jobs) != len(job_ids):
            raise ValueError('recovery_jobs_invalid')
        identity = await client.get_me()
        if (not identity or identity.bot or identity.id != row.get('telegram_user_id')
                or (identity.username or '').lower() != row['expected_username'].lower()):
            raise ValueError('recovery_identity_mismatch')
        peers = {}
        for job in jobs:
            peers.setdefault(job['recipient_id'], job)
        saved, fetched = 0, 0
        for uid, job in peers.items():
            try:
                peer = await client.get_input_entity(types.PeerUser(uid))
            except ValueError:
                if job.get('recipient_source') is not None:
                    peer = await self.source_peer(job, client)
                else:
                    peer = await client.get_input_entity(job['address'].rsplit('/',1)[-1])
            if not isinstance(peer, (types.InputPeerUser, types.InputPeerUserFromMessage)) or peer.user_id != uid:
                raise ValueError('recovery_recipient_mismatch')
            messages = []
            floor = max(since, job['anchor_at'].replace(microsecond=0))
            previous = job['telegram_message_id']
            count = 0
            # Telethon emulates min_id locally because Telegram may return an empty
            # page for a wire min_id. Reverse iteration starts immediately after the
            # approved anchor and correctly follows short MessagesSlice pages.
            async for message in client.iter_messages(peer, min_id=job['telegram_message_id'],
                                                       reverse=True, limit=max_messages+1, wait_time=0):
                fetched += 1
                count += 1
                if count > max_messages:
                    raise ValueError('recovery_incomplete')
                if message.id <= previous:
                    raise ValueError('recovery_page_invalid')
                previous = message.id
                if getattr(message.peer_id, 'user_id', None) != uid:
                    raise ValueError('recovery_peer_mismatch')
                if message.date.utcoffset() is None:
                    raise ValueError('recovery_date_invalid')
                if message.date >= until:
                    break
                if message.date >= floor and isinstance(message, types.Message):
                    messages.append(message)
            # Parents must exist before their explicit replies, including across history pages.
            for message in sorted(messages, key=lambda m:m.id):
                saved += bool(await self.incoming(row, events.NewMessage.Event(message), set(job_ids)))
            await asyncio.sleep(0.25)
        return {'complete': True, 'jobs': len(jobs), 'peers': len(peers), 'fetched': fetched, 'inserted': saved}

    async def pause(self, db, row, code):
        await db.execute("UPDATE cabinet_campaigns SET paused=true,revision=revision+1 WHERE connection_id=%s", (row["id"],))
        await db.execute("UPDATE cabinet_jobs SET status='cancelled',error_code=%s WHERE connection_id=%s AND status='queued'", (code, row["id"]))
        await self.update(db, row, "connected", error_code=code)

    async def check_delivery_window(self, db, job):
        at = datetime.now(UTC)
        one_off = one_off_state(job, at)
        if one_off in ("expired", "invalid"):
            code = "one_off_window_expired" if one_off == "expired" else "one_off_invalid"
            await db.execute("UPDATE cabinet_jobs SET status='cancelled',error_code=%s,completed_at=now() WHERE id=%s AND status='queued'",
                             (code, job["id"]))
            return False
        return within_window(job, at)

    async def pending_job(self, db, row, job_id=None):
        condition = " AND j.id=%s" if job_id is not None else ""
        args = (row["id"], row["generation"]) + ((job_id,) if job_id is not None else ())
        return await (await db.execute(f"""SELECT j.*,c.window_start,c.window_end,c.daily_limit,
                t.telegram_user_id AS sender_user_id,t.expected_username AS sender_expected_username,
                t.username AS sender_username
            FROM cabinet_jobs j JOIN cabinet_campaigns c ON c.id=j.campaign_id
            JOIN cabinet_connections t ON t.id=j.connection_id JOIN cabinet_accounts a ON a.id=j.owner_id
            JOIN cabinet_drafts d ON d.id=j.draft_id
            WHERE j.connection_id=%s AND t.generation=%s AND t.status='connected' AND a.active
              AND NOT c.paused AND NOT d.stopped AND j.status='queued' AND j.scheduled_at<=now(){condition}
            ORDER BY j.scheduled_at,j.id LIMIT 1""", args)).fetchone()

    async def quota_available(self, db, row, job):
        usage = await (await db.execute("""SELECT count(*) n,max(attempted_at) last_at FROM cabinet_jobs
            WHERE connection_id=%s AND attempted_at >= (date_trunc('day',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')""", (row["id"],))).fetchone()
        daily_limit = job["daily_limit"]
        if job.get("one_off_day") is not None:
            daily_limit = min(job["one_off_daily_limit"], daily_limit + 2, 100)
        return usage["n"] < daily_limit and (not usage["last_at"] or datetime.now(UTC) - usage["last_at"] >= timedelta(minutes=3))

    async def source_peer(self, job, client):
        source = job.get("recipient_source")
        uid = job["recipient_id"]
        if (type(source) is not dict or set(source) != {"chat_id", "username", "message_id"}
                or type(uid) is not int or not 1 <= uid <= 9223372036854775807
                or job["address"] != f"tg://user?id={uid}"):
            raise ValueError("telegram_source_invalid")
        chat_id, username, mid = source["chat_id"], source["username"], source["message_id"]
        if (type(chat_id) is not str or not re.fullmatch(r"[1-9][0-9]{0,18}", chat_id)
                or int(chat_id) > 9223372036854775807
                or type(username) is not str or not re.fullmatch(r"[a-z][a-z0-9_]{4,31}", username)
                or type(mid) is not int or not 1 <= mid <= 2147483647):
            raise ValueError("telegram_source_invalid")
        chat_id = int(chat_id)
        # Resolve freshly: get_input_entity(username) can return a stale cached owner.
        resolved = await client(functions.contacts.ResolveUsernameRequest(username))
        if not isinstance(resolved.peer, types.PeerChannel) or resolved.peer.channel_id != chat_id:
            raise ValueError("telegram_source_invalid")
        channels = [chat for chat in resolved.chats if isinstance(chat, types.Channel) and chat.id == chat_id]
        if len(channels) != 1:
            raise ValueError("telegram_source_invalid")
        channel = channels[0]
        public_names = {channel.username.lower()} if channel.username else set()
        public_names.update(alias.username.lower() for alias in (channel.usernames or []) if alias.active)
        if (not channel.megagroup or channel.broadcast or channel.min or channel.access_hash is None
                or username not in public_names):
            raise ValueError("telegram_source_invalid")
        public_peer = types.InputPeerChannel(chat_id, channel.access_hash)
        proof = await client(functions.channels.GetMessagesRequest(
            channel=types.InputChannel(chat_id, channel.access_hash), id=[types.InputMessageID(mid)]))
        if len(proof.messages) != 1:
            raise ValueError("telegram_source_invalid")
        message = proof.messages[0]
        if (not isinstance(message, types.Message) or message.id != mid
                or not isinstance(message.peer_id, types.PeerChannel) or message.peer_id.channel_id != chat_id
                or not isinstance(message.from_id, types.PeerUser) or message.from_id.user_id != uid
                or message.fwd_from is not None):
            raise ValueError("telegram_source_invalid")
        authors = [user for user in proof.users if isinstance(user, types.User) and user.id == uid]
        if len(authors) != 1 or authors[0].bot or authors[0].deleted:
            raise ValueError("telegram_source_invalid")
        return types.InputPeerUserFromMessage(public_peer, mid, uid)

    async def fail_queued_job(self, db, job, code):
        await db.execute("UPDATE cabinet_jobs SET status='failed',error_code=%s,completed_at=now() WHERE id=%s AND status='queued'",
                         (code, job["id"]))

    async def send_one(self, db, row, client):
        if not self.enabled or not await rpc_allowed(db,row['id']):
            return
        async with self.delivery_lock(db, row["owner_id"], row['id']):
            # Expiry also releases paused/stopped jobs, which the delivery query excludes.
            local = datetime.now(UTC).astimezone(MSK)
            await db.execute("""UPDATE cabinet_jobs SET status='cancelled',error_code='one_off_window_expired',completed_at=now()
                WHERE connection_id=%s AND status='queued' AND one_off_day IS NOT NULL
                  AND (one_off_day<%s OR (one_off_day=%s AND one_off_window_end<=%s))""",
                (row["id"], local.date(), local.date(), local.time()))
            job = await self.pending_job(db, row)
            if not job or not await self.check_delivery_window(db, job):
                return
            if not await self.quota_available(db, row, job):
                return
            has_source = job.get("recipient_source") is not None
            try:
                if has_source:
                    peer = await asyncio.wait_for(self.source_peer(job, client), timeout=20)
                else:
                    # Username reassignment must never redirect a scheduled message.
                    peer = await asyncio.wait_for(client.get_input_entity(job["address"].rsplit('/', 1)[-1]), timeout=20)
                    if not isinstance(peer, types.InputPeerUser) or peer.user_id != job["recipient_id"]:
                        raise ValueError("telegram_recipient_changed")
            except (errors.FloodWaitError, errors.PeerFloodError):
                await self.fail_queued_job(db, job, "telegram_rate_limit")
                await self.pause(db, row, "telegram_rate_limit")
                return
            except (ValueError, errors.UsernameInvalidError, errors.UsernameNotOccupiedError, errors.MsgIdInvalidError, errors.ChannelInvalidError):
                await self.fail_queued_job(db, job, "telegram_source_invalid" if has_source else "telegram_recipient_changed")
                return
            except (asyncio.TimeoutError, OSError, errors.RPCError):
                if not has_source:
                    raise
                await self.fail_queued_job(db, job, "telegram_source_unavailable")
                return
            # The proof awaits network RPCs. Re-read all delivery controls before attempting.
            current = await self.pending_job(db, row, job["id"])
            bound = ("address", "recipient_id", "recipient_source", "body", "random_id",
                     "sender_user_id", "sender_expected_username", "sender_username")
            if not self.enabled or not current or any(current.get(key) != job.get(key) for key in bound):
                return
            job = current
            if not await self.check_delivery_window(db, job) or not await self.quota_available(db, row, job):
                return
            if not await rpc_allowed(db,row['id']):
                return
            # Commit attempt before the RPC. Restart/timeout never blindly re-sends it.
            attempt = await db.execute("UPDATE cabinet_jobs SET status='sending',attempted_at=now() WHERE id=%s AND status='queued'", (job["id"],))
            if attempt.rowcount != 1:
                return
            try:
                result = await asyncio.wait_for(client(functions.messages.SendMessageRequest(
                    peer=peer, message=job["body"], random_id=job["random_id"], no_webpage=True)), timeout=35)
                message_id = message_id_from_result(result, job["random_id"])
                if not message_id:
                    raise RuntimeError("telegram_delivery_uncertain")
                sent_at, timestamp_source = message_date_from_result(result, message_id)
                async with db.transaction():
                    await db.execute("UPDATE cabinet_jobs SET status='sent',completed_at=now(),telegram_message_id=%s WHERE id=%s AND status='sending'", (message_id, job["id"]))
                    await db.execute("""INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,
                        telegram_message_id,direction,body,sent_at,timestamp_source,media_checked_at)
                        VALUES(%s,%s,%s,%s,%s,'outbound',%s,%s,%s,now())
                        ON CONFLICT(connection_id,telegram_message_id) DO NOTHING""",
                        (row["owner_id"], job["id"], row["id"], job["recipient_id"], message_id, job["body"],sent_at,timestamp_source))
            except (errors.FloodWaitError, errors.PeerFloodError):
                await db.execute("UPDATE cabinet_jobs SET status='failed',error_code='telegram_rate_limit',completed_at=now() WHERE id=%s", (job["id"],))
                await self.pause(db, row, "telegram_rate_limit")
            except (errors.UserPrivacyRestrictedError, errors.UserIsBlockedError, errors.ChatWriteForbiddenError):
                await db.execute("UPDATE cabinet_jobs SET status='failed',error_code='telegram_recipient_unavailable',completed_at=now() WHERE id=%s", (job["id"],))
            except Exception:
                await db.execute("UPDATE cabinet_jobs SET status='uncertain',error_code='telegram_delivery_uncertain',completed_at=now() WHERE id=%s", (job["id"],))
                await self.pause(db, row, "telegram_delivery_uncertain")

    async def connection(self, row):
        client, media_task = None, None
        async with await self.db() as db:
            locked = await (await db.execute("SELECT pg_try_advisory_lock(hashtext(%s)) locked", ("cabinet-connection:" + str(row["id"]),))).fetchone()
            if not locked["locked"]:
                return
            try:
                await db.execute("UPDATE cabinet_jobs SET status='uncertain',error_code='worker_restarted',completed_at=now() WHERE connection_id=%s AND status='sending'", (row["id"],))
                path = private_session_path(self.root, row["id"], row["generation"])
                # Old generations are revoked on Telegram as well as deleted locally.
                for old in self.root.glob(f"{row['id']}-*.session"):
                    if old != path:
                        previous = self.client(old)
                        try:
                            await asyncio.wait_for(previous.connect(), 20)
                            if await previous.is_user_authorized():
                                await previous.log_out()
                        finally:
                            await previous.disconnect()
                        old.unlink(missing_ok=True)
                if row["status"] == "disconnected" or not row["active"]:
                    if path.exists():
                        previous = self.client(path)
                        try:
                            await asyncio.wait_for(previous.connect(), 20)
                            if await previous.is_user_authorized():
                                await previous.log_out()
                        finally:
                            await previous.disconnect()
                        path.unlink(missing_ok=True)
                    return
                client = self.client(path, catch_up=True)
                client.add_event_handler(lambda event: self.incoming(row, event), events.NewMessage())
                await asyncio.wait_for(client.connect(), 20)
                if row["status"] == "connected":
                    if not await client.is_user_authorized():
                        await self.update(db, row, "error", error_code="telegram_authorization_lost")
                        return
                    if not await self.identity(db, row, client):
                        return
                elif not await self.qr_login(db, row, client):
                    return
                # Recover scoped correspondence from Telegram's update state, without inbox/history scans.
                await client.catch_up()
                media_task = asyncio.create_task(MediaArchive(self).run(row,client))
                while not self.stopping.is_set():
                    current = await self.state(db, row)
                    if not current or not current["active"] or current["generation"] != row["generation"] or current["status"] != "connected":
                        break
                    await self.update(db, row, "connected", heartbeat_at=datetime.now(UTC))
                    await self.send_one(db, row, client)
                    await asyncio.sleep(2)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never log exception text: Telegram errors can contain identifiers and RPC parameters.
                await self.update(db, row, "error", qr_svg=None, password_cipher=None, error_code="telegram_connection_failed")
            finally:
                if media_task is not None:
                    media_task.cancel()
                    await asyncio.gather(media_task,return_exceptions=True)
                if client:
                    await client.disconnect()
                await db.execute("SELECT pg_advisory_unlock(hashtext(%s))", ("cabinet-connection:" + str(row["id"]),))

    async def run(self):
        os.umask(0o077)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.stopping.set)
        try:
            while not self.stopping.is_set():
                try:
                    async with await self.db() as db:
                        rows = await (await db.execute("SELECT c.*,a.active FROM cabinet_connections c JOIN cabinet_accounts a ON a.id=c.owner_id")).fetchall()
                    for row in rows:
                        key = str(row["id"])
                        active = row["active"] and row["status"] in ("pending_qr", "qr_ready", "password_required", "connected")
                        cleanup = any(self.root.glob(f"{row['id']}-*.session")) and (not row["active"] or row["status"] == "disconnected")
                        if key in self.tasks and (self.tasks[key].cabinet_generation != row["generation"] or not row["active"]):
                            self.tasks[key].cancel()
                            await asyncio.gather(self.tasks[key], return_exceptions=True)
                        if key in self.tasks and self.tasks[key].done():
                            self.tasks[key].exception() if not self.tasks[key].cancelled() else None
                            del self.tasks[key]
                        if (active or cleanup) and key not in self.tasks:
                            self.tasks[key] = asyncio.create_task(self.connection(row))
                            self.tasks[key].cabinet_generation = row["generation"]
                except Exception:
                    print("cabinet_worker_database_unavailable", flush=True)
                try:
                    await asyncio.wait_for(self.stopping.wait(), timeout=3)
                except asyncio.TimeoutError:
                    pass
        finally:
            for task in self.tasks.values():
                task.cancel()
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(CabinetWorker().run())
