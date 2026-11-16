import unittest
from collections import Counter
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from queue_worker import normalize_recipient, slots


class ScheduleTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
