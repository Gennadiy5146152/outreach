# Outreach Desk

Локальный сервис для личного B2B-аутрича по ТЗ: Node.js, PostgreSQL, SMTP/IMAP, безопасная email-валидация, прогрев, open tracking, вложения и аналитика.

## Быстрый старт

1. Скопируйте настройки:

```bash
cp .env.example .env
```

2. Запустите сервис:

```bash
docker compose up -d
```

3. Откройте:

```text
http://localhost:3000
```

По умолчанию включен `MAIL_DRY_RUN=true`: письма логируются и сохраняются в БД, но не уходят через SMTP. Для реальной отправки заполните SMTP/IMAP-настройки mailbox в UI и отключите dry-run в `.env`.

## Команды

```bash
npm run dev       # локальный backend без Docker
npm run worker    # локальный worker без Docker
npm run migrate   # применить миграции
npm run check     # проверка синтаксиса JS
```

## Резервная копия PostgreSQL

```bash
docker compose exec postgres pg_dump -U outreach outreach > backup.sql
```

## Важное

- `.env` не коммитится.
- Вложения хранятся в `storage/attachments`.
- Open tracking для реальных получателей требует публичный `PUBLIC_TRACKING_URL`, например через туннель.
