import {
  prepareForm,
  validateForm,
  clearFormErrors,
} from "./form-validation.js";
import { createQrPoller } from "./qr-polling.js";
import {createCabinetStats} from './cabinet-stats.js';
const $ = (id) => document.getElementById(id);
let csrf = "",
  connections = [],
  campaigns = [],
  campaignId = "",
  draftPage = 1,
  queuePage = 1,
  qrId = "",
  verifiedEmail = "",
  qrRetryMode = "new",
  addingTelegram = false,
  plan = null;
let invite = new URLSearchParams(location.hash.slice(1)).get("invite");
if (invite) history.replaceState(null, "", location.pathname);
const errors = {
  stats_filters_invalid:'Проверьте даты и выбранную группу.',
  outcome_invalid:'Проверьте статус и основание оценки.',
  outcome_snapshot_changed:'Переписка обновилась. Обновите статистику и оцените диалог заново.',
  outcome_manual_locked:'В диалоге сохранена ручная оценка владельца.',
  outcome_evidence_invalid:'Не удалось подтвердить сообщения, на которых основана оценка.',
  outcome_booking_evidence_required:'Для записи нужно подтверждение договорённости обеими сторонами.',
  telegram_source_invalid: "Группа или автор исходного сообщения не совпадают с выбранным получателем. Отправка не выполнена.",
  telegram_source_unavailable: "Не удалось проверить исходное сообщение в группе. Отправка не выполнена.",
  recipient_source_invalid: "Проверьте группу, числовой ID группы и номер исходного сообщения.",
  recipient_address_conflict: "Укажите либо личный username, либо исходное сообщение в группе.",
  instagram_not_configured: "Подключение Instagram пока не настроено администратором.",
  instagram_oauth_expired: "Время входа истекло или вход открыт в другом браузере. Подключите Instagram заново.",
  instagram_oauth_declined: "Вы отменили подключение Instagram. Можно попробовать снова.",
  instagram_professional_required: "Подключить можно профессиональный аккаунт Instagram Business или Creator.",
  instagram_account_already_managed: "Этот Instagram-профиль уже подключён в другом кабинете.",
  instagram_provider_error: "Instagram не подтвердил подключение. Попробуйте снова. Если ошибка повторяется, администратору нужно проверить настройки приложения Meta.",
  instagram_authorization_expired: "Доступ Instagram отозван или истёк. Подключите аккаунт заново.",
  instagram_connection_not_found: "Подключение Instagram не найдено.",
  telegram_connection_attention_required:
    "Отправка остановлена из-за ограничения Telegram или неопределённой доставки. Проверьте результат в Telegram, затем подключите профиль заново после решения проблемы.",
  invalid_email: "Проверьте адрес электронной почты.",
  email_auth_not_configured:
    "Отправка писем пока не настроена. Обратитесь к администратору.",
  token_scope_invalid: "Выберите права и разрешённые рассылки для токена.",
  token_campaign_access_invalid: "Выберите все рассылки кабинета или отдельные рассылки.",
  token_expiry_invalid: "Срок действия токена должен быть от 1 до 90 дней.",
  invalid_text: "Заполните текст и название. Проверьте длину.",
  recipient_id_required:
    "Укажите числовой Telegram ID из проверенной карточки контакта.",
  invalid_telegram_username: "Проверьте имя пользователя Telegram.",
  telegram_identity_mismatch:
    "Вы вошли в другой Telegram-профиль. Запросите QR и войдите в указанный аккаунт.",
  telegram_account_already_managed:
    "Этот Telegram-профиль уже подключён в другом кабинете.",
  telegram_qr_expired: "QR-код истёк. Запросите новый.",
  telegram_qr_preparation_timeout: "Не удалось подготовить QR за минуту. Попробуйте ещё раз.",
  connection_not_found: "Профиль не найден. Обновите страницу.",
  telegram_login_expired: "Время входа истекло. Запросите новый QR-код.",
  telegram_password_invalid:
    "Неверный облачный пароль Telegram. Попробуйте ещё раз.",
  telegram_connection_failed:
    "Не удалось подключиться к Telegram. Запросите QR ещё раз.",
  telegram_authorization_lost: "Сеанс Telegram завершён. Войдите заново по QR.",
  telegram_rate_limit:
    "Telegram ограничил отправку. Оставшаяся очередь остановлена.",
  telegram_delivery_uncertain:
    "Не удалось подтвердить доставку. Проверьте сообщение в Telegram; повторной отправки не будет.",
  telegram_recipient_changed: "Контакт изменился. Сообщение не отправлено.",
  telegram_recipient_unavailable: "Получателю нельзя отправить сообщение.",
  worker_restarted: "После перезапуска результат требует проверки в Telegram.",
  outreach_stopped: "Остановлено пользователем.",
  password_reset: "Остановлено после смены пароля.",
  connection_restarted: "Подключение изменено, очередь остановлена.",
  cabinet_auth_required: "Нужно войти в кабинет.",
  invalid_credentials: "Неверный логин или пароль.",
  password_requires_8_characters: "Пароль должен содержать минимум 8 символов.",
  password_too_long: "Пароль должен содержать не более 1024 символов.",
  current_password_invalid: "Текущий пароль неверен. Почта не изменена.",
  invite_invalid: "Приглашение использовано или истекло.",
  cabinet_https_not_configured:
    "Для кабинетов администратору нужно настроить HTTPS.",
  https_required: "Откройте кабинет через HTTPS.",
  csrf_denied: "Сессия устарела. Перезагрузите страницу.",
  connection_schedule_conflict:
    "Для одного профиля используйте одинаковый лимит и часы во всех рассылках.",
  telegram_sending_disabled:
    "Администратор ещё не включил отправку из личных кабинетов.",
  telegram_not_connected: "Telegram не подключён или обработчик не отвечает.",
  draft_not_eligible:
    "Среди выбранных есть остановленные, уже запланированные / отправленные контакты или черновики без основания для отправки.",
  plan_changed: "Данные изменились. Подготовьте план заново.",
  plan_schedule_expired: "Время плана устарело. Подготовьте заново.",
  confirmation_invalid: "Подтверждение устарело или уже использовано.",
  invalid_schedule:
    "Проверьте интервал и лимит: минимум 3 минуты на сообщение.",
  draft_already_dispatched:
    "Этот черновик уже в отправке. Его текст нельзя менять.",
  too_many_requests: "Слишком много попыток. Попробуйте позже.",
};
const scopeLabels = {
  "instagram:read": "Статус Instagram-профилей без переписки",
  "outreach:read": "Чтение сообщений и очереди",
  "outreach:draft": "Создание и правка черновиков",
  "outreach:send": "Запуск сохранённых сообщений",
  "outreach:stop": "Остановка сообщений",
};
const jobLabels = {
  queued: "В очереди",
  sending: "Отправляется",
  sent: "Отправлено",
  failed: "Ошибка",
  cancelled: "Отменено",
  uncertain: "Нужно проверить результат",
};
async function api(path, body, method) {
  let res;
  try { res = await fetch("/api/cabinet" + path, {
    method: method || (body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }); } catch {
    throw Object.assign(new Error("Нет связи с сервером. Проверьте подключение к интернету."), { retryable: true });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw Object.assign(new Error("Сервер временно не отвечает. Попробуйте ещё раз."), { retryable: true });
  }
  if (!res.ok)
    throw Object.assign(new Error(
      errors[data.error] ||
        "Не удалось выполнить действие. Обновите страницу и попробуйте ещё раз.",
    ), { status: res.status, retryable: res.status >= 500 || res.status === 429 || res.status === 408 });
  return data;
}
function node(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function button(text, fn) {
  const b = node("button", text);
  b.type = "button";
  b.addEventListener("click", () => work(fn));
  return b;
}
async function work(fn) {
  $("notice").textContent = "";
  try {
    return await fn();
  } catch (e) {
    $("notice").textContent = e.message;
  }
}
function form(id, fn) {
  prepareForm($(id));
  $(id).addEventListener("submit", (event) => {
    event.preventDefault();
    const dialog = event.target.closest("dialog");
    dialog?.querySelector(".dialog-message")?.remove();
    if (!validateForm(event.target)) return;
    work(async () => {
      const b = event.submitter || event.target.querySelector("button");
      if (b) b.disabled = true;
      try {
        await fn(Object.fromEntries(new FormData(event.target)), event.target);
      } catch (error) {
        if (!dialog?.open) throw error;
        const message = node("p", error.message, "dialog-message");
        message.setAttribute("role", "alert");
        dialog.append(message);
        message.scrollIntoView({ block: "nearest", behavior: "instant" });
      } finally {
        if (b) b.disabled = false;
      }
    });
  });
}
function at(value) {
  return value
    ? new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) +
        " МСК"
    : "";
}
const cabinetStats=createCabinetStats({api,at,onCampaignChange:async id=>{campaignId=id;$("campaignSelect").value=id;await loadContent();}});
function card(title, body) {
  const box = node("div", undefined, "card");
  box.append(node("h3", title));
  if (body) box.append(node("div", body, "body"));
  return box;
}
function showAuth() {
  $("auth").hidden = false;
  $("workspace").hidden = true;
  $("logout").hidden = true;
  if (invite) {
    $("authTitle").textContent = "Создайте пароль для кабинета";
    $("loginLabel").hidden = true;
    $("authForm").elements.username.required = false;
    const p = $("authForm").elements.password;
    p.minLength = 8;
    p.autocomplete = "new-password";
    $("authForm").querySelector("button").textContent = "Активировать кабинет";
  }
}
async function boot() {
  if (invite) {
    showAuth();
    return;
  }
  try {
    const me = await api("/me");
    if (me.kind !== "owner") throw new Error("Войдите как владелец кабинета.");
    csrf = me.csrf;
    $("sendingDisabled").hidden = me.send_enabled;
    $("identity").textContent =
      me.display_name + " · " + (me.email || me.login);
    $("identity").title = $("identity").textContent;
    $("profileEmail").value = me.email || "";
    verifiedEmail = me.email_verified ? me.email : "";
    $("requestPasswordReset").disabled = !verifiedEmail;
    $("mcpBaseUrl").textContent = location.origin;
    $("emailStatus").textContent = me.email_verified
      ? "Почта подтверждена. По ней можно войти и восстановить пароль."
      : "Привяжите почту, чтобы восстанавливать доступ самостоятельно.";
    $("auth").hidden = true;
    $("logout").hidden = false;
    await refresh();
    renderCabinetPage();
    $("workspace").hidden = false;
    const result = new URLSearchParams(location.search).get("instagram");
    if (result) {
      $("notice").textContent = result === "connected" ? "Instagram подключён." : (errors[result] || errors.instagram_provider_error);
      history.replaceState(null, "", "/cabinet#instagram");
    }
  } catch (e) {
    location.replace("/login.html");
  }
}
async function refresh() {
  await loadConnections();
  await loadInstagram();
  campaigns = await api("/campaigns");
  $("campaignCount").textContent = campaigns.length;
  $("campaignSelect").replaceChildren();
  $("tokenCampaigns").replaceChildren();
  if (!campaigns.length)
    $("tokenCampaigns").append(
      node(
        "p",
        "Рассылок пока нет. Выберите «Все рассылки кабинета», чтобы выдать доступ к будущим рассылкам.",
        "muted",
      ),
    );
  for (const c of campaigns) {
    const option = node(
      "option",
      c.name + " · " + (c.username ? "@" + c.username : "не подключён"),
    );
    option.value = c.id;
    $("campaignSelect").append(option);
    const label = node("label", undefined, "check"),
      input = node("input");
    input.type = "checkbox";
    input.name = "campaign";
    input.value = c.id;
    label.append(input, document.createTextNode(c.name));
    $("tokenCampaigns").append(label);
  }
  if (!campaigns.some((c) => c.id === campaignId))
    campaignId = campaigns[0]?.id || "";
  $("campaignSelect").value = campaignId;
  cabinetStats.setCampaigns(campaigns);
  updateCampaignLayout();
  await loadContent();
  await loadTokens();
}
async function loadInstagram() {
  try {
    const result = await api("/instagram");
    $("instagramConnect").disabled = !result.configured;
    $("instagramStatus").textContent = !result.configured
      ? "Для входа администратору нужно завершить настройку приложения Meta."
      : result.accounts.length ? "Подключённые аккаунты" : "Аккаунтов пока нет. Подключите свой профиль через Instagram.";
    $("instagramAccounts").replaceChildren();
    for (const account of result.accounts) {
      const box = card("@" + account.username, account.name);
      box.append(node("p", account.status === "connected" ? "Доступ до " + at(account.token_expires_at) : "Доступ истёк. Подключите аккаунт заново.", "muted"));
      box.append(button("Проверить подключение", async () => {
        await api(`/instagram/${account.id}/check`, {});
        await loadInstagram();
        $("notice").textContent = "Instagram отвечает. Подключение работает.";
      }), button("Отключить", async () => {
        if (!window.confirm("Отключить @" + account.username + " от этого кабинета?")) return;
        await api(`/instagram/${account.id}/disconnect`, {});
        await loadInstagram();
      }));
      $("instagramAccounts").append(box);
    }
  } catch (e) {
    $("instagramStatus").textContent = e.message;
    $("instagramConnect").disabled = true;
  }
}
$("instagramConnect").addEventListener("click", () => work(async () => {
  $("instagramConnect").disabled = true;
  try {
    const result = await api("/instagram/oauth/start", {});
    const url = new URL(result.authorization_url);
    if (url.origin !== "https://www.instagram.com" || url.pathname !== "/oauth/authorize") throw new Error(errors.instagram_provider_error);
    location.assign(url.href);
  } finally { $("instagramConnect").disabled = false; }
}));
$("instagramRefresh").addEventListener("click", () => work(loadInstagram));
async function loadConnections() {
  const list = await api("/connections");
  connections = list;
  $("connectionCount").textContent = list.length;
  $("connections").replaceChildren();
  $("connectionSelect").replaceChildren();
  const statuses = {
    connected: "Подключён",
    pending_qr: "Подготовка QR",
    qr_ready: "Ожидает сканирования",
    password_required: "Нужен облачный пароль",
    expired: "QR истёк",
    error: "Ошибка",
    disconnected: "Отключён",
  };
  for (const c of list) {
    const box = card(
      "@" + (c.username || c.expected_username),
      (statuses[c.status] || c.status) +
        (c.error_code && c.status !== "expired"
          ? " · " + (errors[c.error_code] || "Нужно подключить профиль заново.")
          : ""),
    );
    box.dataset.status = c.status;
    box.classList.add("connection-card");
    box.dataset.connectionId = c.id;
    box.hidden = qrId === c.id && !$("qrPanel").hidden;
    const actions = node("div", undefined, "connection-actions");
    if (c.status !== "connected")
      actions.append(
        button("Войти по QR", async () => {
          if (!["pending_qr", "qr_ready", "password_required"].includes(c.status))
            await api(`/connections/${c.id}/qr`, {});
          watchQr(c.id);
        }),
      );
    actions.append(
      button("Отключить", async () => {
        if (!confirm("Отключить профиль и отменить его оставшуюся очередь?"))
          return;
        await api(`/connections/${c.id}/disconnect`, {});
        if (qrId === c.id) {
          qrPoller.stop();
          qrId = "";
          $("qrPanel").hidden = true;
          $("connectForm").hidden = false;
        }
        await refresh();
      }),
    );
    box.append(actions);
    $("connections").append(box);
    const o = node("option", "@" + (c.username || c.expected_username));
    o.value = c.id;
    $("connectionSelect").append(o);
  }
  $("campaignConnectionField").hidden = list.length === 1;
  telegramLayout();
  updateCampaignLayout();
}
function telegramLayout() {
  const active = !$("qrPanel").hidden;
  $("connectForm").hidden = active || (connections.length > 0 && !addingTelegram);
  $("telegramAddProfile").hidden = active || !connections.length || addingTelegram;
  $("telegramIntro").hidden = active || (connections.length > 0 && !addingTelegram);
}
$("telegramAddProfile").addEventListener("click", () => {
  addingTelegram = true;
  telegramLayout();
  $("connectForm").elements.username.focus();
});
function updateCampaignLayout() {
  const hasProfiles = connections.length > 0;
  $("newCampaign").hidden = !hasProfiles || !campaigns.length;
  $("campaignsEmpty").hidden = campaigns.length > 0;
  $("campaignWorkspace").hidden = !campaigns.length;
  $("campaignsEmptyTitle").textContent = hasProfiles
    ? "Пока нет рассылок"
    : "Подключите Telegram";
  $("campaignsEmptyText").textContent = hasProfiles
    ? "Создайте первую рассылку и добавьте сообщения для получателей."
    : "Подключите профиль, чтобы создать первую рассылку.";
  $("campaignsConnect").hidden = hasProfiles;
  $("emptyCreateCampaign").hidden = !hasProfiles;
  $("campaignPicker").hidden = campaigns.length < 2;
  $("selectedCampaignName").hidden = campaigns.length > 1;
}
function updateDraftSelection() {
  const selected = $("drafts").querySelectorAll(
    "input[name=draft]:checked",
  ).length;
  $("draftActions").hidden = !selected;
  $("selectedDraftCount").textContent = "Выбрано: " + selected;
}
const qrPoller = createQrPoller({
  fetchState: id => api(`/connections/${id}/qr`),
  onState: async (data, id) => {
      if (qrId !== id) return;
      const titles = {
        pending_qr: "Готовим QR-код…",
        qr_ready: "Отсканируйте QR-код",
        password_required: "Облачный пароль",
        connected: "Telegram подключён",
        expired: "QR-код истёк",
        error: "Не удалось подключить Telegram",
        disconnected: "Telegram отключён",
      };
      $("qrStatus").textContent = titles[data.status] || data.status;
      $("qrPanel").dataset.state = data.status;
      $("qrHint").textContent = data.status === "qr_ready"
        ? "1. Откройте Telegram на телефоне.\n2. Настройки → Устройства.\n3. Подключить устройство."
        : data.status === "password_required" ? "Введите пароль двухэтапной защиты Telegram."
        : data.status === "pending_qr" ? "Обычно это занимает несколько секунд."
        : data.status === "expired" ? "Запросите новый код и отсканируйте его через Telegram." : "";
      $("qrHint").hidden = !$("qrHint").textContent;
      $("qrError").textContent = data.error_code && data.status !== "expired"
        ? errors[data.error_code] ||
          "Не удалось подключиться. Попробуйте ещё раз."
        : "";
      $("qrError").hidden = !$("qrError").textContent;
      $("qrImage").hidden = !data.qr_svg;
      $("qrImage").src = data.qr_svg
        ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data.qr_svg)
        : "";
      $("twoFactor").hidden = data.status !== "password_required";
      $("qrPhoneHint").hidden = data.status !== "qr_ready";
      $("qrExpires").hidden = data.status !== "qr_ready" || !data.qr_expires_at;
      if (!$("qrExpires").hidden) $("qrExpires").textContent = "Код действует ещё " + Math.max(0, Math.ceil((new Date(data.qr_expires_at) - Date.now()) / 1000)) + " с";
      $("qrRetry").hidden = !["expired", "error", "disconnected"].includes(data.status);
      $("qrRetry").textContent = "Получить новый QR";
      qrRetryMode = "new";
      if (data.status === "connected") {
        qrId = "";
        $("qrPanel").hidden = true;
        $("connectForm").hidden = false;
        await refresh();
      }
  },
  onError: (error, { retrying, id }) => {
    if (qrId !== id) return;
    $("qrStatus").textContent = retrying ? "Восстанавливаем связь…" : "Подключение прервалось";
    $("qrPanel").dataset.state = "network_error";
    $("qrHint").textContent = retrying ? "Повторяем проверку автоматически. Не закрывайте страницу." : "";
    $("qrHint").hidden = !$("qrHint").textContent;
    $("qrError").textContent = retrying ? "" : (errors[error.message] || error.message);
    $("qrError").hidden = !$("qrError").textContent;
    $("qrImage").hidden = $("qrPhoneHint").hidden = $("qrExpires").hidden = $("twoFactor").hidden = true;
    $("qrRetry").hidden = retrying || error.status === 401 || error.status === 403;
    qrRetryMode = error.message === "telegram_qr_preparation_timeout" ? "new" : "check";
    $("qrRetry").textContent = qrRetryMode === "new" ? "Получить новый QR" : "Повторить проверку";
  },
});
function watchQr(id) {
  qrId = id;
  const c = connections.find(x => x.id === id);
  $("qrAccount").textContent = "@" + (c?.username || c?.expected_username || "Telegram");
  $("qrStatus").textContent = "Готовим QR-код…";
  $("qrHint").textContent = "Обычно это занимает несколько секунд.";
  $("qrHint").hidden = false;
  $("qrError").hidden = $("qrImage").hidden = $("qrRetry").hidden = $("qrPhoneHint").hidden = $("qrExpires").hidden = $("twoFactor").hidden = true;
  $("qrPanel").hidden = false;
  $("qrPanel").dataset.state = "pending_qr";
  $("connectForm").hidden = true;
  telegramLayout();
  $("notice").textContent = "";
  $("connections").querySelectorAll("[data-connection-id]").forEach(box => { box.hidden = box.dataset.connectionId === id; });
  qrPoller.start(id);
}
$("qrBack").addEventListener("click", () => {
  qrPoller.stop(); qrId = "";
  $("qrPanel").hidden = true;
  $("connectForm").hidden = false;
  work(loadConnections);
});
$("qrRetry").addEventListener("click", () => {
  const id = qrId;
  $("qrRetry").disabled = true;
  (async () => {
    try {
      if (qrRetryMode === "new") await api(`/connections/${id}/qr`, {});
      watchQr(id);
    } catch (e) { $("qrError").hidden = false; $("qrError").textContent = e.message; }
    finally { $("qrRetry").disabled = false; }
  })();
});
async function loadContent() {
  $("drafts").replaceChildren();
  $("queue").replaceChildren();
  $("thread").replaceChildren();
  const c = campaigns.find((c) => c.id === campaignId);
  $("selectedCampaignName").textContent = c?.name || "";
  $("campaignState").textContent = c
    ? `${c.paused ? "На паузе" : "Запущена"} · до ${c.daily_limit} сообщений в день · ${c.window_start.slice(0, 5)}–${c.window_end.slice(0, 5)} МСК`
    : "Создайте рассылку.";
  const statistics=cabinetStats.select(campaignId);
  if (!c) {await statistics;return;}
  await Promise.all([loadDrafts(),loadQueue(),statistics]);
}
function recipientLabel(item) {
  if (!item.recipient_source) return item.address;
  const source = item.recipient_source;
  return `ID ${item.recipient_id} · автор сообщения @${source.username}/${source.message_id}`;
}
async function loadDrafts() {
  if (!campaignId) return;
  const list = await api(`/campaigns/${campaignId}/drafts?page=${draftPage}`);
  $("drafts").replaceChildren();
  updateDraftSelection();
  if (!list.length)
    $("drafts").append(
      node(
        "p",
        "Сообщений пока нет. Нажмите «Добавить сообщение», чтобы подготовить первое.",
        "empty-drafts",
      ),
    );
  $("draftPage").textContent = "Страница " + draftPage;
  $("prevDrafts").disabled = draftPage <= 1;
  $("nextDrafts").disabled = list.length < 100;
  $("draftPagination").hidden = draftPage === 1 && list.length < 100;
  for (const d of list) {
    const box = card(d.name || recipientLabel(d));
    const label = node("label", undefined, "check"),
      input = node("input");
    input.type = "checkbox";
    input.value = d.id;
    input.name = "draft";
    label.append(
      input,
      document.createTextNode(recipientLabel(d) + (d.stopped ? " · остановлен" : "")),
    );
    box.append(label, node("div", d.body, "body"));
    box.append(
      button("Править текст", async () => {
        const body = prompt("Текст сообщения", d.body);
        if (body === null) return;
        await api(`/campaigns/${campaignId}/drafts/${d.id}`, { body }, "PATCH");
        await loadDrafts();
      }),
    );
    $("drafts").append(box);
  }
}
async function loadQueue() {
  if (!campaignId) return;
  const list = await api(`/campaigns/${campaignId}/queue?page=${queuePage}`);
  $("queue").replaceChildren();
  if (!list.length) $("queue").append(node("p", "Отправок пока нет.", "muted"));
  $("queuePage").textContent = "Страница " + queuePage;
  $("prevQueue").disabled = queuePage <= 1;
  $("nextQueue").disabled = list.length < 100;
  $("queuePagination").hidden = queuePage === 1 && list.length < 100;
  for (const job of list) {
    const box = card(
      recipientLabel(job),
      (jobLabels[job.status] || "Требует проверки") +
        " · " +
        at(job.scheduled_at) +
        (job.error_code
          ? " · " +
            (errors[job.error_code] || "Проверьте результат в Telegram.")
          : ""),
    );
    box.append(
      button("Сообщение и ответы", async () => {
        const msgs = await api(`/campaigns/${campaignId}/threads/${job.id}`);
        $("thread").replaceChildren(card("Текст задания", job.body));
        for (const m of msgs)
          $("thread").append(
            card(
              (m.direction === "outbound" ? "Вы" : "Ответ") +
                " · " +
                at(m.sent_at),
              m.body,
            ),
          );
      }),
    );
    $("queue").append(box);
  }
}
async function preview(kind) {
  if (!campaignId) throw new Error("Выберите рассылку.");
  const ids = [
    ...$("drafts").querySelectorAll("input[name=draft]:checked"),
  ].map((e) => e.value);
  if (!ids.length) throw new Error("Выберите черновики.");
  plan = await api(`/campaigns/${campaignId}/${kind}/prepare`, {
    draft_ids: ids,
  });
  $("previewTitle").textContent =
    kind === "launch" ? "Подтверждение отправки" : "Подтверждение остановки";
  $("previewItems").replaceChildren(
    node(
      "p",
      "Отправитель: " +
        (plan.preview.sender ? "@" + plan.preview.sender : "не подключён"),
    ),
  );
  for (const item of plan.preview.items)
    $("previewItems").append(
      card(
        recipientLabel(item) + (item.scheduled_at ? " · " + at(item.scheduled_at) : ""),
        item.body,
      ),
    );
  $("previewDialog").showModal();
}
async function loadTokens() {
  const list = await api("/tokens");
  $("activeTokenCount").textContent = list.filter(
    (t) => !t.revoked_at && new Date(t.expires_at) > new Date(),
  ).length;
  $("tokenList").replaceChildren();
  if (!list.length)
    $("tokenList").append(
      node(
        "p",
        "Токенов пока нет. Доступ внешним помощникам не выдан.",
        "muted",
      ),
    );
  for (const t of list) {
    const box = card(
      t.name,
      t.display_prefix +
        (t.all_campaigns ? " · Все рассылки кабинета, включая будущие" : " · Выбранные рассылки") +
        " · " +
        t.scopes
          .map((scope) => scopeLabels[scope] || "Ограниченное действие")
          .join(", ") +
        " · до " +
        at(t.expires_at) +
        (t.revoked_at ? " · отозван" : ""),
    );
    if (!t.revoked_at)
      box.append(
        button("Отозвать токен", async () => {
          await api(`/tokens/${t.id}/revoke`, {});
          await loadTokens();
        }),
      );
    $("tokenList").append(box);
  }
}
form("authForm", async (data) => {
  await api(
    invite ? "/auth/activate" : "/auth/login",
    invite ? { invite_token: invite, password: data.password } : data,
  );
  invite = null;
  $("authForm").reset();
  await boot();
});
form("connectForm", async (data) => {
  const c = await api("/connections", data);
  addingTelegram = false;
  await loadConnections();
  if (c.status !== "connected") watchQr(c.id);
});
form("twoFactor", async (data, element) => {
  try {
    await api(`/connections/${qrId}/password`, data);
  } finally {
    element.reset();
  }
});
form("campaignForm", async (data) => {
  const c = await api("/campaigns", {
    ...data,
    daily_limit: Number(data.daily_limit),
  });
  campaignId = c.id;
  $("campaignDialog").close();
  await refresh();
});
form("draftForm", async (data, element) => {
  if (!campaignId) throw new Error("Выберите рассылку.");
  await api(`/campaigns/${campaignId}/drafts`, data);
  element.reset();
  $("draftDialog").close();
  await loadDrafts();
});
form("importForm", async (data, element) => {
  if (!campaignId) throw new Error("Выберите рассылку.");
  const rows = JSON.parse(data.json);
  if (!Array.isArray(rows) || !rows.length || rows.length > 500)
    throw new Error("Нужен массив от 1 до 500 черновиков.");
  let saved = 0;
  try {
    for (const row of rows) {
      await api(`/campaigns/${campaignId}/drafts`, row);
      saved++;
    }
  } catch (e) {
    throw new Error(`Сохранено ${saved} из ${rows.length}. ${e.message}`);
  }
  element.reset();
  $("importDialog").close();
  await loadDrafts();
});
form("tokenForm", async (data) => {
  const scopes = [
      ...$("tokenForm").querySelectorAll("input[name=scope]:checked"),
    ].map((e) => e.value),
    campaign_ids = [
      ...$("tokenCampaigns").querySelectorAll("input:checked"),
    ].map((e) => e.value);
  if (!scopes.length)
    throw new Error("Выберите хотя бы одно право для токена.");
  const campaign_access = data.campaign_access;
  if (campaign_access === "selected" && scopes.some(s => s.startsWith("outreach:")) && !campaign_ids.length)
    throw new Error("Выберите хотя бы одну разрешённую рассылку.");
  const result = await api("/tokens", {
    name: data.name,
    expires_in_days: Number(data.expires_in_days),
    scopes,
    campaign_access,
    campaign_ids: campaign_access === "all" ? [] : campaign_ids,
  });
  $("tokenValue").textContent = result.token;
  $("tokenCopyStatus").textContent = "";
  $("tokenReveal").hidden = false;
  await loadTokens();
});
$("tokenForm").querySelectorAll("input[name=campaign_access]").forEach(input => {
  input.addEventListener("change", () => {
    $("notice").textContent = "";
    $("tokenCampaigns").hidden = $("tokenForm").elements.campaign_access.value !== "selected";
    $("tokenAllHint").hidden = !$("tokenCampaigns").hidden;
  });
});
form("emailForm", async (data, form) => {
  try {
    const result = await api("/profile/email", data);
    $("emailMessage").textContent = result.message;
  } finally {
    form.elements.current_password.value = "";
  }
});
$("hideToken").onclick = () => {
  $("tokenValue").textContent = "";
  $("tokenCopyStatus").textContent = "";
  $("tokenReveal").hidden = true;
};
function openCampaignDialog() {
  if (!connections.length) return;
  $("campaignForm").reset();
  clearFormErrors($("campaignForm"));
  $("campaignDialog").querySelector(".dialog-message")?.remove();
  $("campaignDialog").showModal();
  $("campaignForm").elements.name.focus();
}
$("newCampaign").onclick = openCampaignDialog;
$("emptyCreateCampaign").onclick = openCampaignDialog;
$("openDraftDialog").onclick = () => {
  clearFormErrors($("draftForm"));
  $("draftDialog").querySelector(".dialog-message")?.remove();
  $("draftDialog").showModal();
  $("draftForm").elements.address.focus();
};
$("openImportDialog").onclick = () => {
  $("campaignMore").open = false;
  clearFormErrors($("importForm"));
  $("importDialog").querySelector(".dialog-message")?.remove();
  $("importDialog").showModal();
  $("importForm").elements.json.focus();
};
for (const button of document.querySelectorAll("[data-close-dialog]"))
  button.addEventListener("click", () => $(button.dataset.closeDialog).close());
