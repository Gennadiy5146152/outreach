"""Outreach Telegram queue. The send worker only processes explicitly enqueued jobs."""

import argparse
import asyncio
from datetime import date, datetime, time, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
from uuid import UUID
from zoneinfo import ZoneInfo

MOSCOW = ZoneInfo("Europe/Moscow")
WINDOW_START, WINDOW_END = time(9, 30), time(11, 30)
DAILY_LIMIT = 10
QUEUE_LOCK = "outreach_telegram_queue"
STOP_LOCK = "outreach_delivery_control"
PROFILE = re.compile(r"https://t\.me/([a-z][a-z0-9_]{3,31})", re.I)

DRAFT = """
SELECT id, name, company, address, body, website, channel, partnership, technology_product,
       review_reason, sent_at
FROM outreach_messenger_drafts WHERE id = %s
"""
COMPANY_BLOCKED = """
WITH candidate AS (
  SELECT lower(btrim(%s)) AS company,
         split_part(regexp_replace(lower(%s), '^https?://(www[.])?', ''), '/', 1) AS domain
), related AS (
  SELECT l.id, l.email, l.domain, l.status, l.suppressed_at
  FROM leads l CROSS JOIN candidate c
  WHERE lower(btrim(l.company)) = c.company
     OR (c.domain <> '' AND c.domain NOT IN ('vk.com','t.me','tenchat.ru','taplink.cc')
        AND (lower(l.domain) = c.domain OR
          split_part(regexp_replace(lower(coalesce(l.website,'')), '^https?://(www[.])?', ''), '/', 1) = c.domain))
  UNION
  SELECT l.id, l.email, l.domain, l.status, l.suppressed_at
  FROM outreach_channel_contacts contact JOIN leads l ON l.id = contact.lead_id
  WHERE contact.channel = 'telegram' AND contact.address = %s
)
SELECT EXISTS (
  SELECT 1 FROM related r WHERE r.suppressed_at IS NOT NULL OR r.status = 'suppressed'
    OR EXISTS (SELECT 1 FROM suppressions s WHERE lower(s.email) = lower(r.email) OR lower(s.domain) = lower(r.domain))
    OR EXISTS (
      SELECT 1 FROM messages m WHERE m.lead_id = r.id AND (
        (m.direction = 'outbound' AND m.type NOT IN ('test','warmup') AND m.status = 'sent'
          AND coalesce(m.sent_at,m.created_at) >= now() - interval '30 days')
        OR m.reply_classification IN ('negative_reply','unsubscribe','not_target')))
    OR EXISTS (SELECT 1 FROM sending_queue q WHERE q.lead_id = r.id AND q.mode <> 'test'
      AND q.status IN ('pending','retrying','running'))
) OR EXISTS (
  SELECT 1 FROM suppressions s CROSS JOIN candidate c
  WHERE c.domain <> '' AND lower(s.domain) = c.domain
) OR EXISTS (
  SELECT 1 FROM outreach_channel_tasks t
  JOIN outreach_channel_contacts contact ON contact.id = t.contact_id
  WHERE contact.channel = 'telegram'
    AND (contact.address = %s OR contact.lead_id IN (SELECT id FROM related))
    AND (t.status IN ('waiting','scheduled','declined') OR t.sent_at >= now() - interval '30 days')
) OR EXISTS (
  SELECT 1 FROM outreach_messenger_drafts d CROSS JOIN candidate c
  WHERE d.channel = 'telegram'
    AND (d.address = %s OR lower(btrim(d.company)) = c.company)
    AND d.sent_at >= now() - interval '30 days'
) AS blocked
"""


def slots(first_day, count, daily_limit=DAILY_LIMIT, window_start=WINDOW_START, window_end=WINDOW_END):
    for index in range(count):
        day, slot = divmod(index, daily_limit)
        beginning = datetime.combine(first_day + timedelta(days=day), window_start, MOSCOW)
        width = int((datetime.combine(first_day, window_end) - datetime.combine(first_day, window_start)).total_seconds() / daily_limit)
        yield beginning + timedelta(seconds=slot * width + 1 + secrets.randbelow(max(1, width - 121)))


