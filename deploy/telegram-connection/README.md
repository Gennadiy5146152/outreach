# Очередь Telegram в Outreach

Сервис `telegram` использует отдельную MTProto-сессию с правами на чтение
только у пользователя контейнера. Секрет передаётся через монтирование файла.
Для production сначала примените миграции основного приложения, затем соберите
и запустите сервис `telegram` из `docker-compose.prod.yml` с профилем `telegram`.
Параметры `OUTREACH_TELEGRAM_ACCOUNT` и `OUTREACH_TELEGRAM_SESSION_FILE` задают
ожидаемый аккаунт и путь к его сессии.

Входной JSON для команды `prepare` — массив записей с полями:

- `draft_id` — UUID готового черновика в «Мессенджерах».
- `recipient_id` — числовой ID пользователя Telegram. Перед отправкой он
  сравнивается с текущим владельцем имени пользователя.
- `permission_kind` — `request`, если пользователь попросил прислать предложение,
  либо `consent`, если заранее согласился его получить.
- `permission_evidence` — где и когда зафиксировали запрос или согласие
  (например, ссылка или ID входящего обращения в CRM).

Из каталога Outreach на сервере:

```sh
docker compose -f docker-compose.prod.yml exec -T telegram \
  python -B /app/queue_worker.py --account ideamen51 prepare < recipients.json > preview.json
```

Покажите владельцу точные тексты, получателей и время из `preview.json`.
После явного подтверждения партии передайте её код из поля `approval`:

```sh
docker compose -f docker-compose.prod.yml exec -T telegram \
  python -B /app/queue_worker.py --account ideamen51 enqueue --approve "$outreach_approval" < preview.json
```

В разделе «Мессенджеры» видны статусы и запланированное время по Москве.
Кнопка общей остановки Outreach отменяет ожидающие сообщения. Статус «Проверить
отправку» означает, что результат вызова Telegram неизвестен. Такой заказ
нужно сверить с историей перед повторной постановкой.