$("drafts").addEventListener("change", updateDraftSelection);
document.addEventListener("click", (event) => {
  if (!$("campaignMore").contains(event.target)) $("campaignMore").open = false;
});
$("copyToken").onclick = async () => {
  if (!$("tokenValue").textContent) return;
  try {
    await navigator.clipboard.writeText($("tokenValue").textContent);
    $("tokenCopyStatus").textContent = "Токен скопирован.";
  } catch {
    $("tokenCopyStatus").textContent =
      "Не удалось скопировать автоматически. Выделите токен и скопируйте вручную.";
  }
};
$("requestPasswordReset").onclick = () =>
  work(async () => {
    if (!verifiedEmail) throw new Error("Сначала подтвердите почту кабинета.");
    const button = $("requestPasswordReset");
    button.disabled = true;
    try {
      const result = await api("/auth/recover", { email: verifiedEmail });
      $("passwordMessage").textContent = result.message;
    } finally {
      button.disabled = false;
    }
  });
$("logout").onclick = () =>
  work(async () => {
    await api("/auth/logout", {});
    qrPoller.stop();
    location.reload();
  });
$("campaignSelect").onchange = () =>
  work(async () => {
    campaignId = $("campaignSelect").value;
    draftPage = queuePage = 1;
    await loadContent();
  });