def normalize_recipient(row):
    try:
        draft_id = str(UUID(row["draft_id"]))
        raw_recipient = row["recipient_id"]
        if isinstance(raw_recipient, bool) or not re.fullmatch(r"[0-9]{1,19}", str(raw_recipient)):
            raise ValueError
        recipient = str(int(raw_recipient))
        kind = row["permission_kind"]
        proof = row["permission_evidence"].strip()
        if int(recipient) <= 0 or int(recipient) >= 2**63 or not 3 <= len(proof) <= 1000:
            raise ValueError
        if kind not in ("request", "consent") or "\0" in proof:
            raise ValueError
        return {"draft_id": draft_id, "recipient_id": recipient, "permission_kind": kind, "permission_evidence": proof}
    except (AttributeError, KeyError, TypeError, ValueError) as error:
        raise ValueError("Each contact needs a draft, a Telegram user ID and a documented request or consent.") from error


def fingerprint(plan):
    data = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def blocked(conn, draft, delivery, own_id=None):
    address = draft["address"]
    if conn.execute(COMPANY_BLOCKED, (draft["company"], draft["website"], address, address, address)).fetchone()["blocked"]:
        return True
    return conn.execute("""
        SELECT EXISTS (
          SELECT 1 FROM outreach_telegram_deliveries q
          JOIN outreach_messenger_drafts other ON other.id = q.draft_id
          WHERE (%s::uuid IS NULL OR q.id <> %s::uuid)
            AND (q.recipient_id = %s OR lower(q.address) = lower(%s)
              OR lower(btrim(other.company)) = lower(btrim(%s))
              OR (%s <> '' AND other.website = %s))
            AND (q.status IN ('pending','sending','uncertain')
                OR (q.status = 'sent' AND q.completed_at >= now() - interval '30 days'))
        ) AS blocked
    """, (own_id, own_id, delivery["recipient_id"], address, draft["company"], draft["website"], draft["website"])).fetchone()["blocked"]


def eligible(conn, draft, job, own_id=None):
    return (
        draft and draft["channel"] == "telegram" and PROFILE.fullmatch(draft["address"])
        and not (draft["partnership"] or draft["technology_product"] or draft["review_reason"] or draft["sent_at"])
        and not blocked(conn, draft, job, own_id)
    )


def prepare(conn, sender, rows, start):
    profile = profile_config(conn, sender)
    if profile["paused"]:
        raise ValueError("Telegram profile is paused")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 500:
        raise ValueError("Expected an array of 1–500 recipients with evidence.")
    ready, excluded, companies = [], [], set()
    recipients, addresses = set(), set()
    for item in rows:
        job = normalize_recipient(item)
        draft = conn.execute(DRAFT, (job["draft_id"],)).fetchone()
        company_key = draft["company"].strip().casefold() if draft else ""
        if (not eligible(conn, draft, job) or company_key in companies
                or draft["address"] in addresses or job["recipient_id"] in recipients):
            excluded.append(job["draft_id"])
            continue
        addresses.add(draft["address"])
        companies.add(company_key)
        recipients.add(job["recipient_id"])
        ready.append(dict(job, address=draft["address"], name=draft["name"], company=draft["company"], body=draft["body"]))
    day = start
    last_active = conn.execute("""
        SELECT max((scheduled_at AT TIME ZONE 'Europe/Moscow')::date) AS day
        FROM outreach_telegram_deliveries WHERE sender = %s AND status IN ('pending','sending','sent','uncertain')
    """, (sender,)).fetchone()["day"]
    if last_active and last_active >= day:
        day = last_active + timedelta(days=1)
    jobs = [dict(job, scheduled_at=slot.isoformat()) for job, slot in zip(ready, slots(day, len(ready), profile["daily_limit"], profile["window_start"], profile["window_end"]))]
    plan = {"sender": sender, "jobs": jobs, "excluded": excluded, "profile_revision": profile["revision"]}
    return {"approval": fingerprint(plan), "plan": plan}


