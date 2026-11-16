"""Verify an Outreach Telegram user session and report only its public identity."""

import argparse
import asyncio
import json
from pathlib import Path
import sys

from telethon import TelegramClient
from telethon.sessions import StringSession


async def check_account(config, expected_username):
    client = TelegramClient(
        StringSession(config["session"]),
        config["api_id"],
        config["api_hash"],
        device_model="KorDevTeam Outreach",
        receive_updates=False,
        connection_retries=0,
        request_retries=0,
    )
    try:
        await asyncio.wait_for(client.connect(), timeout=15)
        user = await asyncio.wait_for(client.get_me(), timeout=15)
        if not user or user.bot:
            return {"ok": False, "error": "not_authorized"}
        if (user.username or "").casefold() != expected_username.casefold():
            return {"ok": False, "error": "unexpected_account"}
        return {"ok": True, "username": user.username, "user_id": str(user.id)}
    finally:
        await client.disconnect()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--session-file", type=Path)
    args = parser.parse_args()
    try:
        if args.session_file:
            with args.session_file.open(encoding="utf-8") as session:
                config = json.load(session)
        else:
            config = json.load(sys.stdin)
        result = asyncio.run(check_account(config, args.account.removeprefix("@")))
    except Exception as error:
        result = {"ok": False, "error": type(error).__name__}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
