"""Isolated cabinet Telegram worker. Never exposes sessions or general chat history."""
import asyncio
import base64
import hashlib
import io
import logging
import os
import signal
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
import qrcode
import qrcode.image.svg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from telethon import TelegramClient, events, errors, functions, types

logging.getLogger("telethon").setLevel(logging.CRITICAL)
MSK = timezone(timedelta(hours=3))
UTC = timezone.utc


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
    """Unthreaded messages, groups, channels and forwarded context are never imported."""
    if not event.is_private or not event.incoming or not event.sender_id or event.sender_id <= 0:
        return None
    header = event.message.reply_to
    if not header or getattr(header, "reply_to_peer_id", None):
        return None
    return getattr(header, "reply_to_msg_id", None)


def within_window(job, at):
    local = at.astimezone(MSK)
    return local.weekday() < 5 and job["window_start"] <= local.time() < job["window_end"]


def message_id_from_result(result, random_id):
    if isinstance(result, types.UpdateShortSentMessage):
        return result.id
    for update in getattr(result, "updates", []):
        if isinstance(update, types.UpdateMessageID) and update.random_id == random_id:
            return update.id
    return None


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

    def client(self, path, catch_up=False):
        return TelegramClient(str(path), self.api_id, self.api_hash, catch_up=catch_up,
                              connection_retries=1, request_retries=0, flood_sleep_threshold=0)

    @asynccontextmanager
    async def delivery_lock(self, db, owner_id):
        await db.execute("SELECT pg_advisory_lock_shared(hashtext('outreach_delivery_control'))")
        try:
            await db.execute("SELECT pg_advisory_lock(hashtext(%s))", ("cabinet:" + str(owner_id),))
            try:
                yield
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
        if not me or (me.username or "").lower() != row["expected_username"]:
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

    async def incoming(self, row, event):
        parent = reply_parent(event)
        if not parent:
            return
        # No get_history, get_dialogs, contact export, media download or personal-chat endpoint.
        async with await self.db() as db:
            async with db.transaction():
                await db.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("cabinet-replies:" + str(row["id"]),))
                await db.execute("""INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,
                    telegram_message_id,reply_to_message_id,direction,body,sent_at)
                    SELECT m.owner_id,m.job_id,m.connection_id,m.recipient_id,%s,%s,'inbound',%s,%s
                    FROM cabinet_messages m JOIN cabinet_connections c ON c.id=m.connection_id
                    JOIN cabinet_accounts a ON a.id=c.owner_id
                    WHERE c.id=%s AND c.generation=%s AND c.status='connected' AND a.active
                      AND m.recipient_id=%s AND m.telegram_message_id=%s
                    ON CONFLICT(connection_id,telegram_message_id) DO NOTHING""",
                    (event.message.id, parent, (event.message.message or "")[:16000], event.message.date,
                     row["id"], row["generation"], event.sender_id, parent))

    async def pause(self, db, row, code):
        await db.execute("UPDATE cabinet_campaigns SET paused=true,revision=revision+1 WHERE connection_id=%s", (row["id"],))
        await db.execute("UPDATE cabinet_jobs SET status='cancelled',error_code=%s WHERE connection_id=%s AND status='queued'", (code, row["id"]))
        await self.update(db, row, "connected", error_code=code)

    async def send_one(self, db, row, client):
        if not self.enabled:
            return
        async with self.delivery_lock(db, row["owner_id"]):
            job = await (await db.execute("""SELECT j.*,c.window_start,c.window_end,c.daily_limit
                FROM cabinet_jobs j JOIN cabinet_campaigns c ON c.id=j.campaign_id
                JOIN cabinet_connections t ON t.id=j.connection_id JOIN cabinet_accounts a ON a.id=j.owner_id
                JOIN cabinet_drafts d ON d.id=j.draft_id
                WHERE j.connection_id=%s AND t.generation=%s AND t.status='connected' AND a.active
                  AND NOT c.paused AND NOT d.stopped AND j.status='queued' AND j.scheduled_at<=now()
                ORDER BY j.scheduled_at,j.id LIMIT 1""", (row["id"], row["generation"]))).fetchone()
            if not job or not within_window(job, datetime.now(UTC)):
                return
            usage = await (await db.execute("""SELECT count(*) n,max(attempted_at) last_at FROM cabinet_jobs
                WHERE connection_id=%s AND attempted_at >= (date_trunc('day',now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')""", (row["id"],))).fetchone()
            if usage["n"] >= job["daily_limit"] or (usage["last_at"] and datetime.now(UTC) - usage["last_at"] < timedelta(minutes=3)):
                return
            # Username reassignment must never redirect a scheduled message to another person.
            try:
                peer = await asyncio.wait_for(client.get_input_entity(job["address"].rsplit('/', 1)[-1]), timeout=20)
                if not isinstance(peer, types.InputPeerUser) or peer.user_id != job["recipient_id"]:
                    raise ValueError("telegram_recipient_changed")
            except (ValueError, errors.UsernameInvalidError, errors.UsernameNotOccupiedError):
                await db.execute("UPDATE cabinet_jobs SET status='failed',error_code='telegram_recipient_changed',completed_at=now() WHERE id=%s AND status='queued'", (job["id"],))
                return
            if not within_window(job, datetime.now(UTC)):
                return
            # Commit attempt before the RPC. Restart/timeout never blindly re-sends it.
            await db.execute("UPDATE cabinet_jobs SET status='sending',attempted_at=now() WHERE id=%s AND status='queued'", (job["id"],))
            try:
                result = await asyncio.wait_for(client(functions.messages.SendMessageRequest(
                    peer=peer, message=job["body"], random_id=job["random_id"], no_webpage=True)), timeout=35)
                message_id = message_id_from_result(result, job["random_id"])
                if not message_id:
                    raise RuntimeError("telegram_delivery_uncertain")
                async with db.transaction():
                    await db.execute("UPDATE cabinet_jobs SET status='sent',completed_at=now(),telegram_message_id=%s WHERE id=%s AND status='sending'", (message_id, job["id"]))
                    await db.execute("""INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,
                        telegram_message_id,direction,body,sent_at) VALUES(%s,%s,%s,%s,%s,'outbound',%s,now())
                        ON CONFLICT(connection_id,telegram_message_id) DO NOTHING""",
                        (row["owner_id"], job["id"], row["id"], job["recipient_id"], message_id, job["body"]))
            except (errors.FloodWaitError, errors.PeerFloodError):
                await db.execute("UPDATE cabinet_jobs SET status='failed',error_code='telegram_rate_limit',completed_at=now() WHERE id=%s", (job["id"],))
                await self.pause(db, row, "telegram_rate_limit")
            except (errors.UserPrivacyRestrictedError, errors.UserIsBlockedError, errors.ChatWriteForbiddenError):
                await db.execute("UPDATE cabinet_jobs SET status='failed',error_code='telegram_recipient_unavailable',completed_at=now() WHERE id=%s", (job["id"],))
            except Exception:
                await db.execute("UPDATE cabinet_jobs SET status='uncertain',error_code='telegram_delivery_uncertain',completed_at=now() WHERE id=%s", (job["id"],))
                await self.pause(db, row, "telegram_delivery_uncertain")

    async def connection(self, row):
        client = None
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
                client.add_event_handler(lambda event: self.incoming(row, event), events.NewMessage(incoming=True))
                await asyncio.wait_for(client.connect(), 20)
                if row["status"] == "connected":
                    if not await client.is_user_authorized():
                        await self.update(db, row, "error", error_code="telegram_authorization_lost")
                        return
                    if not await self.identity(db, row, client):
                        return
                elif not await self.qr_login(db, row, client):
                    return
                # Recover explicit replies from Telegram's update state, without arbitrary history reads.
                await client.catch_up()
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
