# Instagram в личном кабинете

Подключение повторяет Instagram Login из `kusidis/services/instagramService.js`
проекта «Красотуля», адаптировано к PostgreSQL и изоляции кабинетов Outreach.
Пароль Instagram сервис не принимает. Нужен профессиональный Business / Creator.

## Настройка

В окружении web:

```
CABINET_PUBLIC_URL=https://outreach.korotkov.dev
INSTAGRAM_APP_ID=<Instagram App ID из Meta>
INSTAGRAM_APP_SECRET=<секрет приложения>
INSTAGRAM_GRAPH_API_VERSION=v25.0
INSTAGRAM_HTTPS_PROXY_URL=<необязательный HTTPS proxy>
```

Ключ AES-256-GCM берётся из `CABINET_SECRET`, затем из `AUTH_SESSION_SECRET`
(минимум 32 символа). Не менять его без переподключения аккаунтов.
Meta → Instagram → API setup with Instagram login → Business login settings:
добавить **ещё один** Valid OAuth Redirect URI, не заменяя адрес «Красотули»:

`https://outreach.korotkov.dev/api/cabinet/instagram/oauth/callback`

У приложения должен быть `instagram_business_basic`. Для своих тестовых аккаунтов
нужна роль в приложении; подключение чужих аккаунтов требует соответствующего
уровня доступа Meta. Не использовать Facebook App ID вместо Instagram App ID.

После деплоя владелец открывает `/cabinet#instagram` → «Подключить Instagram»,
проходит вход на Instagram, затем возвращается в свой кабинет. Подключений может
быть несколько. Один аккаунт Instagram нельзя привязать к двум кабинетам Outreach.

## Границы текущей интеграции

Доступны подключение, статус, проверка и локальное отключение. Срок доступа виден
в карточке: после его окончания нужен повторный вход. Direct, импорт истории,
webhooks, рассылки и автоматическое продление токена в этот этап не входят.
`instagram_business_manage_messages` не запрашивается до реализации Direct.
Официальный API не поддерживает холодные сообщения произвольным пользователям.
Существующие email- и Telegram-очереди не используют это подключение.

MCP: отдельно выдаваемое право **«Смотреть статус Instagram-профилей этого
кабинета»**, scope `instagram:read`; инструмент `instagram_connections_list`.
В режиме выбранных рассылок пустой список допустим для этого отдельного scope.
Режим «Все рассылки кабинета» также не требует списка рассылок.
Он не даёт доступ к входу, шифрованным токенам, Direct и отправке.
Прежние токены не получают новых прав.

OAuth state одноразовый, живёт 10 минут, связан с браузером через отдельную
HttpOnly Secure SameSite=Lax cookie и исходной сессией кабинета. Сам кабинет
сохраняет SameSite=Strict. Обмен кода не создаёт сессию кабинета.
После сброса пароля, выхода или отключения кабинета старый вход не завершается.
Токены шифруются с AAD владельца и аккаунта; ответы API не содержат секретов.
Провайдерские ошибки возвращаются только в виде фиксированных кодов.

При использовании того же приложения Meta, что у «Красотули», кнопка «Отключить»
удаляет только локальный токен Outreach. Она не вызывает `DELETE me/permissions`,
который отозвал бы разрешения и для существующей интеграции «Красотули».
Отзыв общего разрешения вручную в Instagram затронет оба сервиса. Не менять
существующие webhook/deauthorization/data-deletion callbacks общего приложения.

Проверка без настоящего аккаунта:
`CABINET_TEST_DATABASE_URL=postgres://.../cabinet_test npm run test:cabinet`.
Тест Instagram подменяет транспорт провайдера и не отправляет сообщения.

Источники:
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
