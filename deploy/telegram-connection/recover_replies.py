"""Server-only maintenance: recover bounded correspondence for explicitly selected sent jobs.

Stop cabinet-telegram first. This command reuses its server-side session under
the same advisory lock; it has no delivery, dialog-list or read-receipt path.
"""
import argparse
import asyncio
from datetime import datetime
import json
from uuid import UUID

from telethon import errors
from cabinet_worker import CabinetWorker, private_session_path


def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.utcoffset() is None:
        raise argparse.ArgumentTypeError('Timezone is required')
    return result


async def recover(args):
    worker = CabinetWorker()
    async with await worker.db() as db:
        locked = await (await db.execute('SELECT pg_try_advisory_lock(hashtext(%s)) AS locked',
                                        ('cabinet-connection:' + str(args.connection_id),))).fetchone()
        if not locked['locked']:
            raise ValueError('recovery_connection_busy')
        client = None
        try:
            row = await (await db.execute("""SELECT c.* FROM cabinet_connections c JOIN cabinet_accounts a ON a.id=c.owner_id
                WHERE c.id=%s AND c.owner_id=%s AND c.status='connected' AND a.active
                AND NOT EXISTS (SELECT 1 FROM cabinet_jobs j WHERE j.connection_id=c.id
                    AND j.status IN ('queued','sending','uncertain'))""",
                (args.connection_id, args.owner_id))).fetchone()
            if not row:
                raise ValueError('recovery_connection_not_idle')
            path = private_session_path(worker.root, row['id'], row['generation'])
            if not path.is_file():
                raise ValueError('recovery_session_missing')
            # Do not consume/update Telegram's live-update cursor during history
            # recovery: the restarted worker must still receive concurrent replies.
            client = worker.client(path, receive_updates=False)
            await asyncio.wait_for(client.connect(), 20)
            return await worker.recover_messages(row, client, args.job_id, args.since, args.until)
        finally:
            if client:
                await client.disconnect()
            await db.execute('SELECT pg_advisory_unlock(hashtext(%s))',
                             ('cabinet-connection:' + str(args.connection_id),))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner-id', required=True, type=UUID)
    parser.add_argument('--connection-id', required=True, type=UUID)
    parser.add_argument('--job-id', required=True, action='append', type=UUID)
    parser.add_argument('--since', required=True, type=timestamp)
    parser.add_argument('--until', required=True, type=timestamp)
    args = parser.parse_args()
    try:
        result = asyncio.run(recover(args))
    except errors.FloodWaitError as exc:
        print(json.dumps({'ok': False, 'error': 'telegram_rate_limit', 'retry_after_seconds': exc.seconds}))
        raise SystemExit(1)
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and str(exc).startswith('recovery_') else 'recovery_failed'
        print(json.dumps({'ok': False, 'error': code}))
        raise SystemExit(1)
    print(json.dumps({'ok': True, **result}))


if __name__ == '__main__':
    main()