def enqueue(conn, sender, approval, package):
    plan = package["plan"]
    jobs = plan["jobs"]
    if plan["sender"] != sender or not secrets.compare_digest(approval, fingerprint(plan)) or not 1 <= len(jobs) <= 500:
        raise ValueError("Use the approval fingerprint for the exact prepared batch.")
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock_shared(hashtext(%s))", (STOP_LOCK,))
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (QUEUE_LOCK,))
        profile = profile_config(conn, sender, lock=True)
        if profile["paused"] or profile["revision"] != plan.get("profile_revision"):
            raise ValueError("Profile settings changed; prepare again")
        for job in jobs:
            normalized = normalize_recipient(job)
            draft = conn.execute(DRAFT + " FOR UPDATE", (normalized["draft_id"],)).fetchone()
            stamp = datetime.fromisoformat(job["scheduled_at"])
            now = datetime.now(MOSCOW)
            if (stamp.utcoffset() is None or stamp <= now or not eligible(conn, draft, normalized)
                    or any(draft[key] != job[key] for key in ("address", "body", "name", "company"))):
                raise ValueError("A contact, draft or time changed. Prepare the batch again.")
            scheduled = stamp.astimezone(MOSCOW)
            count = conn.execute("""
                SELECT count(*) AS total, bool_or(abs(extract(epoch FROM scheduled_at - %s::timestamptz)) < 120) AS overlaps
                FROM outreach_telegram_deliveries
                WHERE sender = %s AND status IN ('pending','sending','sent','uncertain')
                  AND (scheduled_at AT TIME ZONE 'Europe/Moscow')::date = %s
            """, (stamp, sender, scheduled.date())).fetchone()
            if (count["total"] >= profile["daily_limit"] or count["overlaps"]
                    or not profile["window_start"] <= scheduled.time() < profile["window_end"]):
                raise ValueError("The sender already has messages scheduled at these times. Prepare the batch again.")
            conn.execute("""
                INSERT INTO outreach_telegram_deliveries
                (draft_id, sender, recipient_id, address, body, permission_kind, permission_evidence, scheduled_at, random_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (normalized["draft_id"], sender, normalized["recipient_id"], job["address"], job["body"],
                  normalized["permission_kind"], normalized["permission_evidence"], stamp, 1 + secrets.randbelow(2**63 - 2)))
    return {"queued": len(jobs), "sender": sender}


def complete(conn, job, status, detail, message_id=None):
    conn.execute("""
        UPDATE outreach_telegram_deliveries
        SET status = %s, detail = %s, completed_at = now(), telegram_message_id = %s
        WHERE id = %s
    """, (status, detail, message_id, job["id"]))
    if status == "sent":
        conn.execute("""
            UPDATE outreach_messenger_drafts SET sent_body = %s, sent_at = now(), updated_at = now()
            WHERE id = %s AND sent_at IS NULL
        """, (job["body"], job["draft_id"]))


async def send_to_telegram(client, job, window_start=WINDOW_START, window_end=WINDOW_END):
    from telethon import errors, functions, types
    window_start = job.get("_window_start", window_start)
    window_end = job.get("_window_end", window_end)
    username = PROFILE.fullmatch(job["address"])[1]
    try:
        result = await asyncio.wait_for(client(functions.contacts.ResolveUsernameRequest(username)), 15)
    except (errors.UsernameInvalidError, errors.UsernameNotOccupiedError):
        return "skipped", "username_unavailable", None
    except (errors.FloodWaitError, errors.PeerFloodError):
        return "failed", "telegram_rate_limit", None
    user = next((user for user in result.users if user.id == job["recipient_id"]), None)
    if (not isinstance(result.peer, types.PeerUser) or result.peer.user_id != job["recipient_id"]
            or not isinstance(user, types.User) or user.bot or user.access_hash is None):
        return "skipped", "recipient_identity_changed", None
    if not window_start <= datetime.now(MOSCOW).time() < window_end:
        return "skipped", "window_closed", None
    request = functions.messages.SendMessageRequest(
        peer=types.InputPeerUser(user.id, user.access_hash), message=job["body"],
        random_id=job["random_id"], no_webpage=True,
    )
    try:
        response = await asyncio.wait_for(client(request), 15)
    except (errors.FloodWaitError, errors.PeerFloodError):
        return "failed", "telegram_rate_limit", None
    except (errors.ForbiddenError, errors.BadRequestError) as error:
        if isinstance(error, errors.RandomIdDuplicateError):
            return "uncertain", "telegram_duplicate_id", None
        return "failed", type(error).__name__, None
    if isinstance(response, types.UpdateShortSentMessage):
        return "sent", None, response.id
    for update in getattr(response, "updates", []):
        if isinstance(update, types.UpdateMessageID) and update.random_id == job["random_id"]:
            return "sent", None, update.id
    return "uncertain", "telegram_receipt_unavailable", None


async def tick(conn, sender, deliver):
    if not conn.execute("SELECT pg_try_advisory_lock_shared(hashtext(%s)) AS locked", (STOP_LOCK,)).fetchone()["locked"]:
        return
    try:
        if not conn.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS locked", (QUEUE_LOCK,)).fetchone()["locked"]:
            return
        try:
            await process_due(conn, sender, deliver)
        finally:
            conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (QUEUE_LOCK,))
    finally:
        conn.execute("SELECT pg_advisory_unlock_shared(hashtext(%s))", (STOP_LOCK,))


async def process_due(conn, sender, deliver):
    now = datetime.now(MOSCOW)
    with conn.transaction():
        profile = profile_config(conn, sender, lock=True)
        if profile["paused"]:
            return
        conn.execute("""
            UPDATE outreach_telegram_deliveries SET status = 'uncertain', completed_at = now(), detail = 'interrupted'
            WHERE sender = %s AND status = 'sending'
        """, (sender,))
        end = datetime.combine(now.date(), profile["window_end"], MOSCOW)
        conn.execute("""
            UPDATE outreach_telegram_deliveries SET status = 'skipped', completed_at = now(), detail = 'window_closed'
            WHERE sender = %s AND status = 'pending' AND (
                (send_before IS NOT NULL AND send_before <= %s)
                OR
                (scheduled_at AT TIME ZONE 'Europe/Moscow')::date < %s
                OR (scheduled_at < %s AND %s >= %s))
        """, (sender, now, now.date(), end, now, end))
        if not profile["window_start"] <= now.time() < profile["window_end"]:
            return
        if conn.execute("""
            SELECT EXISTS (SELECT 1 FROM settings WHERE key = 'runtime' AND
                coalesce(value ->> 'dryRun', value ->> 'mailDryRun') = 'true') AS dry_run
        """).fetchone()["dry_run"]:
            return
        attempts = conn.execute("""
            SELECT count(*) AS total, max(attempted_at) AS latest
            FROM outreach_telegram_deliveries
            WHERE sender = %s AND (attempted_at AT TIME ZONE 'Europe/Moscow')::date = %s
        """, (sender, now.date())).fetchone()
        if attempts["total"] >= profile["daily_limit"] or (attempts["latest"] and now - attempts["latest"] < timedelta(minutes=2)):
            return
        job = conn.execute("""
            SELECT * FROM outreach_telegram_deliveries
            WHERE sender = %s AND status = 'pending' AND scheduled_at <= %s
            ORDER BY scheduled_at, id LIMIT 1 FOR UPDATE
        """, (sender, now)).fetchone()
        if not job:
            return
        conn.execute(
            "UPDATE outreach_telegram_deliveries SET status = 'sending', attempted_at = now() WHERE id = %s",
            (job["id"],),
        )

    with conn.transaction():
        draft = conn.execute(DRAFT + " FOR UPDATE", (job["draft_id"],)).fetchone()
        if (not eligible(conn, draft, job, job["id"])
                or any(draft[key] != job[key] for key in ("address", "body"))):
            complete(conn, job, "skipped", "draft_or_contact_changed")
            return
        try:
            job["_window_start"], job["_window_end"] = profile["window_start"], profile["window_end"]
            state, detail, message_id = await deliver(job)
        except Exception as error:
            state, detail, message_id = "uncertain", type(error).__name__, None
        complete(conn, job, state, detail, message_id)
        if detail == "telegram_rate_limit":
            conn.execute("""
                UPDATE outreach_telegram_deliveries SET status = 'cancelled', completed_at = now(), detail = %s
                WHERE sender = %s AND status = 'pending'
            """, (detail, sender))


def profile_config(conn, sender, lock=False):
    profile = conn.execute(
        "SELECT * FROM outreach_telegram_profiles WHERE sender = %s" + (" FOR UPDATE" if lock else ""),
        (sender,),
    ).fetchone()
    if not profile:
        raise ValueError("Telegram profile is not registered")
    override = (profile.get("day_overrides") or {}).get(datetime.now(MOSCOW).date().isoformat())
    if override:
        profile = dict(profile, daily_limit=int(override["daily_limit"]),
                       window_start=time.fromisoformat(override["window_start"]),
                       window_end=time.fromisoformat(override["window_end"]))
    return profile


def db_connect():
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(os.environ["DATABASE_URL"], autocommit=True, row_factory=dict_row, connect_timeout=8)


async def run_worker(sender, session_path):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    worker_lock = db_connect()
    if not worker_lock.execute("SELECT pg_try_advisory_lock(hashtext(%s)) AS locked", ("telegram_profile:" + sender,)).fetchone()["locked"]:
        worker_lock.close()
        return
    client = None
    try:
        config = json.loads(session_path.read_text(encoding="utf-8"))
        client = TelegramClient(
            StringSession(config["session"]), config["api_id"], config["api_hash"], device_model="KorDevTeam Outreach",
            receive_updates=False, connection_retries=1, request_retries=0, flood_sleep_threshold=0,
        )
        await asyncio.wait_for(client.connect(), 20)
        account = await asyncio.wait_for(client.get_me(), 15)
        if not account or account.bot or (account.username or "").casefold() != sender.casefold():
            raise ValueError("The authorized Telegram account does not match the configured sender.")
        with db_connect() as conn:
            current = profile_config(conn, sender)
            if current["telegram_user_id"] not in (None, account.id):
                raise ValueError("Authorized Telegram identity changed")
            conn.execute("""UPDATE outreach_telegram_profiles SET telegram_user_id=%s,
                connection_status='connected', heartbeat_at=now(), last_error=NULL WHERE sender=%s""", (account.id, sender))
        print(f"Connected Telegram sender @{account.username}.", flush=True)
        while True:
            with db_connect() as conn:
                profile = profile_config(conn, sender)
                conn.execute("UPDATE outreach_telegram_profiles SET connection_status='connected', heartbeat_at=now(), last_error=NULL WHERE sender=%s", (sender,))
                await tick(conn, sender, lambda job: send_to_telegram(client, job, profile["window_start"], profile["window_end"]))
            await asyncio.sleep(10)
    finally:
        try:
            if client is not None:
                await client.disconnect()
        finally:
            worker_lock.close()


async def run_profiles(session_dir):
    tasks, retry_at = {}, {}
    legacy_account = os.environ.get("OUTREACH_TELEGRAM_ACCOUNT", "ideamen51").removeprefix("@").lower()
    try:
        while True:
            with db_connect() as conn:
                profiles = conn.execute("SELECT sender FROM outreach_telegram_profiles ORDER BY sender").fetchall()
                for row in profiles:
                    sender = row["sender"]
                    if sender in tasks and not tasks[sender].done():
                        continue
                    if sender in tasks:
                        try:
                            tasks.pop(sender).result()
                        except Exception as error:
                            code = type(error).__name__
                            print(f"Telegram @{sender}: {code}", file=sys.stderr, flush=True)
                            conn.execute("UPDATE outreach_telegram_profiles SET connection_status='error', last_error=%s, heartbeat_at=now() WHERE sender=%s", (code, sender))
                        retry_at[sender] = asyncio.get_running_loop().time() + 60
                    if asyncio.get_running_loop().time() < retry_at.get(sender, 0):
                        continue
                    session_path = session_dir / (sender + ".json")
                    if not session_path.is_file() and sender == legacy_account:
                        session_path = session_dir / "session.json"
                    if not session_path.is_file():
                        conn.execute("UPDATE outreach_telegram_profiles SET connection_status='awaiting_session', last_error=NULL WHERE sender=%s", (sender,))
                        continue
                    tasks[sender] = asyncio.create_task(run_worker(sender, session_path))
            await asyncio.sleep(10)
    finally:
        for task in tasks.values():
            task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account")
    sub = parser.add_subparsers(dest="action", required=True)
    profiles_command = sub.add_parser("profiles")
    profiles_command.add_argument("--session-dir", type=Path, required=True)
    prepare_command = sub.add_parser("prepare")
    prepare_command.add_argument("--start", type=date.fromisoformat)
    execute_command = sub.add_parser("enqueue")
    execute_command.add_argument("--approve", required=True)
    run_command = sub.add_parser("run")
    run_command.add_argument("--session-file", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "profiles":
        asyncio.run(run_profiles(args.session_dir))
        return 0
    if not args.account:
        parser.error("--account is required")
    sender = args.account.removeprefix("@").lower()
    if args.action == "run":
        try:
            asyncio.run(run_worker(sender, args.session_file))
        except Exception as error:
            print(f"Telegram worker stopped: {type(error).__name__}", file=sys.stderr)
            return 1
        return 0
    with db_connect() as conn:
        if args.action == "enqueue":
            result = enqueue(conn, sender, args.approve, json.load(sys.stdin))
        else:
            tomorrow = datetime.now(MOSCOW).date() + timedelta(days=1)
            start = max(tomorrow, args.start) if args.start else tomorrow
            result = prepare(conn, sender, json.load(sys.stdin), start)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