for (const [id, fn] of Object.entries({
  refreshDrafts: () => {
    $("campaignMore").open = false;
    return refresh();
  },
  launchPreview: () => preview("launch"),
  stopPreview: () => preview("stop"),
  prevDrafts: () => {
    draftPage--;
    return loadDrafts();
  },
  nextDrafts: () => {
    draftPage++;
    return loadDrafts();
  },
  prevQueue: () => {
    queuePage--;
    return loadQueue();
  },
  nextQueue: () => {
    queuePage++;
    return loadQueue();
  },
  confirmPlan: async () => {
    if (!plan) return;
    const b = $("confirmPlan");
    b.disabled = true;
    try {
      await api("/execute", {
        confirmation_token: plan.confirmation_token,
        confirm: true,
        kind: plan.preview.kind,
      });
      plan = null;
      $("previewDialog").close();
      await refresh();
    } finally {
      b.disabled = false;
    }
  },
  cancelPlan: () => {
    plan = null;
    $("previewDialog").close();
  },
}))
  $(id).addEventListener("click", () => work(fn));
const pageTitles = {
  overview: "Обзор",
  telegram: "Telegram",
  instagram: "Instagram",
  campaigns: "Рассылки",
  analytics: "Аналитика",
  tokens: "Доступы MCP",
  profile: "Мой профиль",
};
function renderCabinetPage({ focus = false } = {}) {
  const requested = location.hash.slice(1);
  const id = Object.hasOwn(pageTitles, requested) ? requested : "overview";
  if (requested !== id) history.replaceState(null, "", "#" + id);
  document.querySelectorAll("[data-cabinet-page]").forEach((page) => {
    page.hidden = page.id !== id;
  });
  $("currentPageTitle").textContent = pageTitles[id];
  document.querySelectorAll(".cabinet-nav a").forEach((link) => {
    const active = link.getAttribute("href") === "#" + id;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (id !== "telegram") qrPoller.stop();
  else {
    const active = connections.find(c => ["pending_qr", "qr_ready", "password_required"].includes(c.status));
    if (qrId && !$("qrPanel").hidden) watchQr(qrId);
    else if (active) watchQr(active.id);
  }
  if (focus) {
    $("notice").textContent = "";
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const heading = $(id).querySelector("h1,h2");
    heading.tabIndex = -1;
    heading.classList.add("page-heading");
    heading.focus({ preventScroll: true });
  }
}
history.scrollRestoration = "manual";
document.querySelectorAll(".cabinet-nav a").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const hash = link.getAttribute("href");
    if (location.hash !== hash) history.pushState(null, "", hash);
    renderCabinetPage({ focus: true });
  });
});
window.addEventListener("hashchange", () => renderCabinetPage({ focus: true }));
renderCabinetPage();
boot();
