"""Interactive local authorization; never pass codes/passwords through MCP or chat."""
import argparse
import asyncio
import getpass
import json
import os
from pathlib import Path
import re
import tempfile


async def login(args):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    sender = args.account.removeprefix('@').lower()
    if not re.fullmatch(r'[a-z][a-z0-9_]{3,31}', sender):
        raise ValueError('Invalid Telegram username')
    output = args.output_dir / (sender + '.json')
    if output.exists():
        raise ValueError('A session already exists; it will not be overwritten')
    # An existing application configuration may be reused locally without printing it.
    config = json.loads(args.app_config.read_text()) if args.app_config else {}
    api_id = config.get('api_id') or int(input('Telegram API ID: ').strip())
    api_hash = config.get('api_hash') or getpass.getpass('Telegram API hash: ').strip()
    client = TelegramClient(StringSession(), api_id, api_hash, device_model='KorDevTeam Outreach')
    try:
        await client.start(phone=lambda: input('Номер телефона: ').strip(),
                           code_callback=lambda: getpass.getpass('Код Telegram: ').strip(),
                           password=lambda: getpass.getpass('Пароль двухэтапной проверки: '))
        account = await client.get_me()
        if not account or account.bot or (account.username or '').lower() != sender:
            raise ValueError('Authorized account does not match requested username')
        args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.telegram-', dir=args.output_dir)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump({'api_id':api_id,'api_hash':api_hash,'session':client.session.save()}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            # Atomic create, never overwrite another profile's credentials.
            os.link(name, output)
        finally:
            os.unlink(name)
        print(f'Профиль @{sender} авторизован. Секреты сохранены в отдельном файле.')
    finally:
        await client.disconnect()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account', required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--app-config', type=Path)
    asyncio.run(login(parser.parse_args()))
