import unittest
from contextlib import nullcontext
from unittest.mock import patch
from collections import Counter
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from queue_worker import normalize_recipient, slots, process_due


class ScheduleTests(unittest.TestCase):
    def test_each_profile_can_use_a_different_window_and_limit(self):
        result = list(slots(date(2026, 11, 23), 41, 20, time(16), time(18)))
        self.assertEqual(list(Counter(value.date() for value in result).values()), [20, 20, 1])
        self.assertTrue(all(time(16) <= value.time() < time(18) for value in result))
        self.assertTrue(all((b-a).total_seconds() >= 120 for a,b in zip(result,result[1:])))

    def test_142_messages_fit_the_daily_window(self):
        start = date(2026, 11, 17)
        result = list(slots(start, 142))
        counts = Counter(value.date() for value in result)
        self.assertEqual(list(counts.values()), [10] * 14 + [2])
        self.assertEqual(result[0].date(), start)
        self.assertTrue(all(time(9, 30) <= value.time() < time(11, 30) for value in result))
        self.assertTrue(all(value.tzinfo == ZoneInfo("Europe/Moscow") for value in result))
        self.assertTrue(all((end - begin).total_seconds() >= 120 for begin, end in zip(result, result[1:])))

    def test_requires_a_recipient_identity_and_evidence(self):
        row = {"draft_id": "5f801448-abcc-4b67-aa4a-108c8302f30f", "recipient_id": "4271",
               "permission_kind": "request", "permission_evidence": "Telegram message 48"}
        self.assertEqual(normalize_recipient(row)["recipient_id"], "4271")
        for invalid in ({}, dict(row, permission_evidence="  "), dict(row, recipient_id="@contact"),
                        dict(row, permission_kind="public_profile")):
            with self.assertRaises(ValueError):
                normalize_recipient(invalid)


class Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, paused=False, attempts=0):
        self.paused, self.attempts, self.completed = paused, attempts, []

    def transaction(self):
        return nullcontext()

    def execute(self, sql, args=()):
        if 'SELECT * FROM outreach_telegram_profiles' in sql:
            return Result({'paused':self.paused,'daily_limit':1,'window_start':time(9,30),'window_end':time(11,30)})
        if "AS dry_run" in sql:
            return Result({'dry_run':False})
        if 'count(*) AS total' in sql:
            return Result({'total':self.attempts,'latest':None})
        if 'SELECT * FROM outreach_telegram_deliveries' in sql:
            return Result({'id':'delivery','draft_id':'draft','body':'Hello','address':'https://t.me/recipient'})
        if 'FROM outreach_messenger_drafts WHERE id' in sql:
            return Result({'body':'Hello','address':'https://t.me/recipient'})
        if "SET status = %s" in sql:
            self.completed.append(args[0])
        return Result()


class WorkerIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_or_paused_profile_does_not_block_another_profile(self):
        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026,11,23,10,0,tzinfo=ZoneInfo('Europe/Moscow'))
        delivered=[]
        async def deliver(job):
            delivered.append(job)
            return 'sent',None,123
        with patch('queue_worker.datetime',Clock), patch('queue_worker.eligible',return_value=True):
            first, second = FakeConnection(attempts=1),FakeConnection()
            await process_due(first,'first_account',deliver)
            self.assertEqual(delivered,[])
            await process_due(second,'second_account',deliver)
            self.assertEqual(len(delivered),1)
            self.assertEqual(second.completed,['sent'])
            await process_due(FakeConnection(paused=True),'paused_account',deliver)
            self.assertEqual(len(delivered),1)


if __name__ == "__main__":
    unittest.main()
