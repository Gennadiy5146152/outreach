const state = {
  campaigns: [],
  mailboxes: [],
  leads: [],
  outreachImports: [],
  outreachDrafts: [],
  allOutreachDrafts: [],
  outreachDraftFilter: "ready",
  selectedOutreachDraftIds: new Set(),
  outreachDraftLaunchReview: null,
  openOutreachDraftId: null,
  outreachImportPreview: null,
  outreachConversations: [],
  reviewConversations: [],
  conversationPreset: "all",
  campaignLeads: [],
  campaignAvailableLeads: [],
  selectedCampaignLeadIds: new Set(),
  segments: [],
  queue: [],
  queueFilter: "waiting",
  expandedQueueGroups: new Set(),
  suppressions: [],
  warmup: null,
  warmupPage: 1,
  warmupPageSize: 20,
  dashboard: null,
  settings: null,
  envCheck: null,
  health: null,
  inbox: [],
  inboxFilter: "all",
  leadQuickFilter: "all",
  editorTarget: null,
  campaignStep: "campaign",
  actionResults: {
    global: null,
    mailboxes: {},
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const TIME_ZONE_OPTIONS = [
  ["Europe/Moscow", "Москва (UTC+3)"],
  ["Europe/Kaliningrad", "Калининград (UTC+2)"],
  ["Europe/Samara", "Самара (UTC+4)"],
  ["Asia/Yekaterinburg", "Екатеринбург (UTC+5)"],
  ["Asia/Omsk", "Омск (UTC+6)"],
  ["Asia/Novosibirsk", "Новосибирск (UTC+7)"],
  ["Asia/Irkutsk", "Иркутск (UTC+8)"],
  ["Asia/Yakutsk", "Якутск (UTC+9)"],
  ["Asia/Vladivostok", "Владивосток (UTC+10)"],
  ["UTC", "UTC"],
];
const WEEKDAY_SHORT_LABELS = {
  1: "Пн",
  2: "Вт",
  3: "Ср",
  4: "Чт",
  5: "Пт",
  6: "Сб",
  7: "Вс",
};
const ACTIVE_VIEW_STORAGE_KEY = "outreachDesk.activeView";
const VIEW_TITLES = {
  dashboard: "Обзор",
  start: "Что делать",
  outreachImport: "Импорт Excel",
  outreachDrafts: "Черновики",
  review: "Требуют решения",
  conversations: "Диалоги",
  aiExport: "Экспорт для ИИ",
  leads: "База",
  mailboxes: "Почтовые ящики",
  campaigns: "Рассылка",
  queue: "Очередь",
  inbox: "Входящие",
  warmup: "Прогрев",
  suppression: "Стоп-лист",
  events: "События",
  settings: "Настройки",
};
const VALID_VIEWS = new Set(Object.keys(VIEW_TITLES));

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = "/login.html";
      return null;
    }
    const error = new Error(data?.error || data?.errors?.join("\n") || response.statusText);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function formJson(form) {
  const data = new FormData(form);
  const payload = {};
  for (const [key, value] of data.entries()) {
    if (payload[key] === undefined) {
      payload[key] = value;
    } else if (Array.isArray(payload[key])) {
      payload[key].push(value);
    } else {
      payload[key] = [payload[key], value];
    }
  }
  return payload;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2500);
}

function actionDetails(details) {
  if (!details) return "";
  const body = actionDetailsBody(details);
  return body ? `<details class="action-details"><summary>Детали</summary>${body}</details>` : "";
}

function actionDetailsBody(details) {
  if (!details) return "";
  if (typeof details === "string") return `<p>${esc(details)}</p>`;
  if (Array.isArray(details)) {
    return details.length
      ? `<ul>${details.map((item) => `<li>${esc(actionDetailLine(item))}</li>`).join("")}</ul>`
      : `<p>Дополнительных деталей нет.</p>`;
  }
  if (typeof details !== "object") return `<p>${esc(String(details))}</p>`;

  const blocks = [];
  if (details.ok !== undefined) blocks.push(`<p>Результат проверки: <strong>${details.ok ? "можно продолжать" : "нужно исправить"}</strong>.</p>`);
  if (details.queued !== undefined) blocks.push(`<p>Поставлено в очередь: <strong>${esc(details.queued)}</strong>.</p>`);
  if (details.approved !== undefined) blocks.push(`<p>Подтверждено писем: <strong>${esc(details.approved)}</strong>.</p>`);
  if (details.cancelled_queue !== undefined) blocks.push(`<p>Снято с очереди: <strong>${esc(details.cancelled_queue)}</strong>.</p>`);
  if (details.deleted !== undefined) blocks.push(`<p>Удалено: <strong>${esc(details.deleted)}</strong>.</p>`);
  if (details.imapSyncQueued !== undefined) blocks.push(`<p>IMAP-проверок запущено: <strong>${esc(details.imapSyncQueued)}</strong>.</p>`);
  if (details.stats) blocks.push(actionStatsList(details.stats));
  if (details.imapUncheckedMailboxes?.length) {
    blocks.push(`<p>IMAP проверяется автоматически для ящиков: <strong>${esc(details.imapUncheckedMailboxes.join(", "))}</strong>.</p>`);
  }
  if (details.syncStatus) blocks.push(actionSyncStatus(details.syncStatus));
  if (details.errors?.length) blocks.push(actionList("Что исправить", details.errors));
  if (details.warnings?.length) blocks.push(actionList("На что обратить внимание", details.warnings));
  if (details.items?.length) blocks.push(actionItemsList(details.items));
  if (details.fixes?.length) blocks.push(actionList("Автоисправления", details.fixes));

  if (blocks.length) return `<div class="action-detail-body">${blocks.join("")}</div>`;
  return `<pre>${esc(JSON.stringify(details, null, 2))}</pre>`;
}

function actionDetailLine(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item ?? "");
  return item.error || item.warning || item.message || item.email || item.id || JSON.stringify(item);
}

function actionList(title, items) {
  return `
    <div class="action-detail-section">
      <strong>${esc(title)}</strong>
      <ul>${items.map((item) => `<li>${esc(actionDetailLine(item))}</li>`).join("")}</ul>
    </div>
  `;
}

function actionStatsList(stats) {
  const labels = {
    selected: "Выбрано",
    found: "Найдено",
    ready: "Готово",
    blocked: "Заблокировано",
    withMailbox: "С почтой отправителя",
    fallbackMailboxes: "Запасных mailbox",
    withFollowups: "С follow-up",
  };
  const rows = Object.entries(stats)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `<span>${esc(labels[key] || key)}: <strong>${esc(value)}</strong></span>`);
  return rows.length ? `<div class="action-detail-stats">${rows.join("")}</div>` : "";
}

function actionItemsList(items) {
  const visible = items.slice(0, 8);
  return `
    <div class="action-detail-section">
      <strong>Письма</strong>
      <ul>
        ${visible.map((item) => `
          <li>
            ${esc([item.company, item.email].filter(Boolean).join(" · ") || item.id || "Письмо")}
            ${item.status ? ` — ${esc(statusLabel(item.status))}` : ""}
            ${item.mailbox ? `, отправитель: ${esc(item.mailbox)}` : ""}
            ${item.errors?.length ? `. Ошибки: ${esc(item.errors.join("; "))}` : ""}
          </li>
        `).join("")}
      </ul>
      ${items.length > visible.length ? `<p>И еще ${items.length - visible.length} записей.</p>` : ""}
    </div>
  `;
}

function fmtSeconds(value) {
  const total = Math.max(0, Number(value || 0));
  if (total < 60) return `${total} сек`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes} мин ${seconds} сек`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

function actionSyncStatus(syncStatus) {
  const jobs = Array.isArray(syncStatus?.jobs) ? syncStatus.jobs.slice(0, 8) : [];
  const summary = Array.isArray(syncStatus?.summary) ? syncStatus.summary : [];
  const summaryText = summary.length
    ? summary.map((item) => `${statusLabel(item.status)}: ${item.count}`).join(" · ")
    : "за последние сутки задач нет";
  return `
    <div class="action-detail-section">
      <strong>Очередь IMAP</strong>
      <p>${esc(summaryText)}</p>
      ${jobs.length ? `
        <ul>
          ${jobs.map((job) => `
            <li>
              ${esc(job.mailbox_email || "ящик не найден")} — ${esc(statusLabel(job.status))}
              ${job.looks_stuck ? " · похоже, зависла" : ""}
              · возраст: ${esc(fmtSeconds(job.age_seconds))}
              · попытка: ${esc(job.attempts)}/${esc(job.max_attempts)}
              ${job.last_error ? ` · ошибка: ${esc(job.last_error)}` : ""}
            </li>
          `).join("")}
        </ul>
      ` : `<p>Активных IMAP-задач не найдено.</p>`}
    </div>
  `;
}

function actionResultHtml(result) {
  if (!result) return "";
  const statusText = {
    pending: "Выполняется",
    success: "Успешно",
    error: "Ошибка",
    warn: "Внимание",
  }[result.status] || result.status;
  return `
    <div class="action-result ${esc(result.status)}">
      <div>
        <strong>${esc(statusText)}: ${esc(result.title)}</strong>
        <p>${esc(result.message)}</p>
        <span>${fmtDate(result.createdAt)}</span>
      </div>
      ${actionDetails(result.details)}
    </div>
  `;
}

function renderGlobalActionResult() {
  const node = $("#actionResult");
  if (!node) return;
  node.hidden = !state.actionResults.global;
  node.innerHTML = actionResultHtml(state.actionResults.global);
}

function renderMailboxActionResult(mailboxId) {
  const node = document.getElementById(`mailboxActionResult-${mailboxId}`);
  if (!node) return;
  node.innerHTML = actionResultHtml(state.actionResults.mailboxes[mailboxId]);
}

function setActionResult({ status = "success", title, message, details, target }) {
  const result = { status, title, message, details, createdAt: new Date().toISOString() };
  state.actionResults.global = result;
  if (target?.type === "mailbox" && target.id) {
    state.actionResults.mailboxes[target.id] = result;
    renderMailboxActionResult(target.id);
  }
  renderGlobalActionResult();
  toast(`${title}: ${message}`);
}

function errorMessage(error) {
  const prefix = error.status ? `HTTP ${error.status}: ` : "";
  return `${prefix}${error.message || "неизвестная ошибка"}`;
}

async function runAction({ title, pending = "Запрос отправлен, жду ответ сервера...", target, button }, task) {
  if (button) button.disabled = true;
  setActionResult({ status: "pending", title, message: pending, target });
  try {
    return await task();
  } catch (error) {
    setActionResult({
      status: "error",
      title,
      message: errorMessage(error),
      details: error.data || error.message,
      target,
    });
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("ru-RU", { timeZone: currentTimeZone() });
}

function currentTimeZone() {
  return state.settings?.runtime?.timeZone || state.health?.timeZone || "Europe/Moscow";
}

function renderTimeZoneOptions(selected) {
  const value = selected || currentTimeZone();
  const known = TIME_ZONE_OPTIONS.some(([timeZone]) => timeZone === value);
  const options = known ? TIME_ZONE_OPTIONS : [[value, value], ...TIME_ZONE_OPTIONS];
  return options
    .map(([timeZone, label]) => `<option value="${esc(timeZone)}" ${timeZone === value ? "selected" : ""}>${esc(label)}</option>`)
    .join("");
}

function inboxSyncIntervalParts(seconds) {
  const total = Math.max(1, Math.round(Number(seconds || 60)));
  return {
    minutes: Math.floor(total / 60),
    seconds: total % 60,
  };
}

function fmtCountdown(value) {
  if (!value) return "";
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "сейчас";
  const totalSeconds = Math.ceil(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} мин ${String(seconds).padStart(2, "0")} сек`;
}

function queueScheduleLabel(value) {
  if (!value) return "сразу";
  const date = new Date(value);
  const diff = date.getTime() - Date.now();
  const label = diff <= 0 ? "сейчас" : `через ${fmtCountdown(value)}`;
  return `${label}<br><span class="muted">${fmtDate(value)}</span>`;
}

function queueTimeLabel(item) {
  if (item.status === "sent") {
    const sentAt = item.sent_at || item.updated_at;
    return sentAt
      ? `Отправлено<br><span class="muted">${fmtDate(sentAt)}</span>`
      : "Отправлено";
  }
  if (item.status === "cancelled") {
    return item.updated_at
      ? `Отменено<br><span class="muted">${fmtDate(item.updated_at)}</span>`
      : "Отменено";
  }
  if (item.status === "failed") {
    return item.updated_at
      ? `Ошибка<br><span class="muted">${fmtDate(item.updated_at)}</span>`
      : "Ошибка";
  }
  return queueScheduleLabel(item.scheduled_at);
}

const STATUS_LABELS = {
  new: "новый",
  validated: "проверен",
  invalid: "не отправлять",
  enrolled: "в кампании",
  sent: "отправлено",
  opened: "открыто",
  replied: "ответил",
  active: "активен",
  paused: "пауза",
  completed: "завершен",
  meeting: "встреча",
  won: "успех",
  lost: "потерян",
  suppressed: "в стоп-листе",
  ok: "в порядке",
  error: "ошибка",
  unknown: "еще не проверяли",
  valid: "можно отправлять",
  risky: "нужна проверка",
  pending: "в очереди",
  running: "в обработке",
  ready: "готово",
  blocked: "нужно исправить",
  draft: "черновик",
  queued: "в очереди",
  active_sequence: "цепочка идет",
  needs_approval: "ждет подтверждения",
  waiting_reply_review: "требует решения",
  manual_reply_needed: "нужен ручной ответ",
  skipped: "пропущено",
  retrying: "повтор",
  failed: "ошибка",
  cancelled: "отменено",
  throttled: "замедлен",
  bounced: "недоставка",
  unsubscribed: "отписался",
  not_target: "не целевой",
  approval: "ждет подтверждения",
  manual_reply: "ручной ответ",
  new_thread: "новая ветка",
  reply_to_previous: "ответом в ветку",
};

const VALIDATION_REASON_LABELS = {
  invalid_syntax: "некорректный формат email",
  domain_not_found: "домен email не найден",
  mx_not_found: "у домена нет почтовых MX-записей",
  disposable_domain: "одноразовый почтовый домен",
  role_based: "общий ящик вроде info@, sales@ или team@",
  safe_checks_passed: "формат, домен и почтовые записи в порядке",
  bounce: "почтовый сервер вернул недоставку",
};

const REPLY_CLASS_LABELS = {
  positive_reply: "позитивный ответ",
  neutral_reply: "нейтральный ответ",
  negative_reply: "негативный ответ",
  auto_reply: "автоответ",
  unsubscribe: "отписка",
  not_target: "не целевой",
  bounce: "недоставка",
  unknown: "не разобрано",
};

const REPLY_CLASS_OPTIONS = Object.entries(REPLY_CLASS_LABELS);

const EVENT_LABELS = {
  lead_created: "Лид добавлен",
  email_validated: "Email проверен",
  email_sent: "Письмо отправлено",
  email_opened: "Письмо открыто",
  mailbox_error: "Ошибка почтового ящика",
  queue_recovered: "Очередь восстановлена",
  inbox_sync_queued: "Входящие поставлены на проверку",
  inbox_sync_completed: "Входящие проверены",
  inbox_sync_skipped: "Проверка входящих пропущена",
  inbox_sync_failed: "Ошибка проверки входящих",
  inbound_repair_completed: "Входящие перепривязаны к цепочкам",
  inbound_relinked: "Входящее письмо привязано к цепочке",
  inbound_unlinked: "Входящее письмо не привязано",
  reply_classified: "Ответ классифицирован",
  email_replied: "Получен ответ",
  email_bounced: "Получена недоставка",
  positive_reply_received: "Получен позитивный ответ",
  neutral_reply_received: "Получен нейтральный ответ",
  negative_reply_received: "Получен негативный ответ",
  auto_reply_received: "Получен автоответ",
  unsubscribe_received: "Получена отписка",
  unsubscribe_detected: "Получена отписка",
  not_target_received: "Получен ответ “не целевой”",
  outreach_conversation_stopped: "Цепочка остановлена",
  outreach_conversation_continued: "Follow-up продолжен",
  outreach_followup_delayed: "Follow-up отложен",
  manual_reply_sent: "Ручной ответ отправлен",
  warmup_sent: "Прогрев: письмо отправлено",
  warmup_reply_received: "Прогрев: получен ответ",
  warmup_sync_queued: "Прогрев: синхронизация входящих поставлена в очередь",
  warmup_dialogue_continued: "Прогрев: диалог продолжен",
  warmup_dialogue_completed: "Прогрев: диалог завершен",
  warmup_dialogue_skipped: "Прогрев: письмо пропущено",
};

const EVENT_REASON_LABELS = {
  warmup_sent: "после отправки прогрева",
  reply_sent: "после отправки ответа",
  active_thread_continue: "продолжение активного диалога",
  not_expected_sender: "письмо пришло не от ожидаемого ящика",
  reply_received: "получен живой ответ",
  positive_reply: "позитивный ответ",
  negative_reply: "отказ",
  auto_reply: "автоответ",
  unsubscribe: "отписка",
  not_target: "не целевой контакт",
  bounce: "недоставка",
  manual_stop: "остановлено вручную",
  manual_continue: "продолжено вручную",
  manual_delay: "follow-up отложен вручную",
  manual_classification: "ручная классификация",
  manual_reply_stop_sequence: "ручной ответ, цепочка остановлена",
  manual_reply_continue_sequence: "ручной ответ, follow-up разрешен",
  worker_startup: "перезапуск worker",
  stale_running: "зависшая задача в running",
  adaptive_throttle: "автоматическое замедление из-за ошибок SMTP",
  send_error: "ошибка отправки",
  dry_run: "включен безопасный режим",
};

function statusLabel(value) {
  return STATUS_LABELS[value] || REPLY_CLASS_LABELS[value] || value || "";
}

function nextActionLabel(value) {
  return {
    approve_or_pause_followup: "решить, продолжать ли follow-up",
    stopped_by_user: "цепочка остановлена вручную",
    followup_allowed: "follow-up разрешен",
    manual_reply_sent_sequence_stopped: "ручной ответ отправлен, цепочка остановлена",
    manual_reply_sent_followup_allowed: "ручной ответ отправлен, follow-up разрешен",
    followup_postponed_needs_approval: "follow-up перенесен и ждет ручного разрешения",
    company_scope_reply_review: "ответ получен у связанного контакта, нужно решить по цепочке",
    reply_manually_or_stop: "ответить вручную или оставить цепочку остановленной",
    sequence_stopped_after_negative_reply: "цепочка остановлена после отказа",
    decide_followup_after_auto_reply: "решить, переносить или продолжать follow-up после автоответа",
    sequence_stopped_after_unsubscribe: "цепочка остановлена после отписки",
    sequence_stopped_not_target: "цепочка остановлена: контакт не целевой",
    sequence_stopped_after_bounce: "цепочка остановлена после недоставки",
  }[value] || value || "не задано";
}

function validationReasonText(value) {
  return VALIDATION_REASON_LABELS[value] || value || "";
}

function leadQuickFilterLabel(value) {
  return {
    all: "Все лиды",
    ready: "Готовы к отправке",
    review: "Нужно проверить",
    blocked: "Не отправлять",
  }[value] || "Все лиды";
}

function leadReadyForSend(lead) {
  return ["valid", "risky"].includes(lead.validation_status) && lead.status !== "suppressed";
}

function leadNeedsReview(lead) {
  return ["unknown", "risky"].includes(lead.validation_status || "unknown") && lead.status !== "suppressed";
}

function leadBlocked(lead) {
  return lead.status === "suppressed" || lead.validation_status === "invalid";
}

function leadVisibleItems() {
  if (state.leadQuickFilter === "ready") return state.leads.filter(leadReadyForSend);
  if (state.leadQuickFilter === "review") return state.leads.filter(leadNeedsReview);
  if (state.leadQuickFilter === "blocked") return state.leads.filter(leadBlocked);
  return state.leads;
}

function leadActionText(lead) {
  if (lead.status === "suppressed") return "В стоп-листе: письма этому контакту отправлять нельзя.";
  if (lead.validation_status === "valid") return "Готов к отправке. Можно добавлять в кампанию или запускать через персональный импорт.";
  if (lead.validation_status === "risky") return "Нужна ручная проверка: адрес может быть общим ящиком или спорным контактом.";
  if (lead.validation_status === "invalid") return "Не отправлять: исправь email или убери контакт из рабочей базы.";
  return "Email еще не проверяли: нажми “Запустить проверку email”.";
}

function leadContextText(lead) {
  const parts = [];
  if (lead.segment) parts.push(`сегмент: ${lead.segment}`);
  if (lead.city) parts.push(`город: ${lead.city}`);
  if (lead.source) parts.push(`источник: ${lead.source}`);
  return parts.join(" · ") || "Сегмент и источник не указаны.";
}

function queueModeLabel(value) {
  return {
    test: "тест на свои почты",
    manual: "ручная проверка перед отправкой",
    auto: "обычная отправка",
  }[value] || value || "";
}

function normalizeQueueWindowReason(item) {
  const text = String(item.last_error || "");
  if (!text.startsWith("Вне окна отправки")) return text;
  const withoutNextAttempt = text
    .replace("Вне окна отправки: разрешено в дни ", "Вне окна отправки: ")
    .replace(/Вне окна отправки: ([0-9,\s]+),/, (_match, rawDays) => {
      const days = rawDays
        .split(",")
        .map((day) => WEEKDAY_SHORT_LABELS[Number(day.trim())] || day.trim())
        .filter(Boolean)
        .join(", ");
      return `Вне окна отправки: ${days},`;
    })
    .split(". Ближайшая попытка:")[0];
  const withTimeZone = withoutNextAttempt.includes("(")
    ? withoutNextAttempt
    : `${withoutNextAttempt} (${currentTimeZone()})`;
  const nextAttempt = item.scheduled_at ? fmtDate(item.scheduled_at) : "по ближайшему окну";
  return `${withTimeZone}. Ближайшая попытка: ${nextAttempt}`;
}

function queueStatusHint(item) {
  if (item.requires_approval && !item.approved_at) return "Перед отправкой нужно подтвердить письмо.";
  if (item.status === "pending" && item.last_error?.startsWith("Вне окна отправки")) return normalizeQueueWindowReason(item);
  if (item.status === "pending") return "Ждет своего времени отправки.";
  if (item.status === "retrying") return "Будет повторная попытка после ошибки.";
  if (item.status === "sent") return "Письмо уже отправлено.";
  if (item.status === "failed") return item.last_error || "Отправка завершилась ошибкой.";
  return "";
}

function queueStateLabel(item) {
  if (item.requires_approval && !item.approved_at) return "Ждет подтверждения";
  if (item.status === "pending" && item.last_error?.startsWith("Вне окна отправки")) return "Ждет окна отправки";
  if (item.status === "pending") return "В очереди";
  if (item.status === "retrying") return "Повтор после ошибки";
  if (item.status === "running") return "Отправляется";
  if (item.status === "sent") return "Отправлено";
  if (item.status === "failed") return "Ошибка";
  if (item.status === "cancelled") return "Отменено";
  return statusLabel(item.status) || "Неизвестно";
}

function queueNextAction(item) {
  if (item.requires_approval && !item.approved_at) {
    return {
      html: `<button class="small-button" data-approve="${item.id}">Подтвердить</button>`,
      text: "Проверь письмо и разреши отправку.",
    };
  }
  if (item.status === "pending" && item.last_error?.startsWith("Вне окна отправки")) {
    return { html: `<span class="muted">Ждет автоматически</span>`, text: "Ничего нажимать не нужно: отправится в ближайшее разрешенное окно." };
  }
  if (item.status === "pending") return { html: `<span class="muted">Ждет автоматически</span>`, text: "Ничего нажимать не нужно." };
  if (item.status === "retrying") return { html: `<span class="muted">Ждет повтор</span>`, text: "Сервис попробует отправить еще раз." };
  if (item.status === "failed") return { html: `<span class="muted">Смотри ошибку</span>`, text: "Проверь почту отправителя или текст ошибки." };
  return { html: `<span class="muted">Действий нет</span>`, text: "" };
}

function queueReasonText(item) {
  return queueStatusHint(item) || queueNextAction(item).text || "Письмо ждет обработки.";
}

function queueNeedsSending(item) {
  return ["pending", "retrying", "running"].includes(item.status);
}

function queueFilterLabel(value) {
  return {
    waiting: "Ожидает отправки",
    sent: "Отправлено",
    all: "Все",
  }[value] || "Ожидает отправки";
}

function queueSortRank(item) {
  if (item.requires_approval && !item.approved_at) return 0;
  if (item.status === "running") return 1;
  if (item.status === "retrying") return 2;
  if (item.status === "pending" && !item.last_error?.startsWith("Вне окна отправки")) return 3;
  if (item.status === "pending") return 4;
  if (item.status === "failed") return 5;
  if (item.status === "sent") return 6;
  if (item.status === "cancelled") return 7;
  return 8;
}

function queueGroupKey(item) {
  if (item.outreach_draft_id) return `draft:${item.outreach_draft_id}`;
  if (item.enrollment_id) return `enrollment:${item.enrollment_id}`;
  if (item.campaign_id) return `campaign:${item.campaign_id}:${item.lead_id}`;
  return `lead:${item.lead_id || item.email}`;
}

function queueStepTitle(item) {
  if (item.step_name) return item.step_name;
  if (item.outreach_step_position) return `Письмо ${item.outreach_step_position}`;
  return "Письмо";
}

function queueGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = queueGroupKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        company: item.company || item.email,
        email: item.email,
        campaignName: item.campaign_name || "Персональный импорт",
        mailboxEmail: item.mailbox_email || "",
        items: [],
        messages: [],
      });
    }
    const group = groups.get(key);
    group.items.push(item);
    for (const message of item.chain_messages || []) {
      if (!group.messages.some((existing) => existing.id === message.id)) group.messages.push(message);
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftItem = left.items[0] || {};
    const rightItem = right.items[0] || {};
    const rank = queueSortRank(leftItem) - queueSortRank(rightItem);
    if (rank !== 0) return rank;
    const leftDate = new Date(leftItem.scheduled_at || leftItem.sent_at || leftItem.updated_at || 0).getTime();
    const rightDate = new Date(rightItem.scheduled_at || rightItem.sent_at || rightItem.updated_at || 0).getTime();
    return leftDate - rightDate;
  });
}

function queueGroupStats(group) {
  return {
    sentMessages: group.messages.filter((message) => message.direction === "outbound" && message.status === "sent").length,
    replies: group.messages.filter((message) => message.direction === "inbound").length,
    waiting: group.items.filter(queueNeedsSending).length,
    failed: group.items.filter((item) => item.status === "failed").length,
  };
}

function queueGroupMainItem(group) {
  return group.items.find(queueNeedsSending) || group.items.find((item) => item.status === "failed") || group.items[0] || {};
}

function queueGroupStateLabel(group) {
  const main = queueGroupMainItem(group);
  const stats = queueGroupStats(group);
  if (stats.waiting > 0) return queueStateLabel(main);
  if (stats.failed > 0) return "Есть ошибка";
  if (stats.sentMessages > 0) return "Цепочка отправляется";
  return queueStateLabel(main);
}

function queueGroupReasonText(group) {
  const main = queueGroupMainItem(group);
  const stats = queueGroupStats(group);
  if (stats.waiting > 0 || stats.failed > 0) return queueReasonText(main);
  if (stats.replies > 0) return "Есть ответы в диалоге.";
  if (stats.sentMessages > 0) return "Отправленные письма видны внутри цепочки.";
  return queueReasonText(main);
}

function queueGroupTimeLabel(group) {
  return queueTimeLabel(queueGroupMainItem(group));
}

function queueEventTime(event) {
  return event.event_at || event.received_at || event.sent_at || event.scheduled_at || event.updated_at || event.created_at || "";
}

function queueChainEvents(group) {
  const messageEvents = group.messages.map((message) => ({ kind: "message", id: `message:${message.id}`, date: queueEventTime(message), message }));
  const queuedEvents = group.items
    .filter((item) => item.status !== "sent" || !item.sent_message_id)
    .map((item) => ({ kind: "queue", id: `queue:${item.id}`, date: queueEventTime(item), item }));
  return [...messageEvents, ...queuedEvents].sort((left, right) => new Date(left.date || 0).getTime() - new Date(right.date || 0).getTime());
}

function queueMessageStepLabel(message) {
  if (message.step_name) return message.step_name;
  if (message.outreach_step_position) return `Письмо ${message.outreach_step_position}`;
  return message.direction === "inbound" ? "Ответ" : "Письмо";
}

function queueTimelineEvent(event) {
  if (event.kind === "message") {
    const message = event.message;
    const inbound = message.direction === "inbound";
    const preview = String(message.body_text || "").replace(/\s+/g, " ").trim();
    return `
      <article class="queue-chain-event ${inbound ? "inbound" : "outbound"}">
        <div class="queue-chain-dot"></div>
        <div>
          <div class="queue-chain-head">
            <strong>${inbound ? "Ответ получателя" : "Отправленное письмо"}</strong>
            <span>${fmtDate(queueEventTime(message))}</span>
          </div>
          <p>${esc(queueMessageStepLabel(message))} · ${esc(message.subject || "Без темы")}</p>
          <span>${esc(message.mailbox_email || "")}${message.reply_classification ? ` · ${esc(statusLabel(message.reply_classification))}` : ""}</span>
          ${preview ? `<pre>${esc(preview.length > 420 ? `${preview.slice(0, 420)}...` : preview)}</pre>` : ""}
        </div>
      </article>
    `;
  }
  const item = event.item;
  return `
    <article class="queue-chain-event queued">
      <div class="queue-chain-dot"></div>
      <div>
        <div class="queue-chain-head">
          <strong>${esc(queueStateLabel(item))}</strong>
          <span>${queueTimeLabel(item).replace(/<[^>]+>/g, " ")}</span>
        </div>
        <p>${esc(queueStepTitle(item))}</p>
        <span>${esc(queueReasonText(item))}</span>
      </div>
    </article>
  `;
}

function renderQueueGroupDetails(group) {
  const events = queueChainEvents(group);
  return `
    <tr class="queue-chain-row">
      <td colspan="5">
        <div class="queue-chain">
          <div class="queue-chain-title">
            <strong>Цепочка писем</strong>
            <span>Отправленные письма, ожидающие шаги и ответы по этому контакту</span>
          </div>
          ${events.length
            ? events.map(queueTimelineEvent).join("")
            : `<p class="muted">По этой цепочке пока нет отправленных писем и ответов.</p>`}
        </div>
      </td>
    </tr>
  `;
}

function stepName(position) {
  const number = Number(position || 0);
  if (number <= 1) return "Первое письмо";
  return `Follow-up ${number - 1}`;
}

function launchEmptyHint(result) {
  const plan = result.launchPlan || {};
  if (Number(plan.active_enrollments || 0) === 0 && Number(plan.paused_enrollments || 0) > 0) {
    return "В очереди ничего нет, потому что в кампании нет активных лидов: они выключены. Открой шаг “Лиды” и нажми “Вернуть в отправку” у нужных лидов.";
  }
  if (Number(plan.missing_step_enrollments || 0) > 0) {
    return "В очереди ничего нет, потому что у активных лидов текущий шаг письма не найден. Проверь шаг 2 “Письмо” и проверку перед запуском.";
  }
  if (Number(plan.enrollments || 0) === 0) {
    return "В очереди ничего нет, потому что в кампанию еще не добавлены лиды.";
  }
  return "В очереди ничего не появилось. Проверь шаг 4 “Проверка”: там теперь будет конкретная причина.";
}

function eventLabel(value) {
  return EVENT_LABELS[value] || value || "";
}

function eventSummary(event) {
  const payload = event.payload || {};
  const parts = [];
  if (payload.email) parts.push(payload.email);
  if (payload.to) parts.push(`кому: ${payload.to}`);
  if (payload.from) parts.push(`от: ${payload.from}`);
  if (payload.subject) parts.push(`тема: ${payload.subject}`);
  if (payload.classification) parts.push(`класс: ${statusLabel(payload.classification)}`);
  if (payload.mode) parts.push(`режим: ${queueModeLabel(payload.mode)}`);
  if (payload.reason) parts.push(`причина: ${EVENT_REASON_LABELS[payload.reason] || payload.reason}`);
  if (payload.previousStatus) parts.push(`было: ${statusLabel(payload.previousStatus)}`);
  if (payload.nextStatus) parts.push(`стало: ${statusLabel(payload.nextStatus)}`);
  if (payload.nextAction) parts.push(`дальше: ${nextActionLabel(payload.nextAction)}`);
  if (payload.cancelledQueue !== undefined) parts.push(`отменено писем: ${payload.cancelledQueue}`);
  if (payload.approvedQueue !== undefined) parts.push(`разрешено писем: ${payload.approvedQueue}`);
  if (payload.heldQueue !== undefined) parts.push(`поставлено на ручное решение: ${payload.heldQueue}`);
  if (payload.affectedLeads !== undefined) parts.push(`затронуто лидов: ${payload.affectedLeads}`);
  if (payload.stopScope) parts.push(`охват: ${stopScopeLabel(payload.stopScope)}`);
  if (payload.delayedQueue !== undefined) parts.push(`перенесено писем: ${payload.delayedQueue}`);
  if (payload.delayDays !== undefined) parts.push(`на дней: ${payload.delayDays}`);
  if (payload.nextScheduledAt) parts.push(`следующая отправка: ${fmtDate(payload.nextScheduledAt)}`);
  if (payload.recoveredJobs !== undefined) parts.push(`job_queue повторно: ${payload.recoveredJobs}`);
  if (payload.failedJobs !== undefined) parts.push(`job_queue ошибок: ${payload.failedJobs}`);
  if (payload.recoveredSends !== undefined) parts.push(`отправок повторно: ${payload.recoveredSends}`);
  if (payload.failedSends !== undefined) parts.push(`отправок ошибок: ${payload.failedSends}`);
  if (payload.queued !== undefined) parts.push(`поставлено задач: ${payload.queued}`);
  if (payload.attempts !== undefined) parts.push(`попытка: ${payload.attempts}`);
  if (payload.checked !== undefined) parts.push(`проверено непривязанных входящих: ${payload.checked}`);
  if (payload.scanned !== undefined) parts.push(`проверено писем: ${payload.scanned}`);
  if (payload.inserted !== undefined) parts.push(`новых входящих: ${payload.inserted}`);
  if (payload.linked !== undefined) parts.push(`привязано к цепочкам: ${payload.linked}`);
  if (payload.relinked !== undefined) parts.push(`привязано повторно: ${payload.relinked}`);
  if (payload.unlinked !== undefined) parts.push(`без связи: ${payload.unlinked}`);
  if (payload.duplicates !== undefined) parts.push(`уже были в базе: ${payload.duplicates}`);
  if (payload.errorCount !== undefined) parts.push(`ошибок подряд: ${payload.errorCount}`);
  if (payload.throttleMinutes !== undefined && payload.throttleMinutes > 0) parts.push(`пауза: ${payload.throttleMinutes} мин`);
  if (payload.pausedUntil) parts.push(`замедлен до: ${fmtDate(payload.pausedUntil)}`);
  if (payload.error) parts.push(`ошибка: ${payload.error}`);
  if (payload.dryRun !== undefined) parts.push(`безопасный режим: ${payload.dryRun ? "да" : "нет"}`);
  if (payload.provider) parts.push(`провайдер: ${payload.provider}`);
  if (payload.status) parts.push(`статус: ${statusLabel(payload.status)}`);
  return parts.join(" · ") || "Подробности доступны в деталях.";
}

function stopScopeLabel(value) {
  return {
    contact_only: "только этот email",
    same_domain: "весь домен",
    same_company: "вся компания",
  }[value] || value || "";
}

function pill(value) {
  const cls = ["failed", "invalid", "bounced", "error"].includes(value) ? "bad" : ["pending", "risky", "retrying", "throttled"].includes(value) ? "warn" : "";
  return `<span class="pill ${cls}">${esc(statusLabel(value))}</span>`;
}

function preflightErrorHelp(error = "") {
  if (error.includes("SMTP/IMAP")) {
    return {
      text: "Я уже попробовал перепроверить этот ящик автоматически. Если ошибка осталась, открой раздел “Почта” и проверь host, port, SSL/STARTTLS, логин и пароль.",
      action: "Открыть почту",
      view: "mailboxes",
    };
  }
  if (error.includes("Tracking URL")) {
    return {
      text: "Если сервис не смог выключить отслеживание, открой настройки кампании и отключи отслеживание открытий либо задай публичный URL.",
      action: "Открыть кампанию",
      view: "campaigns",
    };
  }
  if (error.includes("пустые переменные")) {
    return {
      text: "Заполни недостающие поля у лида или убери эту переменную из темы/текста письма.",
      action: "Открыть базу",
      view: "leads",
    };
  }
  if (error.includes("нет проверки MX/SPF/DKIM/DMARC") || error.includes("_status")) {
    return {
      text: "Нужно заново проверить ящик, чтобы сервис обновил DNS-проверку домена.",
      action: "Открыть почту",
      view: "mailboxes",
    };
  }
  if (error.includes("Нет лидов")) {
    return {
      text: "Добавь подходящих лидов в кампанию на шаге 3.",
      action: "Открыть лидов кампании",
      view: "campaigns",
    };
  }
  return {
    text: "Эту проблему нужно закрыть вручную, потому что автоматическое исправление может изменить данные кампании.",
    action: "Открыть рассылку",
    view: "campaigns",
  };
}

function renderPreflightResult(result, fixResult = null) {
  if (!result) return "";
  const fixes = fixResult?.fixes || [];
  const fixed = fixes.filter((item) => item.status === "fixed");
  const needsUser = fixes.filter((item) => item.status === "needs_user");
  const errors = result.errors || [];
  const warnings = result.warnings || [];
  const stats = result.stats || {};
  return `
    <div class="preflight-card ${result.ok ? "success" : "error"}">
      <div class="preflight-head">
        <div>
          <strong>${result.ok ? "Кампания готова к запуску" : "Запуск пока заблокирован"}</strong>
          <p>${result.ok
            ? "Критичных ошибок нет. Можно переходить к тестовой отправке или запуску."
            : `Осталось ошибок: ${errors.length}. Ниже видно, что сервис уже попробовал исправить сам.`}</p>
        </div>
        <div class="preflight-stats">
          <span>Лидов: ${Number(stats.enrollments || 0)}</span>
          <span>Можно отправлять: ${Number(stats.valid || 0)}</span>
          <span>Нужна проверка: ${Number(stats.risky || 0)}</span>
          <span>Ящиков: ${Number(stats.mailboxes || 0)}</span>
        </div>
      </div>
      ${fixes.length ? `
        <div class="preflight-block">
          <h3>Что сделано автоматически</h3>
          <ul>
            ${fixes.map((item) => `
              <li class="${item.status === "fixed" ? "ok" : "warn"}">
                <strong>${item.status === "fixed" ? "Исправлено" : "Нужно проверить"}:</strong> ${esc(item.message)}
              </li>
            `).join("")}
          </ul>
        </div>
      ` : `
        <div class="preflight-block">
          <h3>Автоисправления</h3>
          <p>Безопасных автоматических исправлений не понадобилось.</p>
        </div>
      `}
      ${errors.length ? `
        <div class="preflight-block">
          <h3>Что осталось закрыть</h3>
          ${errors.map((error) => {
            const help = preflightErrorHelp(error);
            return `
              <article class="preflight-issue">
                <strong>${esc(error)}</strong>
                <p>${esc(help.text)}</p>
                <button data-go="${esc(help.view)}">${esc(help.action)}</button>
              </article>
            `;
          }).join("")}
        </div>
      ` : ""}
      ${warnings.length ? `
        <div class="preflight-block">
          <h3>Предупреждения</h3>
          <ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>
        </div>
      ` : ""}
      <details class="preflight-details">
        <summary>Технические детали</summary>
        <pre>${esc(JSON.stringify({ autofix: { fixed: fixed.length, needsUser: needsUser.length, items: fixes }, preflight: result }, null, 2))}</pre>
      </details>
    </div>
  `;
}

function mailboxNextStep(mailbox) {
  const isPaused = mailbox.paused_until && new Date(mailbox.paused_until) > new Date();
  if (isPaused) {
    return `Ящик временно замедлен из-за ошибок отправки. Следующая попытка после ${fmtDate(mailbox.paused_until)}.`;
  }
  if (!mailbox.smtp_verified_at || !mailbox.imap_verified_at) {
    return "Следующий шаг: нажми «Проверить SMTP/IMAP». Это проверит отправку, чтение входящих и DNS домена.";
  }
  if (!mailbox.last_inbox_sync_at) {
    return "Доступы проверены. Теперь можно нажать «Синхронизировать входящие», чтобы забрать новые письма из INBOX.";
  }
  if (!mailbox.warmup_enabled) {
    return "Ящик готов. Если это один из твоих двух ящиков для теста, включи прогрев.";
  }
  return "Ящик готов: SMTP/IMAP проверены, входящие синхронизировались, прогрев включен.";
}

function sendDaysCheckboxes(selectedDays = []) {
  const selected = new Set((selectedDays || []).map(Number));
  return [
    [1, "Пн"],
    [2, "Вт"],
    [3, "Ср"],
    [4, "Чт"],
    [5, "Пт"],
    [6, "Сб"],
    [7, "Вс"],
  ].map(([value, label]) => (
    `<label class="check"><input name="send_days" type="checkbox" value="${value}" ${selected.has(value) ? "checked" : ""} /> ${label}</label>`
  )).join("");
}

function normalizeView(view) {
  return VALID_VIEWS.has(view) ? view : "start";
}

function viewFromLocation() {
  const hashView = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
  return normalizeView(hashView || window.localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY) || "start");
}

function rememberView(view, { updateUrl = true } = {}) {
  window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view);
  if (updateUrl && window.location.hash !== `#${view}`) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${view}`);
  }
}

function switchView(view, options = {}) {
  const nextView = normalizeView(view);
  $$(".view").forEach((node) => node.classList.remove("active"));
  $(`#${nextView}View`).classList.add("active");
  $$("nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === nextView));
  $("#title").textContent = VIEW_TITLES[nextView];
  rememberView(nextView, options);
}

function switchCampaignStep(step) {
  state.campaignStep = step;
  $$("[data-campaign-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.campaignPanel === step));
  $$("[data-campaign-step]").forEach((button) => button.classList.toggle("active", button.dataset.campaignStep === step));
}

async function loadHealth() {
  const health = await api("/api/health");
  state.health = health;
  $("#health").textContent = `OK · режим: ${health.dryRun ? "безопасный" : "реальная отправка"} · открытия: ${health.publicTrackingUrl ? "включены" : "выключены"}`;
  const runtimeModeText = $("#runtimeModeText");
  if (runtimeModeText) {
    runtimeModeText.textContent = health.dryRun
      ? "Сейчас включен безопасный режим: сервис все покажет в интерфейсе, но реальные письма наружу не отправит."
      : "Сейчас включена реальная отправка: SMTP/IMAP и отправка писем будут выполняться по-настоящему.";
  }
}

async function loadEnvCheck() {
  state.envCheck = await api("/api/env-check");
  renderEnvChecklist();
}

function envItem({ key, configured, value, secret }) {
  const status = configured ? "задано" : "не задано";
  return `
    <article class="env-item ${configured ? "done" : ""}">
      <div>
        <strong>${esc(key)}</strong>
        <p>${secret ? "секретное значение скрыто" : value ? `текущее значение: ${esc(value)}` : "можно оставить пустым до реального запуска"}</p>
      </div>
      ${pill(status)}
    </article>
  `;
}

function renderEnvChecklist() {
  if (!state.envCheck || !$("#envChecklist")) return;
  const mailboxItems = state.envCheck.mailboxSecrets.map((item) => ({
    key: item.key,
    configured: item.configured,
    secret: true,
    value: "",
  }));
  $("#envChecklist").innerHTML = `
    <div class="env-grid">
      <section>
        <h3>Обязательное</h3>
        <div class="cards">${state.envCheck.required.map(envItem).join("")}</div>
      </section>
      <section>
        <h3>Пароли почты</h3>
        <div class="cards">${mailboxItems.map(envItem).join("")}</div>
      </section>
      <section>
        <h3>Желательно</h3>
        <div class="cards">${state.envCheck.recommended.map(envItem).join("")}</div>
      </section>
      <section>
        <h3>Шаблон для .env</h3>
        <pre class="env-template">${esc(state.envCheck.template)}</pre>
        <p class="muted">После изменения .env выполни: docker compose up -d --force-recreate web worker</p>
      </section>
    </div>
  `;
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  state.dashboard = data;
  const metrics = [
    ["Импортировано строк", data.outreach.imported_rows, "Excel/CSV для персонального аутрича"],
    ["Готово черновиков", data.outreach.drafts_ready, "можно ставить в очередь"],
    ["Нужно исправить", data.outreach.drafts_blocked, "ошибки email, темы или текста"],
    ["Первые письма", data.outreach.sent_first, "отправлено без прогрева и тестов"],
    ["Follow-up", data.outreach.sent_followups, "отправленные следующие касания"],
    ["Ответили", data.outreach.replied_dialogs, `уникальные диалоги · ${data.rates.outreachReplyRate}%`],
    ["Позитивные", data.outreach.positive_replies, `доля позитивных · ${data.rates.positiveReplyRate}%`],
    ["Требуют решения", data.outreach.review_needed, "после входящего ответа"],
  ];
  $("#metrics").innerHTML = metrics
    .map(([label, value, hint]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${hint}</small></div>`)
    .join("");
  $("#queueSummary").innerHTML = `
    <p>Ждут отправки: <strong>${data.queue.pending}</strong></p>
    <p>Отправлены из очереди: <strong>${data.queue.sent}</strong></p>
    <p>Ошибки отправки: <strong>${data.queue.failed}</strong></p>
    <p>Активные цепочки: <strong>${data.outreach.drafts_active}</strong></p>
  `;
  $("#kpi").innerHTML = `
    <p>Все открытия: <strong>${data.opens.raw}</strong></p>
    <p>Уникальные открытия: <strong>${data.opens.unique}</strong></p>
    <p>Диалогов с ответом: <strong>${data.outreach.replied_dialogs}</strong></p>
    <p>Позитивные ответы: <strong>${data.outreach.positive_replies}</strong></p>
    <p>Негативные ответы: <strong>${data.outreach.negative_replies}</strong></p>
    <p>Автоответы: <strong>${data.outreach.auto_replies}</strong></p>
    <p>Отписки: <strong>${data.outreach.unsubscribes}</strong></p>
    <p>Недоставки: <strong>${data.outreach.bounces}</strong></p>
    <p>Среднее время до ответа: <strong>${data.outreach.avg_hours_to_reply} ч</strong></p>
    <p>Доля ответивших: <strong>${data.rates.outreachReplyRate}%</strong></p>
    <p>Доля позитивных ответов: <strong>${data.rates.positiveReplyRate}%</strong></p>
    <p class="muted">Метрики считаются по outreach, без прогрева и тестовых писем.</p>
  `;
  $("#stepPerformanceTable").innerHTML = `
    <thead>
      <tr>
        <th>Шаг</th>
        <th>Отправлено</th>
        <th>Открытия</th>
        <th>Ответы</th>
        <th>Позитив</th>
        <th>Негатив</th>
        <th>Автоответы</th>
        <th>Недоставки</th>
        <th>Остановки</th>
        <th>Время до ответа</th>
      </tr>
    </thead>
    <tbody>
      ${data.stepPerformance?.length
        ? data.stepPerformance.map((step) => `
          <tr>
            <td><strong>${esc(stepName(step.position))}</strong><br><span class="muted">шаг ${step.position}</span></td>
            <td>${step.sent}<br><span class="muted">${step.contacts} контактов</span></td>
            <td>${step.unique_opens}<br><span class="muted">${step.open_rate}%</span></td>
            <td>${step.replied_dialogs}<br><span class="muted">${step.reply_rate}%</span></td>
            <td>${step.positive_replies}<br><span class="muted">${step.positive_rate}%</span></td>
            <td>${step.negative_replies}</td>
            <td>${step.auto_replies}</td>
            <td>${step.bounces}</td>
            <td>${step.stopped_after_step}</td>
            <td>${step.avg_hours_to_reply ? `${step.avg_hours_to_reply} ч` : "нет данных"}</td>
          </tr>
        `).join("")
        : `<tr><td colspan="10" class="muted">Пока нет отправленных outreach-писем по шагам. После отправки первого письма или follow-up здесь появится статистика.</td></tr>`}
    </tbody>
  `;
  renderSetupChecklist();
}

async function loadLeads() {
  const search = encodeURIComponent($("#leadSearch")?.value || "");
  const validationValue = state.leadQuickFilter === "custom" ? ($("#leadValidationFilter")?.value || "") : "";
  const validation = encodeURIComponent(validationValue);
  const segment = encodeURIComponent($("#leadSegmentFilter")?.value || "");
  try {
    state.leads = await api(`/api/leads?search=${search}&validation=${validation}&segment=${segment}`);
  } catch (error) {
    $("#leadsTable").innerHTML = `
      <thead><tr><th>База лидов</th></tr></thead>
      <tbody><tr><td class="muted">Не удалось загрузить лидов: ${esc(errorMessage(error))}</td></tr></tbody>
    `;
    throw error;
  }
  const visibleLeads = leadVisibleItems();
  const readyCount = state.leads.filter(leadReadyForSend).length;
  const reviewCount = state.leads.filter(leadNeedsReview).length;
  const blockedCount = state.leads.filter(leadBlocked).length;
  const segmentCount = new Set(state.leads.map((lead) => lead.segment).filter(Boolean)).size;
  $("#leadsSummary").innerHTML = `
    <span>Найдено: <strong>${state.leads.length}</strong></span>
    <span>Готовы к отправке: <strong>${readyCount}</strong></span>
    <span>Нужно проверить: <strong>${reviewCount}</strong></span>
    <span>Не отправлять: <strong>${blockedCount}</strong></span>
    <span>Сегментов: <strong>${segmentCount}</strong></span>
    <span>Показано: <strong>${esc(leadQuickFilterLabel(state.leadQuickFilter).toLowerCase())}</strong></span>
  `;
  $("#leadsTable").innerHTML = `
    <thead><tr><th>Лид</th><th>Готовность</th><th>Контекст</th><th>Что делать</th></tr></thead>
    <tbody>
      ${visibleLeads.length
        ? visibleLeads
        .map(
          (lead) => `
            <tr class="lead-row" data-lead-id="${lead.id}">
              <td>
                <div class="lead-main">
                  <strong>${esc(lead.company || lead.email)}</strong>
                  <span>${esc(lead.email)}</span>
                  <em>${esc([lead.contact_name, lead.position].filter(Boolean).join(" · ") || "Контакт не указан")}</em>
                </div>
              </td>
              <td>
                <div class="lead-readiness">
                  <span>${pill(lead.validation_status || "unknown")} ${pill(lead.status)}</span>
                  <em>${esc(validationReasonText(lead.validation_reason) || "Проверку еще не запускали")}</em>
                </div>
              </td>
              <td>
                <div class="lead-context">
                  <strong>${esc(lead.segment || "Без сегмента")}</strong>
                  <span>${esc(leadContextText(lead))}</span>
                </div>
              </td>
              <td>
                <div class="lead-next">
                  <strong>${esc(leadActionText(lead))}</strong>
                  <span>Клик по строке откроет карточку лида.</span>
                </div>
              </td>
            </tr>
          `,
        )
        .join("")
        : `<tr><td colspan="4" class="muted">По фильтру “${esc(leadQuickFilterLabel(state.leadQuickFilter))}” лидов нет. Добавь лида, импортируй CSV или сбрось фильтры.</td></tr>`}
    </tbody>
  `;
  $$("[data-lead-quick-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.leadQuickFilter === state.leadQuickFilter);
  });
}

async function loadOutreachImports() {
  if (!$("#outreachImportsTable")) return;
  state.outreachImports = await api("/api/outreach/imports");
  renderAiExportFilters();
  $("#outreachImportsTable").innerHTML = `
    <thead><tr><th>Файл</th><th>Тип</th><th>Строки</th><th>Готово</th><th>Исправить</th><th>Когда</th><th>Отчет</th></tr></thead>
    <tbody>
      ${state.outreachImports.length
        ? state.outreachImports.map((item) => `
          <tr>
            <td><strong>${esc(item.file_name)}</strong></td>
            <td>${esc(String(item.file_type || "").toUpperCase())}</td>
            <td>${item.rows_total}</td>
            <td>${pill("ready")} ${item.rows_ready}</td>
            <td>${item.rows_blocked ? `${pill("blocked")} ${item.rows_blocked}` : "0"}</td>
            <td>${fmtDate(item.created_at)}</td>
            <td>${item.rows_blocked ? `<a class="button small-button" href="/api/outreach/imports/${item.id}/errors.csv">CSV ошибок</a>` : `<span class="muted">Ошибок нет</span>`}</td>
          </tr>
        `).join("")
        : `<tr><td colspan="7" class="muted">Импортов пока нет. Загрузи Excel/CSV с колонками email, subject и body.</td></tr>`}
    </tbody>
  `;
}

function renderOutreachImportPreview() {
  const preview = state.outreachImportPreview;
  if (!preview) return;
  $("#outreachImportPreview").hidden = false;
  const blocked = preview.errors.filter((item) => item.status === "blocked").length;
  const ready = Math.max(Number(preview.rowsTotal || 0) - blocked, 0);
  $("#outreachPreviewSummary").innerHTML = `
    <span>Файл: <strong>${esc(preview.fileName)}</strong></span>
    <span>Строк: <strong>${preview.rowsTotal}</strong></span>
    <span>Готовы к черновикам: <strong>${ready}</strong></span>
    <span>Нужно исправить: <strong>${blocked}</strong></span>
    <span>Файл читается по шаблону автоматически.</span>
  `;
  $("#outreachPreviewTable").innerHTML = `
    <thead><tr><th>Строка</th><th>Email</th><th>Компания</th><th>Тема</th><th>Текст</th><th>Статус</th></tr></thead>
    <tbody>
      ${preview.preview.length
        ? preview.preview.map((row) => {
          const issue = preview.errors.find((item) => item.row === row.source_row_number);
          return `
            <tr>
              <td>${row.source_row_number}</td>
              <td>${esc(row.email)}</td>
              <td>${esc(row.company)}</td>
              <td>${esc(row.subject)}</td>
              <td>${esc((row.body || "").slice(0, 160))}${row.body && row.body.length > 160 ? "..." : ""}</td>
              <td>${pill(issue?.status || "ready")}<br><span class="muted">${esc((issue?.errors || []).join("; "))}</span></td>
            </tr>
          `;
        }).join("")
        : `<tr><td colspan="6" class="muted">В файле не найдено строк для импорта.</td></tr>`}
    </tbody>
  `;
  $("#createOutreachDraftsBtn").disabled = false;
}

function selectedOutreachDraftSignature(draftIds = [...state.selectedOutreachDraftIds]) {
  return [...draftIds].sort().join("|");
}

function outreachDraftFilterLabel(value = state.outreachDraftFilter) {
  return {
    ready: "готовы к старту",
    active: "в процессе",
    blocked: "нужно исправить",
    all: "все",
  }[value] || "все";
}

function visibleOutreachDrafts(drafts = state.allOutreachDrafts) {
  if (state.outreachDraftFilter === "ready") return drafts.filter((draft) => draft.status === "ready");
  if (state.outreachDraftFilter === "active") return drafts.filter((draft) => ["queued", "active_sequence"].includes(draft.status));
  if (state.outreachDraftFilter === "blocked") return drafts.filter((draft) => draft.status === "blocked");
  return drafts;
}

function canDeleteOutreachDraft(draft) {
  return ["draft", "ready", "blocked", "cancelled"].includes(draft.status);
}

function syncSelectedOutreachDraftIdsFromDom() {
  const checkedIds = $$("[data-outreach-draft-select]:checked").map((input) => input.dataset.outreachDraftSelect);
  if (checkedIds.length || $("#outreachDraftsTable")) {
    state.selectedOutreachDraftIds = new Set(checkedIds);
  }
  return state.selectedOutreachDraftIds;
}

function outreachDraftSelectionStats() {
  const selected = syncSelectedOutreachDraftIdsFromDom();
  const selectedDrafts = state.outreachDrafts.filter((draft) => selected.has(draft.id));
  return {
    selectedDrafts,
    selectedCount: selectedDrafts.length,
    readyDrafts: selectedDrafts.filter((draft) => draft.status === "ready"),
    deletableDrafts: selectedDrafts.filter(canDeleteOutreachDraft),
    selectedStatusLabels: [...new Set(selectedDrafts.map((draft) => statusLabel(draft.status)))],
  };
}

function selectedReadyOutreachDraftIds() {
  return outreachDraftSelectionStats().readyDrafts.map((draft) => draft.id);
}

function selectedDeletableOutreachDraftIds() {
  return outreachDraftSelectionStats().deletableDrafts.map((draft) => draft.id);
}

function selectedReadyWarningMessage(action) {
  const stats = outreachDraftSelectionStats();
  if (!stats.selectedCount) return `Сначала отметь черновики галочками, потом нажми “${action}”.`;
  return `Выбрано: ${stats.selectedCount}. Готовых к запуску: ${stats.readyDrafts.length}. Сейчас выбраны статусы: ${stats.selectedStatusLabels.join(", ") || "нет"}. Запускать можно только черновики со статусом “готово”; остальные нужно исправить, удалить или остановить.`;
}

function clearOutreachDraftLaunchReview() {
  state.outreachDraftLaunchReview = null;
  $("#outreachDraftLaunchReview").hidden = true;
  $("#outreachDraftLaunchSummary").innerHTML = "";
  $("#outreachDraftLaunchTable").innerHTML = "";
}

function renderOutreachDraftLaunchReview() {
  const review = state.outreachDraftLaunchReview;
  if (!review) {
    clearOutreachDraftLaunchReview();
    return;
  }
  $("#outreachDraftLaunchReview").hidden = false;
  $("#outreachDraftLaunchSummary").innerHTML = `
    <span>Выбрано: <strong>${review.stats.selected}</strong></span>
    <span>Можно запускать: <strong>${review.ok ? "да" : "нет"}</strong></span>
    <span>Ошибок: <strong>${review.errors.length}</strong></span>
    <span>Предупреждений: <strong>${review.warnings.length}</strong></span>
    ${(review.imapUncheckedMailboxes || []).length ? `<span>Ответы: <strong>IMAP-проверка запущена автоматически</strong></span>` : ""}
  `;
  $("#outreachDraftLaunchTable").innerHTML = `
    <thead><tr><th>Статус</th><th>Получатель</th><th>Письмо</th><th>Почта отправителя</th><th>Когда</th><th>Что проверить</th></tr></thead>
    <tbody>
      ${(review.items || []).length
        ? review.items.map((item) => `
          <tr>
            <td>${pill(item.status)}</td>
            <td><strong>${esc(item.email)}</strong><br><span class="muted">${esc(item.company || "Без компании")} ${item.contact_name ? `· ${esc(item.contact_name)}` : ""}</span></td>
            <td><strong>${esc(item.subject || "Без темы")}</strong><br><span class="muted">${esc(item.body_preview || "")}${item.body_preview && item.body_preview.length >= 180 ? "..." : ""}</span><br><span class="muted">Follow-up: ${Number(item.followup_count || 0)}</span></td>
            <td>${esc(item.mailbox || "нет готовой почты")}</td>
            <td>${item.scheduled_at ? fmtDate(item.scheduled_at) : "при ближайшем запуске"}</td>
            <td>
              ${item.errors.length ? `<strong>${esc(item.errors.join("; "))}</strong>` : "<span>Можно запускать</span>"}
              ${item.warnings.length ? `<br><span class="muted">${esc(item.warnings.join("; "))}</span>` : ""}
            </td>
          </tr>
        `).join("")
        : `<tr><td colspan="6" class="muted">Выбранные черновики не найдены.</td></tr>`}
    </tbody>
  `;
}

function outreachDraftMailboxOptions(selectedId) {
  return [
    `<option value="">Выбрать автоматически</option>`,
    ...state.mailboxes
      .filter((mailbox) => mailbox.is_active)
      .map((mailbox) => `<option value="${mailbox.id}" ${mailbox.id === selectedId ? "selected" : ""}>${esc(mailbox.email)}</option>`),
  ].join("");
}

function outreachDraftStepForm(draft, position, { isNew = false } = {}) {
  const stepByPosition = new Map((draft.steps || []).map((step) => [Number(step.position), step]));
  const step = stepByPosition.get(position) || {};
  const defaultDelay = position === 2 ? 3 : position === 3 ? 4 : 5;
  return `
    <form class="form outreach-step-edit-form" data-outreach-step-form="${draft.id}" data-position="${position}">
      <div class="form-section-title">${isNew ? "Новый " : ""}Follow-up ${position - 1}</div>
      <label class="field">
        <span>Тема follow-up</span>
        <input name="subject" value="${esc(step.subject || "")}" placeholder="Если оставить пустым, будет тема первого письма" />
        <small class="field-help">Заполняй только если у этого шага должна быть отдельная тема.</small>
      </label>
      <label class="field">
        <span>Текст follow-up</span>
        <textarea name="body_text" placeholder="Напиши короткое продолжение диалога. Если оставить пустым, этот шаг удалится.">${esc(step.body_text || "")}</textarea>
        <small class="field-help">Если лид ответит, следующие письма цепочки остановятся и уйдут на ручное решение.</small>
      </label>
      <label class="field">
        <span>Через сколько дней отправить</span>
        <input name="delay_days" type="number" min="0" step="1" value="${step.delay_days ?? defaultDelay}" placeholder="Например: ${defaultDelay}" />
        <small class="field-help">Считается от предыдущего письма в этой цепочке.</small>
      </label>
      <div class="form-actions">
        <button ${step.status === "sent" ? "disabled" : ""}>Сохранить follow-up</button>
        ${step.status ? `<span class="muted">${esc(statusLabel(step.status))}</span>` : ""}
      </div>
    </form>
  `;
}

function renderOutreachDraftFollowups(draft) {
  const positions = new Set((draft.steps || [])
    .map((step) => Number(step.position))
    .filter((position) => position > 1));
  const existingForms = [...positions]
    .sort((left, right) => left - right)
    .map((position) => outreachDraftStepForm(draft, position))
    .join("");
  const nextPosition = [2, 3, 4].find((position) => !positions.has(position));
  const addForm = nextPosition
    ? `
      <details class="add-followup-card">
        <summary>Добавить follow-up ${nextPosition - 1}</summary>
        ${outreachDraftStepForm(draft, nextPosition, { isNew: true })}
      </details>
    `
    : `<p class="muted">Все 3 follow-up уже добавлены.</p>`;

  return `
    ${existingForms || `<p class="muted">В этом черновике follow-up еще не добавлены.</p>`}
    ${addForm}
  `;
}

function renderOutreachDraftDrawer(draft) {
  $("#outreachDraftDrawerTitle").textContent = `${draft.company || "Без компании"} · ${draft.to_email}`;
  $("#outreachDraftDrawerBody").innerHTML = `
    <section class="drawer-section">
      <h3>Основное письмо</h3>
      <form class="form outreach-draft-edit-form" data-outreach-draft-form="${draft.id}">
        <label class="field">
          <span>Email получателя</span>
          <input name="to_email" type="email" value="${esc(draft.to_email)}" placeholder="Например: ivan@company.ru — адрес, куда уйдет письмо" required />
          <small class="field-help">Главный адрес лида. По нему будет создана цепочка и история переписки.</small>
        </label>
        <label class="field">
          <span>Компания</span>
          <input name="company" value="${esc(draft.company || "")}" placeholder="Например: Студия мебели “Север”" />
          <small class="field-help">Название компании для поиска, фильтров и переменных в письме.</small>
        </label>
        <label class="field">
          <span>Контакт</span>
          <input name="contact_name" value="${esc(draft.contact_name || "")}" placeholder="Например: Иван Петров" />
          <small class="field-help">Имя человека, если письмо персонализировано под конкретного получателя.</small>
        </label>
        <label class="field">
          <span>Сегмент</span>
          <input name="segment" value="${esc(draft.segment || "")}" placeholder="Например: рестораны, мебель, B2B SaaS" />
          <small class="field-help">Помогает потом фильтровать отправки и анализировать ответы по нишам.</small>
        </label>
        <label class="field">
          <span>Почта отправителя</span>
          <select name="mailbox_id">${outreachDraftMailboxOptions(draft.mailbox_id)}</select>
          <small class="field-help">Можно выбрать конкретный ящик или оставить автоматический выбор активного mailbox.</small>
        </label>
        <label class="field">
          <span>Тема письма</span>
          <input name="subject" value="${esc(draft.subject)}" placeholder="Например: короткий вопрос по заявкам с сайта" required />
          <small class="field-help">То, что получатель увидит в теме входящего письма.</small>
        </label>
        <label class="field">
          <span>Текст письма</span>
          <textarea name="body_text" placeholder="Вставь персональное письмо из Excel. Можно использовать обычный текст без HTML." required>${esc(draft.body_text)}</textarea>
          <small class="field-help">Это первое письмо цепочки. Ответы по нему будут собираться в историю диалога.</small>
        </label>
        <label class="field">
          <span>Отправить не раньше</span>
          <input name="send_after" type="datetime-local" value="${draft.send_after ? new Date(draft.send_after).toISOString().slice(0, 16) : ""}" placeholder="Оставь пустым, если можно отправлять сразу" />
          <small class="field-help">Пустое поле означает, что письмо можно ставить в очередь сразу после запуска.</small>
        </label>
        <div class="form-actions">
          <button>Сохранить основное письмо</button>
          ${draft.status ? pill(draft.status) : ""}
        </div>
      </form>
    </section>
    <section class="drawer-section">
      <h3>Цепочка follow-up</h3>
      <p class="muted">Здесь показаны только follow-up, которые реально есть в черновике. Новый шаг добавляется отдельной кнопкой.</p>
      <div class="draft-followups">
        ${renderOutreachDraftFollowups(draft)}
      </div>
    </section>
  `;
}

function openOutreachDraftDrawer(draftId) {
  const draft = state.outreachDrafts.find((item) => item.id === draftId);
  if (!draft) {
    setActionResult({
      status: "warn",
      title: "Редактирование черновика",
      message: "Черновик не найден в текущем списке. Обнови список или сбрось фильтр статуса.",
    });
    return;
  }
  state.openOutreachDraftId = draftId;
  renderOutreachDraftDrawer(draft);
  const drawer = $("#outreachDraftDrawer");
  if (!drawer.open) drawer.showModal();
}

function refreshOpenOutreachDraftDrawer(draftId) {
  const drawer = $("#outreachDraftDrawer");
  if (!drawer?.open || state.openOutreachDraftId !== draftId) return;
  const fresh = state.outreachDrafts.find((item) => item.id === draftId);
  if (fresh) {
    renderOutreachDraftDrawer(fresh);
  } else {
    state.openOutreachDraftId = null;
    drawer.close();
  }
}

async function loadOutreachDrafts() {
  if (!$("#outreachDraftsTable")) return;
  if (!state.mailboxes.length) {
    state.mailboxes = await api("/api/mailboxes");
  }
  state.allOutreachDrafts = await api("/api/outreach/drafts");
  state.outreachDrafts = visibleOutreachDrafts();
  const visibleIds = new Set(state.outreachDrafts.map((draft) => draft.id));
  const previousSignature = selectedOutreachDraftSignature();
  state.selectedOutreachDraftIds = new Set([...state.selectedOutreachDraftIds].filter((id) => visibleIds.has(id)));
  if (state.outreachDraftLaunchReview && previousSignature !== selectedOutreachDraftSignature()) {
    clearOutreachDraftLaunchReview();
  }
  const ready = state.allOutreachDrafts.filter((draft) => draft.status === "ready").length;
  const active = state.allOutreachDrafts.filter((draft) => ["queued", "active_sequence"].includes(draft.status)).length;
  const blocked = state.allOutreachDrafts.filter((draft) => draft.status === "blocked").length;
  const deletable = state.outreachDrafts.filter(canDeleteOutreachDraft).length;
  const deletableSelected = state.outreachDrafts
    .filter((draft) => canDeleteOutreachDraft(draft) && state.selectedOutreachDraftIds.has(draft.id))
    .length;
  $("#outreachDraftsSummary").innerHTML = `
    <span>Всего на экране: <strong>${state.outreachDrafts.length}</strong></span>
    <span>Показано: <strong>${esc(outreachDraftFilterLabel())}</strong></span>
    <span>Готовы: <strong>${ready}</strong></span>
    <span>В процессе: <strong>${active}</strong></span>
    <span>Нужно исправить: <strong>${blocked}</strong></span>
    <span>Выбрано: <strong>${state.selectedOutreachDraftIds.size}</strong></span>
  `;
  $$("[data-outreach-draft-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.outreachDraftFilter === state.outreachDraftFilter);
  });
  $("#outreachDraftsTable").innerHTML = `
    <colgroup>
      <col class="draft-col-check" />
      <col class="draft-col-status" />
      <col class="draft-col-recipient" />
      <col class="draft-col-message" />
      <col class="draft-col-mailbox" />
      <col class="draft-col-actions" />
    </colgroup>
    <thead><tr><th><input id="outreachDraftSelectAll" class="compact-check" type="checkbox" ${deletable && deletableSelected === deletable ? "checked" : ""} /></th><th>Статус</th><th>Получатель</th><th>Письмо</th><th>Отправитель</th><th>Действия</th></tr></thead>
    <tbody>
      ${state.outreachDrafts.length
        ? state.outreachDrafts.map((draft) => {
          const canDelete = canDeleteOutreachDraft(draft);
          const followups = (draft.steps || []).filter((step) => Number(step.position) > 1);
          return `
          <tr class="draft-row">
            <td class="draft-check"><input class="compact-check" type="checkbox" data-outreach-draft-select="${draft.id}" ${canDelete ? "" : "disabled"} ${state.selectedOutreachDraftIds.has(draft.id) ? "checked" : ""} /></td>
            <td class="draft-status">${pill(draft.status)}<span>строка ${draft.source_row_number}</span></td>
            <td>
              <div class="draft-recipient">
                <strong>${esc(draft.to_email)}</strong>
                <span>${esc(draft.company || "Без компании")}${draft.contact_name ? ` · ${esc(draft.contact_name)}` : ""}</span>
                ${draft.error_reason ? `<em>${esc(draft.error_reason)}</em>` : ""}
              </div>
            </td>
            <td>
              <div class="draft-message">
                <strong>${esc(draft.subject || "Без темы")}</strong>
                <span>${esc((draft.body_text || "").slice(0, 180))}${draft.body_text && draft.body_text.length > 180 ? "..." : ""}</span>
                <div class="draft-steps">${followups.length
                  ? followups.map((step) => `<span>FU${Number(step.position) - 1}: +${Number(step.delay_days || 0)} дн.</span>`).join("")
                  : `<span>follow-up нет</span>`}
                </div>
              </div>
            </td>
            <td><span class="draft-mailbox">${esc(draft.mailbox_email || "выберется позже")}</span></td>
            <td>
              <div class="row-actions">
                <button class="small-button" data-start-draft="${draft.id}" ${draft.status !== "ready" ? "disabled" : ""}>Старт</button>
                <button class="small-button" data-edit-outreach-draft="${draft.id}">Править</button>
                <button class="small-button" data-cancel-draft="${draft.id}" ${["cancelled", "completed"].includes(draft.status) ? "disabled" : ""}>Остановить</button>
                <button class="small-button danger-button" data-delete-draft="${draft.id}" ${canDelete ? "" : "disabled"} title="${canDelete ? "Удалить черновик из списка" : "Нельзя удалять черновики, которые уже ушли в отправку"}">Удалить</button>
              </div>
            </td>
          </tr>
        `;
        }).join("")
        : `<tr><td colspan="6" class="muted">Черновиков по текущему фильтру нет.</td></tr>`}
    </tbody>
  `;
}

async function loadSegments() {
  try {
    state.segments = await api("/api/segments");
    renderLeadSegmentFilter();
    renderSegmentPickers();
    renderAiExportFilters();
  } catch (error) {
    state.segments = [];
    console.warn("Не удалось загрузить сегменты", error);
  }
}

function renderLeadSegmentFilter() {
  const filter = $("#leadSegmentFilter");
  if (!filter) return;
  const current = filter.value;
  filter.innerHTML = `<option value="">Все сегменты</option>${state.segments.map((segment) => `<option value="${esc(segment)}">${esc(segment)}</option>`).join("")}`;
  if (state.segments.includes(current)) filter.value = current;
}

function splitSegments(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean))];
}

function joinSegments(values) {
  return splitSegments(values.join(",")).join(", ");
}

function selectedPickerSegments(picker) {
  return splitSegments(picker.querySelector("input[name='segment']")?.value || "");
}

function renderSegmentChips(picker) {
  const chips = picker.querySelector("[data-segment-chips]");
  if (!chips) return;
  const values = selectedPickerSegments(picker);
  chips.innerHTML = values.map((segment) => `
    <button type="button" class="segment-chip" data-remove-segment="${esc(segment)}">${esc(segment)} <span>×</span></button>
  `).join("");
}

function setSegmentPickerValue(picker, values) {
  if (picker.dataset.segmentMulti !== undefined) {
    picker.querySelector("input[name='segment']").value = joinSegments(Array.isArray(values) ? values : splitSegments(values));
    picker.querySelector(".segment-input").value = "";
    renderSegmentChips(picker);
    return;
  }
  picker.querySelector(".segment-input").value = Array.isArray(values) ? values[0] || "" : values || "";
}

function segmentMatches(value) {
  const needle = String(value || "").trim().toLowerCase();
  return state.segments
    .filter((segment) => !needle || segment.toLowerCase().includes(needle))
    .slice(0, 20);
}

function closeSegmentPickers() {
  $$(".segment-picker").forEach((picker) => picker.classList.remove("open"));
  $$(".segment-menu").forEach((menu) => {
    menu.hidden = true;
  });
}

function renderSegmentPicker(input) {
  const picker = input.closest(".segment-picker");
  const menu = picker?.querySelector(".segment-menu");
  if (!picker || !menu) return;
  const selected = new Set(selectedPickerSegments(picker).map((segment) => segment.toLowerCase()));
  const matches = segmentMatches(input.value);
  menu.innerHTML = matches.length
    ? picker.dataset.segmentMulti !== undefined
      ? matches.map((segment) => `
        <label class="segment-option">
          <input type="checkbox" data-segment-value="${esc(segment)}" ${selected.has(segment.toLowerCase()) ? "checked" : ""} />
          <span>${esc(segment)}</span>
        </label>
      `).join("")
      : matches.map((segment) => `<button type="button" data-segment-value="${esc(segment)}">${esc(segment)}</button>`).join("")
    : `<span class="segment-empty">Сохраненных сегментов нет. Новый сохранится после отправки формы.</span>`;
  menu.hidden = false;
  picker.classList.add("open");
}

function renderSegmentPickers() {
  $$(".segment-input").forEach((input) => {
    if (document.activeElement === input) renderSegmentPicker(input);
  });
}

async function loadCampaignAvailableLeads() {
  const campaignId = $("#activeCampaign")?.value || "";
  state.campaignAvailableLeads = campaignId ? await api(`/api/campaigns/${campaignId}/available-leads`) : [];
  renderCampaignAvailableLeads();
}

function updateCampaignLeadSelection() {
  const availableIds = new Set(state.campaignAvailableLeads.map((lead) => lead.id));
  state.selectedCampaignLeadIds = new Set([...state.selectedCampaignLeadIds].filter((id) => availableIds.has(id)));
  const count = state.selectedCampaignLeadIds.size;
  const selection = $("#campaignLeadSelection");
  const selectAll = $("#campaignLeadSelectAll");
  const enrollButton = $("#enrollBtn");
  if (selection) selection.textContent = `Выбрано: ${count}`;
  if (selectAll) {
    const available = state.campaignAvailableLeads;
    selectAll.disabled = available.length === 0;
    selectAll.checked = available.length > 0 && available.every((lead) => state.selectedCampaignLeadIds.has(lead.id));
    selectAll.indeterminate = count > 0 && !selectAll.checked;
  }
  if (enrollButton) enrollButton.disabled = count === 0;
}

function renderCampaignAvailableLeads() {
  const table = $("#campaignAvailableLeadsTable");
  if (!table) return;
  const available = state.campaignAvailableLeads;
  const emptyText = state.campaignLeads.length
    ? "Все подходящие лиды уже добавлены в эту кампанию. Проверь список ниже и переходи к шагу 4 “Проверка”."
    : "Нет доступных лидов для этой кампании. Проверь, что у лидов выбран один из сегментов кампании, а email проверен как “можно отправлять” или “нужна проверка”.";
  table.innerHTML = `
    <thead><tr><th></th><th>Компания</th><th>Email</th><th>Сегмент</th><th>Проверка</th></tr></thead>
    <tbody>
      ${available.length
        ? available.map((lead) => `
          <tr>
            <td><input type="checkbox" data-campaign-lead-id="${lead.id}" ${state.selectedCampaignLeadIds.has(lead.id) ? "checked" : ""} /></td>
            <td><strong>${esc(lead.company)}</strong><br><span class="muted">${esc(lead.contact_name || "")}</span></td>
            <td>${esc(lead.email)}</td>
            <td>${esc(lead.segment || "")}</td>
            <td>${pill(lead.validation_status)}<br><span class="muted">${esc(validationReasonText(lead.validation_reason))}</span></td>
          </tr>
        `).join("")
        : `<tr><td colspan="5" class="muted">${esc(emptyText)}</td></tr>`}
    </tbody>
  `;
  updateCampaignLeadSelection();
}

function selectedCampaign() {
  const campaignId = $("#stepCampaign")?.value || $("#activeCampaign")?.value || "";
  return state.campaigns.find((campaign) => campaign.id === campaignId) || state.campaigns[0] || null;
}

function resetStepForm() {
  const form = $("#stepForm");
  form.reset();
  form.elements.step_id.value = "";
  $("#htmlEditor").innerHTML = "Здравствуйте, {{contact}}.<br><br>Хочу обсудить {{company}} и {{pain}}.";
  $("#stepSubmitBtn").textContent = "Добавить шаг";
  $("#stepEditResetBtn").hidden = true;
}

function renderCampaignStepList() {
  const node = $("#campaignStepList");
  if (!node) return;
  const campaign = selectedCampaign();
  const steps = campaign?.steps || [];
  node.innerHTML = steps.length
    ? steps.map((step) => `
      <article class="card campaign-step-card">
        <div>
          <strong>${esc(step.position)}. ${esc(step.name)}</strong>
          <p>Тема: ${esc(step.subject_template)}</p>
          <p>Задержка: ${Number(step.delay_days || 0)} дн. · Вложения: ${step.attachments?.length || 0}</p>
        </div>
        <details>
          <summary>Посмотреть письмо</summary>
          <div class="step-preview">${step.body_template_html || esc(step.body_template_text || "")}</div>
        </details>
        <div class="card-actions">
          <button data-edit-step="${step.id}">Редактировать</button>
        </div>
      </article>
    `).join("")
    : `<article class="card"><strong>Шагов пока нет</strong><p>Заполни письмо слева и нажми “Добавить шаг”. После сохранения оно появится здесь.</p></article>`;
}

function editCampaignStep(stepId) {
  const campaign = state.campaigns.find((item) => item.steps.some((step) => step.id === stepId));
  const step = campaign?.steps.find((item) => item.id === stepId);
  if (!campaign || !step) return;
  const form = $("#stepForm");
  form.elements.step_id.value = step.id;
  form.elements.campaign_id.value = campaign.id;
  form.elements.name.value = step.name || "";
  form.elements.delay_days.value = step.delay_days || 0;
  form.elements.subject_template.value = step.subject_template || "";
  form.elements.body_template_text.value = step.body_template_text || "";
  $("#htmlEditor").innerHTML = step.body_template_html || "";
  $("#stepSubmitBtn").textContent = "Сохранить изменения";
  $("#stepEditResetBtn").hidden = false;
  switchCampaignStep("letter");
}

function syncCampaignSegmentInput() {
  const picker = $("#campaignForm .segment-picker-multi");
  if (!picker) return;
  const input = picker.querySelector(".segment-input");
  const values = selectedPickerSegments(picker);
  if (input.value.trim()) values.push(input.value.trim());
  setSegmentPickerValue(picker, values);
}

function resetCampaignForm() {
  const form = $("#campaignForm");
  form.reset();
  form.elements.campaign_id.value = "";
  setSegmentPickerValue(form.querySelector(".segment-picker-multi"), []);
  form.elements.tracking_enabled.checked = true;
  form.elements.manual_approval_required.checked = false;
  $("#campaignSubmitBtn").textContent = "Создать кампанию";
  $("#campaignEditResetBtn").hidden = true;
}

function editCampaign(campaignId) {
  const campaign = state.campaigns.find((item) => item.id === campaignId);
  if (!campaign) return;
  const form = $("#campaignForm");
  form.elements.campaign_id.value = campaign.id;
  form.elements.name.value = campaign.name || "";
  form.elements.description.value = campaign.description || "";
  setSegmentPickerValue(form.querySelector(".segment-picker-multi"), splitSegments(campaign.segment));
  form.elements.tracking_enabled.checked = Boolean(campaign.tracking_enabled);
  form.elements.manual_approval_required.checked = Boolean(campaign.manual_approval_required);
  $("#campaignSubmitBtn").textContent = "Сохранить изменения";
  $("#campaignEditResetBtn").hidden = false;
  $("#activeCampaign").value = campaign.id;
  $("#stepCampaign").value = campaign.id;
  renderCampaignStepList();
  switchCampaignStep("campaign");
}

async function loadMailboxes() {
  state.mailboxes = await api("/api/mailboxes");
  $("#mailboxList").innerHTML = state.mailboxes.length
    ? state.mailboxes.map(
      (mailbox) => `
      <article class="card">
        <strong>${esc(mailbox.name)}</strong>
        <p>${esc(mailbox.email)} · ${esc(mailbox.provider)}</p>
        <div class="mailbox-status">
          ${pill(mailbox.health_status)}
          <span>${mailbox.smtp_verified_at ? "SMTP проверен" : "SMTP не проверен"}</span>
          <span>${mailbox.imap_verified_at ? "IMAP проверен" : "IMAP не проверен"}</span>
          <span>${mailbox.last_inbox_sync_at ? `Входящие: ${fmtDate(mailbox.last_inbox_sync_at)}` : "Входящие еще не синхронизировались"}</span>
        </div>
        <p>Ошибок отправки подряд: <strong>${Number(mailbox.error_count || 0)}</strong>${mailbox.paused_until && new Date(mailbox.paused_until) > new Date() ? ` · замедлен до ${fmtDate(mailbox.paused_until)}` : ""}</p>
        <p>MX/SPF/DKIM/DMARC: ${mailbox.mx_status || "-"} / ${mailbox.spf_status || "-"} / ${mailbox.dkim_status || "-"} / ${mailbox.dmarc_status || "-"}</p>
        <p class="mailbox-guide">${esc(mailboxNextStep(mailbox))}</p>
        <div id="mailboxActionResult-${mailbox.id}">${actionResultHtml(state.actionResults.mailboxes[mailbox.id])}</div>
        <details class="mailbox-edit">
          <summary>Все настройки mailbox</summary>
          <form class="mailbox-edit-form" data-mailbox-edit="${mailbox.id}">
            <fieldset class="mailbox-edit-section">
              <legend>Основное</legend>
              <label><span>Провайдер</span><select name="provider">
                <option value="custom" ${mailbox.provider === "custom" ? "selected" : ""}>Корпоративный SMTP/IMAP</option>
                <option value="timeweb" ${mailbox.provider === "timeweb" ? "selected" : ""}>Timeweb</option>
                <option value="yandex" ${mailbox.provider === "yandex" ? "selected" : ""}>Яндекс</option>
              </select></label>
              <label><span>Имя отправителя</span><input name="from_name" value="${esc(mailbox.from_name || mailbox.name)}" /></label>
              <label class="mailbox-edit-check"><input name="is_active" type="checkbox" ${mailbox.is_active ? "checked" : ""} /> Ящик активен</label>
            </fieldset>
            <fieldset class="mailbox-edit-section">
              <legend>Серверы</legend>
              <label><span>SMTP</span><input name="smtp_host" value="${esc(mailbox.smtp_host)}" required /></label>
              <label><span>SMTP порт</span><input name="smtp_port" type="number" min="1" max="65535" value="${mailbox.smtp_port}" required /></label>
              <label class="mailbox-edit-check"><input name="smtp_secure" type="checkbox" ${mailbox.smtp_secure ? "checked" : ""} /> SMTP SSL/TLS сразу</label>
              <label><span>IMAP</span><input name="imap_host" value="${esc(mailbox.imap_host)}" required /></label>
              <label><span>IMAP порт</span><input name="imap_port" type="number" min="1" max="65535" value="${mailbox.imap_port}" required /></label>
              <label class="mailbox-edit-check"><input name="imap_secure" type="checkbox" ${mailbox.imap_secure ? "checked" : ""} /> IMAP SSL/TLS сразу</label>
            </fieldset>
            <fieldset class="mailbox-edit-section">
              <legend>Доступ</legend>
              <label><span>Логин</span><input name="username" value="${esc(mailbox.username || mailbox.email)}" /></label>
              <label><span>Новый пароль</span><input name="password" type="password" autocomplete="new-password" placeholder="Оставь пустым, если не меняешь" /></label>
            </fieldset>
            <fieldset class="mailbox-edit-section">
              <legend>Расписание</legend>
              <label><span>Лимит рассылки в день</span><input name="daily_send_limit" type="number" min="1" step="1" value="${mailbox.daily_send_limit || ""}" placeholder="Без лимита" /></label>
              <label><span>Лимит прогрева в день</span><input name="daily_warmup_limit" type="number" min="1" step="1" value="${mailbox.daily_warmup_limit}" /></label>
              <label><span>Пауза мин.</span><input name="min_delay_minutes" type="number" min="1" step="1" value="${mailbox.min_delay_minutes}" /></label>
              <label><span>Пауза макс.</span><input name="max_delay_minutes" type="number" min="1" step="1" value="${mailbox.max_delay_minutes}" /></label>
              <label><span>Окно с</span><input name="send_window_start" type="time" value="${String(mailbox.send_window_start || "09:00").slice(0, 5)}" /></label>
              <label><span>Окно до</span><input name="send_window_end" type="time" value="${String(mailbox.send_window_end || "18:00").slice(0, 5)}" /></label>
              <div class="mailbox-edit-days">
                <span>Дни отправки</span>
                <div class="check-grid">${sendDaysCheckboxes(mailbox.send_days)}</div>
              </div>
              <label class="mailbox-edit-check"><input name="warmup_enabled" type="checkbox" ${mailbox.warmup_enabled ? "checked" : ""} /> Прогрев включен</label>
            </fieldset>
            <button>Сохранить все настройки</button>
          </form>
        </details>
        <div class="mailbox-actions">
          <button data-check-mailbox="${mailbox.id}" title="Проверяет SMTP-логин для отправки, IMAP-логин для входящих и DNS домена">Проверить SMTP/IMAP</button>
          <button data-sync-mailbox="${mailbox.id}" title="Ставит задачу worker на чтение новых писем из INBOX через IMAP">Синхронизировать входящие</button>
          <button data-toggle-warmup="${mailbox.id}" data-enabled="${!mailbox.warmup_enabled}">${mailbox.warmup_enabled ? "Выключить прогрев" : "Включить прогрев"}</button>
        </div>
      </article>
    `,
    )
    .join("")
    : `<article class="card"><strong>Почтовых ящиков пока нет</strong><p>Добавь первый ящик слева. Пароль хранится только в .env, в форму вставляется имя переменной.</p></article>`;
  renderSetupChecklist();
  renderAiExportFilters();
}

async function loadCampaigns() {
  state.campaigns = await api("/api/campaigns");
  const activeCampaignValue = $("#activeCampaign").value;
  const options = state.campaigns.map((campaign) => `<option value="${campaign.id}">${esc(campaign.name)}</option>`).join("");
  $("#stepCampaign").innerHTML = options;
  $("#activeCampaign").innerHTML = options;
  if (state.campaigns.some((campaign) => campaign.id === activeCampaignValue)) {
    $("#activeCampaign").value = activeCampaignValue;
  }
  const attachmentSteps = state.campaigns.flatMap((campaign) => campaign.steps.map((step) => ({ ...step, campaignName: campaign.name })));
  $("#attachmentStep").innerHTML = attachmentSteps.length
    ? attachmentSteps.map((step) => `<option value="${step.id}">${esc(step.campaignName)} / ${esc(step.name)}</option>`).join("")
    : `<option value="">Сначала добавь шаг письма</option>`;
  $("#attachmentForm button").disabled = attachmentSteps.length === 0;
  renderAttachments();
  $("#campaignList").innerHTML = state.campaigns.length
    ? state.campaigns.map(
      (campaign) => `
        <article class="card">
          <strong>${esc(campaign.name)}</strong> ${pill(campaign.status)}
          <p>Сегменты: ${esc(campaign.segment || "не указаны")}</p>
          <p>${esc(campaign.description || "")}</p>
          <p>Шагов: ${campaign.steps.length} · Отслеживание открытий: ${campaign.tracking_enabled ? "включено" : "выключено"} · Ручная проверка писем: ${campaign.manual_approval_required ? "включена" : "выключена"}</p>
          <ol>${campaign.steps.map((step) => `<li>${esc(step.name)}: ${esc(step.subject_template)} (${step.attachments?.length || 0} влож.)</li>`).join("")}</ol>
          <div class="card-actions"><button data-edit-campaign="${campaign.id}">Редактировать</button></div>
        </article>
      `,
    )
    .join("")
    : `<article class="card"><strong>Рассылок пока нет</strong><p>Создай кампанию, затем добавь хотя бы один шаг письма.</p></article>`;
  renderSetupChecklist();
  renderCampaignStepList();
  renderAiExportFilters();
  await loadCampaignLeads();
}

async function loadCampaignLeads() {
  const campaignId = $("#activeCampaign")?.value || "";
  const summary = $("#campaignLeadsSummary");
  const table = $("#campaignLeadsTable");
  if (!campaignId) {
    state.campaignLeads = [];
    summary.textContent = "Сначала создай или выбери кампанию.";
    table.innerHTML = "";
    return;
  }
  state.campaignLeads = await api(`/api/campaigns/${campaignId}/leads`);
  const activeCount = state.campaignLeads.filter((lead) => lead.enrollment_status === "active").length;
  const pausedCount = state.campaignLeads.filter((lead) => lead.enrollment_status === "paused").length;
  const mailboxCount = new Set(state.campaignLeads.map((lead) => lead.mailbox_email).filter(Boolean)).size;
  summary.textContent = `В кампании: ${state.campaignLeads.length} · отправятся: ${activeCount} · выключены: ${pausedCount} · почт отправителя: ${mailboxCount}`;
  table.innerHTML = `
    <thead><tr><th>Отправлять</th><th>Компания</th><th>Email</th><th>Сегмент</th><th>Проверка</th><th>Почта отправителя</th><th>Статус</th><th>Следующая отправка</th></tr></thead>
    <tbody>
      ${state.campaignLeads.length
        ? state.campaignLeads.map((lead) => {
          const canToggle = ["active", "paused"].includes(lead.enrollment_status);
          return `
          <tr class="${lead.enrollment_status === "active" ? "" : "muted-row"}">
            <td>
              <label class="send-toggle">
                <input type="checkbox" data-campaign-send-toggle="${lead.enrollment_id}" ${lead.enrollment_status === "active" ? "checked" : ""} ${canToggle ? "" : "disabled"} />
                <span>${lead.enrollment_status === "active" ? "да" : lead.enrollment_status === "paused" ? "нет" : "завершено"}</span>
              </label>
            </td>
            <td><strong>${esc(lead.company)}</strong><br><span class="muted">${esc(lead.contact_name || "")}</span></td>
            <td>${esc(lead.email)}</td>
            <td>${esc(lead.segment || "")}</td>
            <td>${pill(lead.validation_status)}<br><span class="muted">${esc(validationReasonText(lead.validation_reason))}</span></td>
            <td>${esc(lead.mailbox_email || "не назначен")}</td>
            <td>${pill(lead.enrollment_status)}</td>
            <td>${fmtDate(lead.next_send_at) || "по запуску"}</td>
          </tr>
        `;
        }).join("")
        : `<tr><td colspan="8" class="muted">В этой кампании пока нет лидов. Выбери нужных лидов выше и нажми “Добавить выбранных лидов”.</td></tr>`}
    </tbody>
  `;
  await loadCampaignAvailableLeads();
}

function stepCard({ done, title, text, action, view }) {
  return `
    <article class="setup-step ${done ? "done" : ""}">
      <div class="setup-status">${done ? "Готово" : "Нужно"}</div>
      <div>
        <strong>${esc(title)}</strong>
        <p>${esc(text)}</p>
      </div>
      <button data-go="${view}">${esc(action)}</button>
    </article>
  `;
}

function renderSetupChecklist() {
  const dashboard = state.dashboard;
  if (!dashboard || !$("#setupChecklist")) return;
  const verifiedMailboxes = state.mailboxes.filter((mailbox) => mailbox.smtp_verified_at && mailbox.imap_verified_at);
  const warmupEnabled = state.mailboxes.filter((mailbox) => mailbox.warmup_enabled).length;
  const campaignsWithSteps = state.campaigns.filter((campaign) => campaign.steps.length > 0);
  const queuedOrSent = Number(dashboard.queue.pending || 0) + Number(dashboard.queue.sent || 0);
  const runtimeDryRun = state.settings?.runtime?.dryRun;

  const steps = [
    {
      done: runtimeDryRun === true || runtimeDryRun === false,
      title: runtimeDryRun === undefined ? "Проверить режим отправки" : runtimeDryRun ? "Безопасный режим включен" : "Реальная отправка включена",
      text: runtimeDryRun === undefined
        ? "Жду ответ backend по runtime-настройкам."
        : runtimeDryRun
        ? "Можно спокойно нажимать кнопки: реальные письма не отправятся."
        : "SMTP/IMAP и отправка работают по-настоящему.",
      action: "Открыть настройки",
      view: "settings",
    },
    {
      done: verifiedMailboxes.length >= 2,
      title: "Подключить 2 почтовых ящика",
      text: `Проверено ящиков: ${verifiedMailboxes.length}. Нужно 2, чтобы прогревать почту между ними.`,
      action: "Подключить почту",
      view: "mailboxes",
    },
    {
      done: warmupEnabled >= 2,
      title: "Включить прогрев",
      text: `Почт с прогревом: ${warmupEnabled}. Прогрев работает только между твоими ящиками.`,
      action: "Включить прогрев",
      view: "warmup",
    },
    {
      done: Number(dashboard.leads.valid || 0) + Number(dashboard.leads.risky || 0) > 0,
      title: "Добавить лидов и проверить email",
      text: `Лидов: ${dashboard.leads.total}. Valid/risky: ${Number(dashboard.leads.valid || 0) + Number(dashboard.leads.risky || 0)}.`,
      action: "Добавить базу",
      view: "leads",
    },
    {
      done: campaignsWithSteps.length > 0,
      title: "Создать рассылку и письмо",
      text: `Кампаний с шагами: ${campaignsWithSteps.length}. Нужен хотя бы один шаг письма.`,
      action: "Создать рассылку",
      view: "campaigns",
    },
    {
      done: queuedOrSent > 0,
      title: "Запустить тестовую отправку",
      text: `В очереди/отправлено: ${queuedOrSent}. Перед боевой отправкой сначала делай тест на свои почты.`,
      action: "Открыть очередь",
      view: "queue",
    },
  ];

  const next = steps.find((step) => !step.done);
  $("#setupChecklist").innerHTML = `
    ${next ? `<div class="next-action"><strong>Сейчас сделай это:</strong> ${esc(next.title)} <button data-go="${next.view}">${esc(next.action)}</button></div>` : `<div class="next-action success"><strong>Базовая настройка готова.</strong> Можно тестировать рассылку и смотреть метрики.</div>`}
    <div class="setup-list">${steps.map(stepCard).join("")}</div>
  `;
}

function renderAttachments() {
  const steps = state.campaigns.flatMap((campaign) => campaign.steps.map((step) => ({ ...step, campaignName: campaign.name })));
  const cards = steps.flatMap((step) => (step.attachments || []).map((attachment) => ({ ...attachment, stepName: step.name, campaignName: step.campaignName })));
  $("#attachmentList").innerHTML = cards.length
    ? cards
        .map(
          (item) => `
            <article class="card">
              <strong>${esc(item.file_name)}</strong>
              <p>${esc(item.campaignName)} / ${esc(item.stepName)} · ${Math.round(Number(item.size_bytes || 0) / 1024)} KB</p>
              <button data-delete-attachment="${item.id}">Удалить</button>
            </article>
          `,
        )
        .join("")
    : `<p class="muted">Вложений пока нет.</p>`;
}

function inboxClassificationOptions() {
  return ["positive_reply", "neutral_reply", "negative_reply", "auto_reply", "unsubscribe", "not_target", "bounce", "unknown"];
}

function inboxFilterLabel(value) {
  return {
    all: "Все входящие",
    decision: "Нужно разобрать",
    outreach: "По лидам",
    positive: "Позитивные",
  }[value] || "Все входящие";
}

function inboxNeedsDecision(item) {
  return !item.reply_classification || item.reply_classification === "unknown";
}

function inboxPreviewText(item) {
  const text = (item.body_text || "").replace(/\s+/g, " ").trim();
  if (!text) return "Текста письма нет.";
  return text.length > 320 ? `${text.slice(0, 320)}...` : text;
}

function inboxContextText(item) {
  const parts = [];
  parts.push(item.company || "Без компании");
  if (item.lead_email) parts.push(item.lead_email);
  if (item.mailbox_email) parts.push(`получено на ${item.mailbox_email}`);
  return parts.join(" · ");
}

function inboxDecisionText(item) {
  if (inboxNeedsDecision(item)) return "Классификацию нужно выбрать вручную.";
  if (item.reply_classification === "positive_reply") return "Позитивный ответ: стоит обработать как теплый контакт.";
  if (item.reply_classification === "negative_reply") return "Отказ: цепочку лучше остановить.";
  if (item.reply_classification === "auto_reply") return "Автоответ: проверь, нужно ли переносить follow-up.";
  if (item.reply_classification === "bounce") return "Недоставка: проверь адрес или домен.";
  if (item.reply_classification === "unsubscribe") return "Просьба не писать: контакт должен быть в стоп-листе.";
  return "Классификация проставлена.";
}

function inboxVisibleItems() {
  if (state.inboxFilter === "decision") return state.inbox.filter(inboxNeedsDecision);
  if (state.inboxFilter === "outreach") return state.inbox.filter((item) => item.lead_email);
  if (state.inboxFilter === "positive") return state.inbox.filter((item) => item.reply_classification === "positive_reply");
  return state.inbox;
}

async function loadQueue() {
  const [queue, progress] = await Promise.all([api("/api/sending"), api("/api/sending/progress")]);
  state.queue = [...queue].sort((a, b) => {
    const rank = queueSortRank(a) - queueSortRank(b);
    if (rank !== 0) return rank;
    const left = new Date(a.scheduled_at || a.sent_at || a.updated_at || 0).getTime();
    const right = new Date(b.scheduled_at || b.sent_at || b.updated_at || 0).getTime();
    return left - right;
  });
  const total = state.queue.length;
  const next = state.queue.find((item) => ["pending", "retrying"].includes(item.status) && !(item.requires_approval && !item.approved_at));
  $("#sendProgress").innerHTML = `
    <div class="progress">
      <div class="bar"><span style="width:${progress.percent}%"></span></div>
      <div>
        <strong>Отправка:</strong> ${progress.sent} из ${progress.total} · ошибок: ${progress.failed} · осталось примерно ${progress.etaMinutes} мин.
        ${next ? `<br><span class="muted">Следующее письмо: через ${fmtCountdown(next.scheduled_at)} · ${fmtDate(next.scheduled_at)}</span>` : ""}
      </div>
    </div>
  `;
  const waitingWindow = state.queue.filter((item) => item.status === "pending" && item.last_error?.startsWith("Вне окна отправки")).length;
  const approvalNeeded = state.queue.filter((item) => item.requires_approval && !item.approved_at).length;
  const failed = state.queue.filter((item) => item.status === "failed").length;
  const readyToSend = state.queue.filter((item) => ["pending", "retrying"].includes(item.status) && !(item.requires_approval && !item.approved_at)).length;
  const sent = state.queue.filter((item) => item.status === "sent").length;
  const visibleQueue = state.queue.filter((item) => {
    if (state.queueFilter === "sent") return item.status === "sent";
    if (state.queueFilter === "all") return true;
    return queueNeedsSending(item);
  });
  const visibleGroups = queueGroups(visibleQueue);
  const visibleGroupKeys = new Set(visibleGroups.map((group) => group.key));
  state.expandedQueueGroups = new Set([...state.expandedQueueGroups].filter((key) => visibleGroupKeys.has(key)));
  $("#queueSummary").innerHTML = `
    <span>В очереди: <strong>${total}</strong></span>
    <span>Цепочек на экране: <strong>${visibleGroups.length}</strong></span>
    <span>Готовы к обработке: <strong>${readyToSend}</strong></span>
    <span>Ждут окна: <strong>${waitingWindow}</strong></span>
    <span>Ждут подтверждения: <strong>${approvalNeeded}</strong></span>
    <span>Отправлено: <strong>${sent}</strong></span>
    <span>Ошибки: <strong>${failed}</strong></span>
    <span>Показано: <strong>${queueFilterLabel(state.queueFilter).toLowerCase()}</strong></span>
  `;
  $("#queueTable").innerHTML = `
    <thead><tr><th>Когда</th><th>Кому и что</th><th>Отправитель</th><th>Состояние</th><th>Действие</th></tr></thead>
    <tbody>
      ${visibleGroups.length
        ? visibleGroups
        .map((group) => {
          const main = queueGroupMainItem(group);
          const action = queueNextAction(main);
          const stats = queueGroupStats(group);
          const expanded = state.expandedQueueGroups.has(group.key);
          return `
            <tr class="queue-row queue-group-row" data-queue-group-toggle="${esc(group.key)}" aria-expanded="${expanded ? "true" : "false"}">
              <td class="queue-time">
                <span class="queue-expand">${expanded ? "Свернуть" : "Раскрыть"}</span>
                ${queueGroupTimeLabel(group)}
              </td>
              <td>
                <div class="queue-recipient">
                  <strong>${esc(group.company || group.email)}</strong>
                  <span>${esc(group.email)}</span>
                  <em>${esc(group.campaignName)} · ${esc(queueStepTitle(main))}</em>
                  <div class="queue-chain-counters">
                    <span>отправлено: ${stats.sentMessages}</span>
                    <span>ответов: ${stats.replies}</span>
                    <span>ждет: ${stats.waiting}</span>
                  </div>
                </div>
              </td>
              <td><span class="queue-mailbox">${esc(group.mailboxEmail || main.mailbox_email || "не выбран")}</span></td>
              <td>
                <div class="queue-state">
                  <strong>${esc(queueGroupStateLabel(group))}</strong>
                  <span>${esc(queueGroupReasonText(group))}</span>
                  <em>${esc(queueModeLabel(main.mode))}</em>
                </div>
              </td>
              <td>
                <div class="queue-action">
                  ${action.html}
                  ${action.text ? `<span>${esc(action.text)}</span>` : ""}
                </div>
              </td>
            </tr>
            ${expanded ? renderQueueGroupDetails(group) : ""}
          `;
        })
        .join("")
        : `<tr><td colspan="5" class="muted">Очередь пуста по фильтру “${esc(queueFilterLabel(state.queueFilter))}”. Переключи фильтр или запусти черновики/кампанию.</td></tr>`}
    </tbody>
  `;
  $$("[data-queue-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.queueFilter === state.queueFilter);
  });
}

async function loadInbox() {
  state.inbox = await api("/api/inbox");
  const visibleItems = inboxVisibleItems();
  const decisionCount = state.inbox.filter(inboxNeedsDecision).length;
  const outreachCount = state.inbox.filter((item) => item.lead_email).length;
  const positiveCount = state.inbox.filter((item) => item.reply_classification === "positive_reply").length;
  $("#inboxSummary").innerHTML = `
    <span>Всего входящих: <strong>${state.inbox.length}</strong></span>
    <span>Нужно разобрать: <strong>${decisionCount}</strong></span>
    <span>По лидам: <strong>${outreachCount}</strong></span>
    <span>Позитивные: <strong>${positiveCount}</strong></span>
    <span>Показано: <strong>${esc(inboxFilterLabel(state.inboxFilter).toLowerCase())}</strong></span>
  `;
  $("#inboxList").innerHTML = visibleItems.length
    ? visibleItems
      .map(
        (item) => `
        <article class="card inbox-card">
          <div class="inbox-card-head">
            <div class="inbox-title">
              <strong>${esc(item.subject || "Без темы")}</strong>
              <p>${esc(inboxContextText(item))}</p>
            </div>
            <div class="inbox-badges">
              ${pill(item.reply_classification || "unknown")}
              ${item.type ? pill(item.type) : ""}
            </div>
          </div>
          <div class="inbox-meta">
            <span>Получено: <strong>${fmtDate(item.received_at || item.created_at)}</strong></span>
            <span>Отправитель: <strong>${esc(item.lead_email || "не определен")}</strong></span>
          </div>
          <p class="inbox-preview">${esc(inboxPreviewText(item))}</p>
          <div class="inbox-next">
            <strong>${esc(inboxDecisionText(item))}</strong>
          </div>
          <div class="inbox-actions">
            <label class="field inbox-classify"><span>Класс ответа</span><select data-classify="${item.id}">
              ${inboxClassificationOptions()
              .map((value) => `<option value="${value}" ${value === item.reply_classification ? "selected" : ""}>${esc(statusLabel(value))}</option>`)
              .join("")}
            </select></label>
            <details class="inbox-full">
              <summary>Показать полный текст</summary>
              <pre class="inbox-message">${esc(item.body_text || "Текста письма нет.")}</pre>
            </details>
          </div>
        </article>
      `,
      )
      .join("")
    : `<p class="muted">По фильтру “${esc(inboxFilterLabel(state.inboxFilter))}” писем нет.</p>`;
  $$("[data-inbox-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.inboxFilter === state.inboxFilter);
  });
}

function conversationQuery() {
  const params = new URLSearchParams();
  const status = $("#conversationStatusFilter")?.value || "";
  const classification = $("#conversationClassificationFilter")?.value || "";
  const review = $("#conversationReviewOnly")?.checked;
  if (status) params.set("status", status);
  if (classification) params.set("classification", classification);
  if (review) params.set("review", "true");
  return params.toString();
}

function updateConversationExportLink() {
  const query = conversationQuery();
  const href = `/api/outreach/conversations/export.jsonl${query ? `?${query}` : ""}`;
  $("#conversationExportLink").setAttribute("href", href);
}

function reviewQuery() {
  const params = new URLSearchParams({ review: "true" });
  const classification = $("#reviewClassificationFilter")?.value || "";
  if (classification) params.set("classification", classification);
  return params.toString();
}

function applyConversationPreset(preset) {
  state.conversationPreset = preset;
  const status = $("#conversationStatusFilter");
  const classification = $("#conversationClassificationFilter");
  const reviewOnly = $("#conversationReviewOnly");
  if (!status || !classification || !reviewOnly) return;
  classification.value = "";
  reviewOnly.checked = false;
  status.value = "";
  if (preset === "review") reviewOnly.checked = true;
  if (preset === "active") status.value = "active_sequence";
  if (preset === "paused") status.value = "paused";
}

function updateReviewExportLink() {
  const query = reviewQuery();
  $("#reviewExportLink").setAttribute("href", `/api/outreach/conversations/export.jsonl?${query}`);
}

function aiExportQuery() {
  const params = new URLSearchParams();
  const status = $("#aiExportStatus")?.value || "";
  const classification = $("#aiExportClassification")?.value || "";
  const segment = $("#aiExportSegment")?.value || "";
  const campaignId = $("#aiExportCampaign")?.value || "";
  const importId = $("#aiExportImport")?.value || "";
  const mailboxId = $("#aiExportMailbox")?.value || "";
  const dateFrom = $("#aiExportDateFrom")?.value || "";
  const dateTo = $("#aiExportDateTo")?.value || "";
  if (status) params.set("status", status);
  if (classification) params.set("classification", classification);
  if (segment) params.set("segment", segment);
  if (campaignId) params.set("campaign_id", campaignId);
  if (importId) params.set("import_id", importId);
  if (mailboxId) params.set("mailbox_id", mailboxId);
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  if ($("#aiExportReviewOnly")?.checked) params.set("review", "true");
  if ($("#aiExportRepliedOnly")?.checked) params.set("replied", "true");
  return params.toString();
}

function renderAiExportFilters() {
  const segmentSelect = $("#aiExportSegment");
  const campaignSelect = $("#aiExportCampaign");
  const importSelect = $("#aiExportImport");
  const mailboxSelect = $("#aiExportMailbox");
  if (segmentSelect) {
    const current = segmentSelect.value;
    segmentSelect.innerHTML = `<option value="">Все сегменты</option>${state.segments.map((segment) => `<option value="${esc(segment)}">${esc(segment)}</option>`).join("")}`;
    if (state.segments.includes(current)) segmentSelect.value = current;
  }
  if (campaignSelect) {
    const current = campaignSelect.value;
    campaignSelect.innerHTML = `<option value="">Все рассылки</option>${state.campaigns.map((campaign) => `<option value="${campaign.id}">${esc(campaign.name)}</option>`).join("")}`;
    if (state.campaigns.some((campaign) => campaign.id === current)) campaignSelect.value = current;
  }
  if (importSelect) {
    const current = importSelect.value;
    importSelect.innerHTML = `<option value="">Все импорты</option>${state.outreachImports.map((item) => `<option value="${item.id}">${esc(item.file_name)}${item.created_at ? ` · ${fmtDate(item.created_at)}` : ""}</option>`).join("")}`;
    if (state.outreachImports.some((item) => item.id === current)) importSelect.value = current;
  }
  if (mailboxSelect) {
    const current = mailboxSelect.value;
    mailboxSelect.innerHTML = `<option value="">Все ящики</option>${state.mailboxes.map((mailbox) => `<option value="${mailbox.id}">${esc(mailbox.email)}</option>`).join("")}`;
    if (state.mailboxes.some((mailbox) => mailbox.id === current)) mailboxSelect.value = current;
  }
  updateAiExportLinks();
}

function updateAiExportLinks() {
  const query = aiExportQuery();
  const suffix = query ? `?${query}` : "";
  $("#aiExportJsonlLink")?.setAttribute("href", `/api/outreach/conversations/export.jsonl${suffix}`);
  $("#aiExportJsonLink")?.setAttribute("href", `/api/outreach/conversations/export.json${suffix}`);
  $("#aiExportCsvLink")?.setAttribute("href", `/api/outreach/conversations/export.csv${suffix}`);
  const filters = [];
  if ($("#aiExportStatus")?.value) filters.push(`статус: ${statusLabel($("#aiExportStatus").value)}`);
  if ($("#aiExportClassification")?.value) filters.push(`класс: ${statusLabel($("#aiExportClassification").value)}`);
  if ($("#aiExportSegment")?.value) filters.push(`сегмент: ${$("#aiExportSegment").value}`);
  if ($("#aiExportCampaign")?.value) filters.push(`рассылка: ${$("#aiExportCampaign").selectedOptions[0]?.textContent || ""}`);
  if ($("#aiExportImport")?.value) filters.push(`импорт: ${$("#aiExportImport").selectedOptions[0]?.textContent || ""}`);
  if ($("#aiExportMailbox")?.value) filters.push(`ящик: ${$("#aiExportMailbox").selectedOptions[0]?.textContent || ""}`);
  if ($("#aiExportDateFrom")?.value || $("#aiExportDateTo")?.value) filters.push("по датам");
  if ($("#aiExportReviewOnly")?.checked) filters.push("только требуют решения");
  if ($("#aiExportRepliedOnly")?.checked) filters.push("только с ответами");
  $("#aiExportSummary").innerHTML = filters.length
    ? `<span>Фильтры: <strong>${esc(filters.join(" · "))}</strong></span>`
    : `<span>Фильтры не выбраны: выгрузятся все outreach-диалоги без прогрева.</span>`;
}

function classificationSelect(conversation) {
  return `
    <label class="field compact-field">
      <span>Классификация ответа</span>
      <select data-classify-conversation="${conversation.id}">
        ${REPLY_CLASS_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === (conversation.classification || "unknown") ? "selected" : ""}>${esc(label)}</option>`).join("")}
      </select>
    </label>
  `;
}

function conversationStatusExplanation(item) {
  if (["waiting_reply_review", "manual_reply_needed"].includes(item.status)) {
    return "Есть входящий ответ: цепочка остановлена, нужно решить что делать дальше.";
  }
  if (item.status === "active_sequence" && Number(item.pending_total || 0) > 0) {
    return "Цепочка идет: follow-up уже стоит в очереди.";
  }
  if (item.status === "active_sequence") return "Цепочка идет: сервис ждет следующего шага или ответа.";
  if (item.status === "paused") return "Цепочка остановлена вручную.";
  if (item.status === "completed") return "Цепочка завершена.";
  if (item.status === "positive") return "Позитивный ответ: можно обрабатывать как теплый контакт.";
  if (item.status === "negative") return "Отказ: будущие письма лучше не отправлять.";
  if (item.status === "not_target") return "Контакт не целевой.";
  if (item.status === "unsubscribed") return "Контакт попросил больше не писать.";
  if (item.status === "bounced") return "Была недоставка письма.";
  return nextActionLabel(item.next_action);
}

function conversationLastDirection(item) {
  if (item.latest_direction === "inbound") return "входящее";
  if (item.latest_direction === "outbound") return "исходящее";
  return "пока нет писем";
}

function conversationLastDate(item) {
  return item.latest_received_at || item.latest_sent_at || item.last_message_at || item.updated_at || item.created_at;
}

function conversationPreviewText(item) {
  const text = (item.latest_body_text || "").replace(/\s+/g, " ").trim();
  if (!text) return "Текста последнего письма пока нет.";
  return text.length > 260 ? `${text.slice(0, 260)}...` : text;
}

function conversationActionButtons(item) {
  const needsDecision = ["waiting_reply_review", "manual_reply_needed"].includes(item.status);
  const canStop = needsDecision || item.status === "active_sequence";
  const canContinue = Number(item.approval_total || 0) > 0;
  return `
    <button class="small-button" data-open-conversation="${item.id}">Открыть</button>
    ${canContinue ? `<button class="small-button" data-continue-conversation="${item.id}">Продолжить follow-up</button>` : ""}
    ${canStop ? `<button class="small-button danger-light" data-stop-conversation="${item.id}">Остановить цепочку</button>` : ""}
  `;
}

function renderConversationCards(items, emptyText) {
  return items.length
    ? items.map((item) => `
      <article class="card conversation-card">
        <div class="conversation-card-head">
          <div class="conversation-person">
            <strong>${esc(item.company || item.email)}</strong>
            <p>${esc(item.contact_name || "")} · ${esc(item.email)} · ${esc(item.segment || "")}</p>
          </div>
          <div class="conversation-badges">
            ${pill(item.status)}
            ${item.classification ? pill(item.classification) : ""}
          </div>
        </div>
        <div class="conversation-overview">
          <div class="conversation-latest">
            <span>${esc(conversationLastDirection(item))} · ${fmtDate(conversationLastDate(item))}</span>
            <strong>${esc(item.latest_subject || "Писем пока нет")}</strong>
            <p>${esc(conversationPreviewText(item))}</p>
          </div>
          <div class="conversation-facts">
            <span>Всего <strong>${item.messages_total}</strong></span>
            <span>Исходящих <strong>${item.outbound_total}</strong></span>
            <span>Входящих <strong>${item.inbound_total}</strong></span>
            <span>Ждут отправки <strong>${item.pending_total}</strong></span>
          </div>
        </div>
        <div class="conversation-next">
          <strong>${esc(conversationStatusExplanation(item))}</strong>
          ${Number(item.approval_total || 0) ? `<span>Follow-up ждут подтверждения: ${Number(item.approval_total || 0)}</span>` : ""}
        </div>
        <div class="conversation-card-footer">
          ${classificationSelect(item)}
        </div>
        <div class="card-actions">
          ${conversationActionButtons(item)}
        </div>
      </article>
    `).join("")
    : `<p class="muted">${esc(emptyText)}</p>`;
}

function renderConversationEvents(events = []) {
  const decisionEvents = events.filter((event) => [
    "email_replied",
    "email_bounced",
    "positive_reply_received",
    "neutral_reply_received",
    "negative_reply_received",
    "auto_reply_received",
    "unsubscribe_received",
    "unsubscribe_detected",
    "not_target_received",
    "reply_classified",
    "outreach_conversation_stopped",
    "outreach_conversation_continued",
    "outreach_followup_delayed",
    "manual_reply_sent",
  ].includes(event.event_type));
  return decisionEvents.length
    ? decisionEvents.map((event) => `
      <article class="card audit-card">
        <strong>${esc(eventLabel(event.event_type))}</strong>
        <p>${fmtDate(event.created_at)}</p>
        <p>${esc(eventSummary(event))}</p>
      </article>
    `).join("")
    : `<p class="muted">Решений по этому диалогу пока нет.</p>`;
}

async function loadConversations() {
  if (!$("#conversationList")) return;
  const query = conversationQuery();
  updateConversationExportLink();
  state.outreachConversations = await api(`/api/outreach/conversations${query ? `?${query}` : ""}`);
  const reviewCount = state.outreachConversations.filter((item) => ["waiting_reply_review", "manual_reply_needed"].includes(item.status)).length;
  const approvalCount = state.outreachConversations.reduce((sum, item) => sum + Number(item.approval_total || 0), 0);
  const repliedCount = state.outreachConversations.filter((item) => Number(item.inbound_total || 0) > 0).length;
  $("#conversationSummary").innerHTML = `
    <span>Диалогов на экране: <strong>${state.outreachConversations.length}</strong></span>
    <span>Требуют решения: <strong>${reviewCount}</strong></span>
    <span>С входящими ответами: <strong>${repliedCount}</strong></span>
    <span>Follow-up ждут подтверждения: <strong>${approvalCount}</strong></span>
  `;
  $("#conversationList").innerHTML = renderConversationCards(state.outreachConversations, "Диалогов по текущему фильтру нет.");
  $$("[data-conversation-preset]").forEach((button) => {
    button.classList.toggle("active", button.dataset.conversationPreset === state.conversationPreset);
  });
}

async function loadReviewConversations() {
  if (!$("#reviewList")) return;
  const query = reviewQuery();
  updateReviewExportLink();
  state.reviewConversations = await api(`/api/outreach/conversations?${query}`);
  const approvalCount = state.reviewConversations.reduce((sum, item) => sum + Number(item.approval_total || 0), 0);
  const unknownCount = state.reviewConversations.filter((item) => !item.classification || item.classification === "unknown").length;
  $("#reviewSummary").innerHTML = `
    <span>Ждут решения: <strong>${state.reviewConversations.length}</strong></span>
    <span>Без классификации: <strong>${unknownCount}</strong></span>
    <span>Follow-up ждут разрешения: <strong>${approvalCount}</strong></span>
  `;
  $("#reviewList").innerHTML = renderConversationCards(
    state.reviewConversations,
    "Сейчас нет диалогов, которые требуют решения. Когда придет ответ, он появится здесь.",
  );
}

async function openConversation(conversationId) {
  if (!state.mailboxes.length) {
    state.mailboxes = await api("/api/mailboxes");
  }
  const detail = await api(`/api/outreach/conversations/${conversationId}`);
  const lastMessage = detail.messages.at(-1);
  const lastOutbound = [...detail.messages].reverse().find((message) => message.direction === "outbound" && message.mailbox_id);
  const pendingFollowups = detail.queue.filter((item) => Number(item.outreach_step_position || 0) > 1 && ["pending", "retrying"].includes(item.status));
  const mailboxOptions = state.mailboxes
    .filter((mailbox) => mailbox.is_active)
    .map((mailbox) => `<option value="${mailbox.id}" ${mailbox.id === lastOutbound?.mailbox_id ? "selected" : ""}>${esc(mailbox.email)}</option>`)
    .join("");
  const replySubject = lastMessage?.subject && /^re:/i.test(lastMessage.subject)
    ? lastMessage.subject
    : `Re: ${lastMessage?.subject || detail.conversation.email}`;
  $("#conversationDialogTitle").textContent = `${detail.conversation.company || detail.conversation.email} · ${statusLabel(detail.conversation.status)}`;
  $("#conversationDetail").innerHTML = `
    <div class="summary-line">
      <span>Email: <strong>${esc(detail.conversation.email)}</strong></span>
      <span>Статус: <strong>${esc(statusLabel(detail.conversation.status))}</strong></span>
      <span>Класс: <strong>${esc(statusLabel(detail.conversation.classification || "unknown"))}</strong></span>
      <span>Следующее действие: <strong>${esc(nextActionLabel(detail.conversation.next_action))}</strong></span>
    </div>
    ${classificationSelect(detail.conversation)}
    <h3>История решений</h3>
    <div class="cards conversation-audit">
      ${renderConversationEvents(detail.events)}
    </div>
    <h3>Переписка</h3>
    <div class="cards conversation-thread">
      ${detail.messages.length
        ? detail.messages.map((message) => `
          <article class="card">
            <strong>${message.direction === "outbound" ? "Исходящее" : "Входящее"} · ${esc(message.subject)}</strong>
            ${pill(message.type)} ${message.threading_mode ? pill(message.threading_mode) : ""} ${message.reply_classification ? pill(message.reply_classification) : ""}
            <p>${esc(message.mailbox_email || "")} · ${fmtDate(message.received_at || message.sent_at || message.created_at)}</p>
            <pre>${esc(message.body_text || "")}</pre>
          </article>
        `).join("")
        : `<p class="muted">Писем в диалоге пока нет.</p>`}
    </div>
    <h3>Ручной ответ</h3>
    <form class="form manual-reply-form" data-conversation-reply-form="${detail.conversation.id}">
      <select name="mailbox_id" required>
        <option value="">Выбери mailbox отправителя</option>
        ${mailboxOptions}
      </select>
      <input name="subject" value="${esc(replySubject)}" placeholder="Тема ответа" required />
      <textarea name="body_text" placeholder="Текст ответа" required></textarea>
      <label class="check"><input name="stop_sequence" type="checkbox" checked /> После ручного ответа остановить будущие follow-up</label>
      <button>Отправить ответ</button>
    </form>
    <h3>Очередь по этому диалогу</h3>
    ${pendingFollowups.length ? `
      <form class="form compact-form" data-conversation-delay-form="${detail.conversation.id}">
        <label>
          <span>Отложить будущие follow-up</span>
          <input name="delay_days" type="number" min="1" max="60" step="1" value="7" required />
        </label>
        <p class="muted">Будут перенесены письма в очереди: ${pendingFollowups.length}. После переноса они останутся на ручном подтверждении.</p>
        <button>Отложить follow-up</button>
      </form>
    ` : `<p class="muted">Активных follow-up для переноса сейчас нет.</p>`}
    <div class="cards">
      ${detail.queue.length
        ? detail.queue.map((item) => `
          <article class="card">
            <strong>Шаг ${esc(item.outreach_step_position || "")} · ${esc(item.outreach_subject || item.subject_override || "")}</strong>
            ${pill(item.status)} ${item.requires_approval && !item.approved_at ? pill("approval") : ""}
            <p>${fmtDate(item.scheduled_at)} · ${esc(queueStatusHint(item))}</p>
          </article>
        `).join("")
        : `<p class="muted">Очереди по этому диалогу нет.</p>`}
    </div>
  `;
  $("#conversationDialog").showModal();
}

async function loadWarmup() {
  state.warmup = await api(`/api/warmup?page=${state.warmupPage}&pageSize=${state.warmupPageSize}`);
  state.warmupPage = state.warmup.pagination.page;
  $("#warmupStats").innerHTML = `
    <p>Отправлено warmup: <strong>${state.warmup.stats.sent}</strong></p>
    <p>Ответов warmup: <strong>${state.warmup.stats.replies}</strong></p>
    <p>Ошибок: <strong>${state.warmup.stats.errors}</strong></p>
  `;
  $("#warmupMailboxList").innerHTML = state.warmup.mailboxes
    .map(
      (mailbox) => `
        <article class="card warmup-mailbox-card">
          <div class="warmup-mailbox-head">
            <div>
              <strong>${esc(mailbox.name)}</strong>
              <p>${esc(mailbox.email)}</p>
            </div>
            ${pill(mailbox.health_status)}
          </div>
          <div id="mailboxActionResult-${mailbox.id}">${actionResultHtml(state.actionResults.mailboxes[mailbox.id])}</div>
          <div class="warmup-controls">
            <form class="warmup-limit-form" data-warmup-limit="${mailbox.id}">
              <label><span>Лимит</span><input name="daily_warmup_limit" type="number" min="1" step="1" value="${mailbox.daily_warmup_limit}" required /></label>
              <button>Сохранить</button>
            </form>
            <button data-toggle-warmup="${mailbox.id}" data-enabled="${!mailbox.warmup_enabled}">${mailbox.warmup_enabled ? "Выключить" : "Включить"}</button>
          </div>
        </article>
      `,
    )
    .join("");
  const pagination = state.warmup.pagination;
  const from = pagination.total ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const to = Math.min(pagination.page * pagination.pageSize, pagination.total);
  $("#warmupEventsTable").innerHTML = `
    <thead><tr><th>Время</th><th>Тип</th><th>Payload</th></tr></thead>
    <tbody>${state.warmup.events.length
      ? state.warmup.events
        .map((event) => `<tr><td>${fmtDate(event.created_at)}</td><td>${event.event_type}</td><td><pre>${esc(JSON.stringify(event.payload, null, 2))}</pre></td></tr>`)
        .join("")
      : `<tr><td colspan="3" class="muted">Warmup событий пока нет.</td></tr>`}</tbody>
  `;
  $("#warmupPagination").innerHTML = `
    <span>${from}-${to} из ${pagination.total} · страница ${pagination.page} из ${pagination.totalPages}</span>
    <div>
      <button data-warmup-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>Назад</button>
      <button data-warmup-page="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? "disabled" : ""}>Вперёд</button>
    </div>
  `;
}

async function loadSuppressions() {
  state.suppressions = await api("/api/suppressions");
  $("#suppressionList").innerHTML = state.suppressions.length
    ? state.suppressions
        .map(
          (item) => `
            <article class="card">
              <strong>${esc(item.email || item.domain)}</strong>
              <p>${esc(item.reason)} · ${esc(item.source)} · ${fmtDate(item.created_at)}</p>
              <button data-delete-suppression="${item.id}">Удалить</button>
            </article>
          `,
        )
        .join("")
    : `<p class="muted">Стоп-лист пуст.</p>`;
}

async function loadSettings() {
  const settings = await api("/api/settings");
  state.settings = settings;
  const inboxSyncInterval = inboxSyncIntervalParts(settings.runtime.inboxSyncIntervalSeconds);
  $("#settingsPanel").innerHTML = `
    <form id="runtimeSettingsForm" class="settings-form">
      <label class="settings-row">
        <span>Отправка</span>
        <select name="mailDryRun">
          <option value="true" ${settings.runtime.dryRun ? "selected" : ""}>Dry-run: не отправлять письма</option>
          <option value="false" ${!settings.runtime.dryRun ? "selected" : ""}>Реальная отправка</option>
        </select>
      </label>
      <label class="settings-row">
        <span>Tracking URL</span>
        <input name="publicTrackingUrl" value="${esc(settings.runtime.publicTrackingUrl || "")}" placeholder="https://your-public-tunnel.example" />
      </label>
      <label class="settings-row">
        <span>Лимит вложений</span>
        <input name="maxAttachmentMb" type="number" min="1" max="200" step="1" value="${settings.runtime.maxAttachmentMb}" />
      </label>
      <label class="settings-row">
        <span>Часовой пояс</span>
        <select name="timeZone">
          ${renderTimeZoneOptions(settings.runtime.timeZone)}
        </select>
      </label>
      <label class="settings-row">
        <span>Проверять входящие</span>
        <div class="settings-inline-controls">
          <input name="inboxSyncMinutes" type="number" min="0" max="60" step="1" value="${inboxSyncInterval.minutes}" aria-label="Минуты между проверками входящих" />
          <small>мин</small>
          <input name="inboxSyncSeconds" type="number" min="0" max="59" step="1" value="${inboxSyncInterval.seconds}" aria-label="Секунды между проверками входящих" />
          <small>сек</small>
        </div>
      </label>
      <label class="settings-row">
        <span>После ответа остановить</span>
        <select name="outreachStopScope">
          <option value="contact_only" ${settings.runtime.outreachStopScope === "contact_only" ? "selected" : ""}>Только этот email</option>
          <option value="same_domain" ${settings.runtime.outreachStopScope === "same_domain" ? "selected" : ""}>Всех с тем же доменом</option>
          <option value="same_company" ${settings.runtime.outreachStopScope === "same_company" ? "selected" : ""}>Всех из той же компании</option>
        </select>
      </label>
      <div class="settings-footer">
        <p>Вложения: ${esc(settings.runtime.attachmentDir)}</p>
        <p>Время в интерфейсе и окнах отправки: ${esc(settings.runtime.timeZone || currentTimeZone())}</p>
        <p>Входящие проверяются каждые ${Number(settings.runtime.inboxSyncIntervalSeconds || 60)} сек.</p>
        <button>Сохранить</button>
      </div>
    </form>
    <p class="settings-note">Сохраняется в БД и применяется без пересоздания контейнеров.</p>
  `;
  renderSetupChecklist();
}

async function loadEvents() {
  const events = await api("/api/events");
  $("#eventsTable").innerHTML = `
    <thead><tr><th>Когда</th><th>Что произошло</th><th>Кратко</th><th>Детали</th></tr></thead>
    <tbody>
      ${events.length
        ? events.map((event) => `
          <tr>
            <td>${fmtDate(event.created_at)}</td>
            <td><strong>${esc(eventLabel(event.event_type))}</strong><br><span class="muted">${esc(event.event_type)}</span></td>
            <td>${esc(eventSummary(event))}</td>
            <td><details><summary>Показать</summary><pre>${esc(JSON.stringify(event.payload || {}, null, 2))}</pre></details></td>
          </tr>
        `).join("")
        : `<tr><td colspan="4" class="muted">Событий пока нет. Когда сервис проверит email, отправит письмо или получит ответ, записи появятся здесь.</td></tr>`}
    </tbody>
  `;
}

function updateSyncStatusInActionResult(syncStatus) {
  const apply = (result) => {
    if (!result || !String(result.title || "").includes("Синхронизация")) return false;
    result.details = typeof result.details === "object" && result.details
      ? { ...result.details, syncStatus }
      : { syncStatus };
    return true;
  };
  const shouldRenderGlobal = apply(state.actionResults.global);
  for (const [mailboxId, result] of Object.entries(state.actionResults.mailboxes)) {
    if (apply(result)) renderMailboxActionResult(mailboxId);
  }
  if (shouldRenderGlobal) renderGlobalActionResult();
}

function refreshInboxSyncRelated() {
  Promise.all([loadEvents(), loadInbox(), loadConversations(), loadReviewConversations(), loadDashboard()])
    .then(async () => {
      const syncStatus = await api("/api/inbox/sync-status");
      updateSyncStatusInActionResult(syncStatus);
    })
    .catch(() => {});
}

function scheduleInboxSyncRefreshes() {
  refreshInboxSyncRelated();
  setTimeout(refreshInboxSyncRelated, 4000);
  setTimeout(refreshInboxSyncRelated, 12000);
}

async function refresh() {
  await Promise.all([
    loadHealth(),
    loadEnvCheck(),
    loadDashboard(),
    loadSegments(),
    loadLeads(),
    loadOutreachImports(),
    loadOutreachDrafts(),
    loadMailboxes(),
    loadCampaigns(),
    loadQueue(),
    loadInbox(),
    loadConversations(),
    loadReviewConversations(),
    loadWarmup(),
    loadSuppressions(),
    loadEvents(),
    loadSettings(),
  ]);
  renderAiExportFilters();
}

window.addEventListener("hashchange", () => switchView(viewFromLocation(), { updateUrl: false }));
$$("nav button").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$("#refreshBtn").addEventListener("click", (event) => runAction({
  title: "Обновление данных",
  button: event.currentTarget,
}, async () => {
  await refresh();
  setActionResult({ status: "success", title: "Обновление данных", message: "Данные с сервера обновлены." });
}));

$("#logoutBtn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login.html";
});
$("#leadSearch").addEventListener("input", () => loadLeads());
$("#leadSegmentFilter").addEventListener("change", () => loadLeads());
$("#leadValidationFilter").addEventListener("change", () => {
  state.leadQuickFilter = "custom";
  loadLeads();
});
$("#leadFiltersReset").addEventListener("click", () => {
  $("#leadSearch").value = "";
  $("#leadSegmentFilter").value = "";
  $("#leadValidationFilter").value = "";
  state.leadQuickFilter = "all";
  loadLeads();
});
$$("[data-lead-quick-filter]").forEach((button) => button.addEventListener("click", () => {
  state.leadQuickFilter = button.dataset.leadQuickFilter || "all";
  $("#leadValidationFilter").value = "";
  loadLeads();
}));
$$("[data-queue-filter]").forEach((button) => button.addEventListener("click", () => {
  state.queueFilter = button.dataset.queueFilter || "waiting";
  loadQueue();
}));
$$("[data-inbox-filter]").forEach((button) => button.addEventListener("click", () => {
  state.inboxFilter = button.dataset.inboxFilter || "all";
  loadInbox();
}));
$("#activeCampaign").addEventListener("change", () => loadCampaignLeads());
$("#stepCampaign").addEventListener("change", () => renderCampaignStepList());
$("#stepEditResetBtn").addEventListener("click", () => resetStepForm());
$("#campaignEditResetBtn").addEventListener("click", () => resetCampaignForm());
$("#campaignLeadSelectAll").addEventListener("change", (event) => {
  const ids = state.campaignAvailableLeads.map((lead) => lead.id);
  state.selectedCampaignLeadIds = event.currentTarget.checked ? new Set(ids) : new Set();
  renderCampaignAvailableLeads();
});

$("#campaignAvailableLeadsTable").addEventListener("change", (event) => {
  const leadId = event.target.dataset.campaignLeadId;
  if (!leadId) return;
  if (event.target.checked) {
    state.selectedCampaignLeadIds.add(leadId);
  } else {
    state.selectedCampaignLeadIds.delete(leadId);
  }
  updateCampaignLeadSelection();
});

$("#campaignLeadsTable").addEventListener("change", (event) => {
  const enrollmentId = event.target.dataset.campaignSendToggle;
  if (!enrollmentId) return;
  const enabled = event.target.checked;
  runAction({
    title: enabled ? "Вернуть лида в отправку" : "Выключить лида из отправки",
    button: event.target,
  }, async () => {
    const result = await api(`/api/enrollments/${enrollmentId}/${enabled ? "resume" : "pause"}`, { method: "POST" });
    await loadCampaignLeads();
    setActionResult({
      status: "success",
      title: enabled ? "Вернуть лида в отправку" : "Выключить лида из отправки",
      message: enabled
        ? "Лид снова активен и попадет в следующий запуск."
        : `Лид больше не будет отправляться. Отменено писем в очереди: ${result.cancelled_queue}.`,
      details: result,
    });
  });
});

document.body.addEventListener("focusin", (event) => {
  if (event.target.matches(".segment-input")) renderSegmentPicker(event.target);
});

document.body.addEventListener("input", (event) => {
  if (event.target.matches(".segment-input")) renderSegmentPicker(event.target);
});

document.body.addEventListener("click", (event) => {
  const editCampaignId = event.target.dataset.editCampaign;
  if (editCampaignId) {
    editCampaign(editCampaignId);
    return;
  }

  const editStepId = event.target.dataset.editStep;
  if (editStepId) {
    editCampaignStep(editStepId);
    return;
  }

  const removeSegment = event.target.closest("[data-remove-segment]");
  if (removeSegment) {
    const picker = removeSegment.closest(".segment-picker");
    const next = selectedPickerSegments(picker).filter((segment) => segment !== removeSegment.dataset.removeSegment);
    setSegmentPickerValue(picker, next);
    return;
  }

  const segmentOption = event.target.closest("[data-segment-value]");
  if (segmentOption) {
    const picker = segmentOption.closest(".segment-picker");
    const input = picker.querySelector(".segment-input");
    if (picker.dataset.segmentMulti !== undefined) {
      const value = segmentOption.dataset.segmentValue;
      const current = selectedPickerSegments(picker);
      const exists = current.some((segment) => segment.toLowerCase() === value.toLowerCase());
      setSegmentPickerValue(picker, exists ? current.filter((segment) => segment.toLowerCase() !== value.toLowerCase()) : [...current, value]);
      renderSegmentPicker(input);
    } else {
      input.value = segmentOption.dataset.segmentValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      closeSegmentPickers();
    }
    return;
  }
  if (!event.target.closest(".segment-picker")) closeSegmentPickers();

  const go = event.target.dataset.go;
  if (go) switchView(go);
  const campaignStep = event.target.dataset.campaignStep;
  if (campaignStep) switchCampaignStep(campaignStep);
});

document.body.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSegmentPickers();
});

function insertTextAtCursor(text) {
  const active = state.editorTarget || document.activeElement;
  if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) {
    active.focus();
    active.setRangeText(text, active.selectionStart, active.selectionEnd, "end");
    active.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  (active?.id === "htmlEditor" ? active : $("#htmlEditor"))?.focus();
  document.execCommand("insertText", false, text);
}

document.body.addEventListener("focusin", (event) => {
  if (event.target.matches("#stepSubject, #htmlEditor, textarea[name='body_template_text']")) {
    state.editorTarget = event.target;
  }
});

document.body.addEventListener("click", (event) => {
  const commandButton = event.target.closest("[data-editor-cmd]");
  const variableButton = event.target.closest("[data-editor-var]");
  const linkButton = event.target.closest("[data-editor-link]");
  if (commandButton) {
    $("#htmlEditor").focus();
    document.execCommand(commandButton.dataset.editorCmd, false, null);
  }
  if (variableButton) {
    insertTextAtCursor(variableButton.dataset.editorVar);
  }
  if (linkButton) {
    const url = prompt("URL ссылки");
    if (!url) return;
    $("#htmlEditor").focus();
    document.execCommand("createLink", false, url);
  }
});

$("#leadsTable").addEventListener("click", async (event) => {
  const row = event.target.closest("tr[data-lead-id]");
  if (!row) return;
  const detail = await api(`/api/leads/${row.dataset.leadId}/detail`);
  $("#leadDialogTitle").textContent = `${detail.lead.company} · ${detail.lead.email}`;
  $("#leadDetail").innerHTML = `
    <div class="grid two">
      <section>
        <h3>Профиль</h3>
        <p>${pill(detail.lead.status)} ${pill(detail.lead.validation_status)}</p>
        <p>${esc(detail.lead.contact_name || "")} ${esc(detail.lead.position || "")}</p>
        <p>${esc(detail.lead.segment || "")} · ${esc(detail.lead.city || "")}</p>
        <p>${esc(detail.lead.pain || "")}</p>
      </section>
      <section>
        <h3>Открытия</h3>
        <p>Всего: ${detail.opens.length}</p>
        <p>Первые: ${detail.opens.filter((item) => item.is_first_open).length}</p>
      </section>
    </div>
    <h3>Переписка</h3>
    <div class="cards">${detail.messages
      .map(
        (msg) => `
          <article class="card">
            <strong>${esc(msg.direction)} · ${esc(msg.subject)}</strong> ${pill(msg.status)} ${msg.reply_classification ? pill(msg.reply_classification) : ""}
            <p>${esc(msg.campaign_name || "")} · ${esc(msg.mailbox_email || "")} · ${fmtDate(msg.sent_at || msg.received_at || msg.created_at)}</p>
            <pre>${esc((msg.body_text || "").slice(0, 2500))}</pre>
          </article>
        `,
      )
      .join("")}</div>
    <h3>События</h3>
    <div class="cards">${detail.events
      .map((event) => `<article class="card"><strong>${event.event_type}</strong><p>${fmtDate(event.created_at)}</p><pre>${esc(JSON.stringify(event.payload, null, 2))}</pre></article>`)
      .join("")}</div>
  `;
  $("#leadDialog").showModal();
});

$("#leadForm").addEventListener("submit", (event) => runAction({
  title: "Добавление лида",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const result = await api("/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formJson(event.target)),
  });
  event.target.reset();
  await refresh();
  setActionResult({ status: "success", title: "Добавление лида", message: "Лид добавлен в базу.", details: result });
}));

$("#importForm").addEventListener("submit", (event) => runAction({
  title: "Импорт CSV",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const body = new FormData(event.target);
  const result = await api("/api/leads/import", { method: "POST", body });
  await refresh();
  setActionResult({
    status: "success",
    title: "Импорт CSV",
    message: `Импортировано: ${result.imported}, дубли: ${result.duplicates}, пропущено: ${result.skipped}.`,
    details: result,
  });
}));

$("#outreachImportForm").addEventListener("submit", (event) => runAction({
  title: "Импорт персональных писем",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  if (!state.outreachImportPreview) {
    setActionResult({
      status: "warn",
      title: "Импорт персональных писем",
      message: "Сначала выбери файл из шаблона. После выбора список строк появится автоматически.",
    });
    return;
  }
  const body = new FormData(event.target);
  const result = await api("/api/outreach/imports", { method: "POST", body });
  event.target.reset();
  state.outreachImportPreview = null;
  $("#outreachImportPreview").hidden = true;
  $("#createOutreachDraftsBtn").disabled = true;
  await Promise.all([loadLeads(), loadOutreachImports(), loadOutreachDrafts()]);
  switchView("outreachDrafts");
  setActionResult({
    status: result.rows_blocked ? "warn" : "success",
    title: "Импорт персональных писем",
    message: `Файл обработан: готово ${result.rows_ready}, нужно исправить ${result.rows_blocked}.`,
    details: result,
  });
}));

async function previewOutreachImport() {
  const form = $("#outreachImportForm");
  const body = new FormData(form);
  if (!body.get("file")?.name) {
    setActionResult({
      status: "warn",
      title: "Чтение файла",
      message: "Сначала выбери Excel или CSV файл.",
    });
    return;
  }
  state.outreachImportPreview = await api("/api/outreach/imports/preview", { method: "POST", body });
  renderOutreachImportPreview();
  setActionResult({
    status: "success",
    title: "Чтение файла",
    message: `Файл прочитан: строк ${state.outreachImportPreview.rowsTotal}. Проверь таблицу ниже и создай черновики.`,
    details: state.outreachImportPreview.errors,
  });
}

$("#outreachImportForm input[name='file']").addEventListener("change", () => {
  state.outreachImportPreview = null;
  $("#outreachImportPreview").hidden = true;
  $("#createOutreachDraftsBtn").disabled = true;
  const file = $("#outreachImportForm input[name='file']").files?.[0];
  if (!file) return;
  runAction({
    title: "Чтение файла",
    pending: "Читаю файл и готовлю список строк...",
  }, previewOutreachImport);
});

async function preflightOutreachDrafts(draftIds) {
  return api("/api/outreach/drafts/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft_ids: draftIds }),
  });
}

async function reviewOutreachDrafts(draftIds) {
  const result = await preflightOutreachDrafts(draftIds);
  state.outreachDraftLaunchReview = {
    ...result,
    signature: selectedOutreachDraftSignature(draftIds),
  };
  renderOutreachDraftLaunchReview();
  return result;
}

async function startOutreachDrafts(draftIds) {
  const preflight = await preflightOutreachDrafts(draftIds);
  state.outreachDraftLaunchReview = {
    ...preflight,
    signature: selectedOutreachDraftSignature(draftIds),
  };
  renderOutreachDraftLaunchReview();
  if (!preflight.ok) {
    setActionResult({
      status: "warn",
      title: "Проверка выбранных черновиков",
      message: `Запуск остановлен: ошибок ${preflight.errors.length}. Исправь их в таблице проверки и запусти снова.`,
      details: preflight,
    });
    return;
  }
  const result = await api("/api/outreach/drafts/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft_ids: draftIds, mode: "auto" }),
  });
  state.selectedOutreachDraftIds.clear();
  clearOutreachDraftLaunchReview();
  await Promise.all([loadOutreachDrafts(), loadQueue()]);
  switchView("queue");
  setActionResult({
    status: result.errors?.length ? "warn" : "success",
    title: "Запуск персональных писем",
    message: `В очередь поставлено: ${result.queued}. Ошибок: ${result.errors?.length || 0}.`,
    details: result,
  });
}

$("#preflightSelectedDraftsBtn").addEventListener("click", (event) => runAction({
  title: "Проверка выбранных черновиков",
  button: event.currentTarget,
}, async () => {
  const draftIds = selectedReadyOutreachDraftIds();
  if (!draftIds.length) {
    clearOutreachDraftLaunchReview();
    setActionResult({
      status: "warn",
      title: "Проверка выбранных черновиков",
      message: selectedReadyWarningMessage("Проверить"),
    });
    return;
  }
  const result = await reviewOutreachDrafts(draftIds);
  setActionResult({
    status: result.ok ? "success" : "warn",
    title: "Проверка выбранных черновиков",
    message: result.ok
      ? `Можно запускать: выбрано ${result.stats.selected}. ${result.imapUncheckedMailboxes?.length ? `IMAP-проверка запущена автоматически для ящиков: ${result.imapUncheckedMailboxes.join(", ")}.` : "Критичных замечаний нет."}`
      : `Нужно исправить: ошибок ${result.errors.length}, предупреждений ${result.warnings.length}.`,
    details: result.ok ? undefined : result,
  });
}));

$("#startSelectedDraftsBtn").addEventListener("click", (event) => runAction({
  title: "Запуск выбранных черновиков",
  button: event.currentTarget,
}, async () => {
  const draftIds = selectedReadyOutreachDraftIds();
  if (!draftIds.length) {
    clearOutreachDraftLaunchReview();
    setActionResult({
      status: "warn",
      title: "Запуск выбранных черновиков",
      message: selectedReadyWarningMessage("Запустить"),
    });
    return;
  }
  await startOutreachDrafts(draftIds);
}));

$("#deleteSelectedDraftsBtn").addEventListener("click", (event) => {
  const draftIds = selectedDeletableOutreachDraftIds();
  if (!draftIds.length) {
    setActionResult({
      status: "warn",
      title: "Удаление выбранных черновиков",
      message: "Среди выбранных нет черновиков, которые можно безопасно удалить.",
    });
    return;
  }
  if (!window.confirm(`Удалить выбранные черновики: ${draftIds.length}? Это уберет их из списка черновиков.`)) return;
  runAction({
    title: "Удаление выбранных черновиков",
    button: event.currentTarget,
  }, async () => {
    const deleted = [];
    const errors = [];
    for (const draftId of draftIds) {
      try {
        const result = await api(`/api/outreach/drafts/${draftId}`, { method: "DELETE" });
        deleted.push(result);
        state.selectedOutreachDraftIds.delete(draftId);
      } catch (error) {
        errors.push({ draftId, error: errorMessage(error), details: error.data || error.message });
      }
    }
    clearOutreachDraftLaunchReview();
    await Promise.all([loadOutreachDrafts(), loadOutreachImports(), loadDashboard()]);
    if (state.openOutreachDraftId && !state.outreachDrafts.some((draft) => draft.id === state.openOutreachDraftId)) {
      refreshOpenOutreachDraftDrawer(state.openOutreachDraftId);
    }
    setActionResult({
      status: errors.length ? "warn" : "success",
      title: "Удаление выбранных черновиков",
      message: `Удалено: ${deleted.length}. Ошибок: ${errors.length}.`,
      details: { deleted, errors },
    });
  });
});

document.body.addEventListener("change", (event) => {
  if (event.target.id === "outreachDraftSelectAll") {
    state.selectedOutreachDraftIds = event.target.checked
      ? new Set(state.outreachDrafts.filter(canDeleteOutreachDraft).map((draft) => draft.id))
      : new Set();
    clearOutreachDraftLaunchReview();
    loadOutreachDrafts();
    return;
  }
  const draftId = event.target.dataset.outreachDraftSelect;
  if (!draftId) return;
  if (event.target.checked) state.selectedOutreachDraftIds.add(draftId);
  else state.selectedOutreachDraftIds.delete(draftId);
  clearOutreachDraftLaunchReview();
  loadOutreachDrafts();
});

document.body.addEventListener("submit", (event) => {
  const draftId = event.target.dataset.outreachDraftForm;
  if (!draftId) return;
  event.preventDefault();
  runAction({
    title: "Сохранение черновика",
    button: event.submitter,
  }, async () => {
    const payload = formJson(event.target);
    const result = await api(`/api/outreach/drafts/${draftId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadOutreachDrafts();
    refreshOpenOutreachDraftDrawer(draftId);
    setActionResult({
      status: result.status === "ready" ? "success" : "warn",
      title: "Сохранение черновика",
      message: result.status === "ready" ? "Черновик готов к запуску." : "Черновик сохранен, но еще есть ошибки.",
      details: result,
    });
  });
});

document.body.addEventListener("submit", (event) => {
  const draftId = event.target.dataset.outreachStepForm;
  const position = event.target.dataset.position;
  if (!draftId || !position) return;
  event.preventDefault();
  runAction({
    title: "Сохранение follow-up",
    button: event.submitter,
  }, async () => {
    const payload = formJson(event.target);
    payload.delay_days = Number(payload.delay_days || 0);
    const result = await api(`/api/outreach/drafts/${draftId}/steps/${position}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await Promise.all([loadOutreachDrafts(), loadQueue()]);
    refreshOpenOutreachDraftDrawer(draftId);
    const hasGuardErrors = Array.isArray(result.guard_errors) && result.guard_errors.length > 0;
    setActionResult({
      status: hasGuardErrors ? "warn" : "success",
      title: "Сохранение follow-up",
      message: result.removed
        ? "Follow-up удален из цепочки."
        : hasGuardErrors
          ? "Follow-up сохранен как “нужно исправить”: убери незаполненные переменные перед запуском."
          : "Follow-up сохранен.",
      details: result,
    });
  });
});

document.body.addEventListener("submit", (event) => {
  const conversationId = event.target.dataset.conversationReplyForm;
  if (!conversationId) return;
  event.preventDefault();
  runAction({
    title: "Отправка ручного ответа",
    button: event.submitter,
  }, async () => {
    const payload = formJson(event.target);
    payload.stop_sequence = payload.stop_sequence === "on";
    const result = await api(`/api/outreach/conversations/${conversationId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await Promise.all([loadConversations(), loadReviewConversations(), loadQueue(), loadOutreachDrafts()]);
    await openConversation(conversationId);
    setActionResult({
      status: "success",
      title: "Отправка ручного ответа",
      message: result.dryRun
        ? `Dry-run: ответ сохранен, наружу не отправлен. Отменено follow-up: ${result.cancelledQueue}.`
        : `Ответ отправлен. Отменено follow-up: ${result.cancelledQueue}.`,
      details: result,
    });
  });
});

document.body.addEventListener("submit", (event) => {
  const conversationId = event.target.dataset.conversationDelayForm;
  if (!conversationId) return;
  event.preventDefault();
  runAction({
    title: "Перенос follow-up",
    button: event.submitter,
  }, async () => {
    const payload = formJson(event.target);
    payload.delay_days = Number(payload.delay_days || 0);
    const result = await api(`/api/outreach/conversations/${conversationId}/delay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await Promise.all([loadConversations(), loadReviewConversations(), loadQueue(), loadOutreachDrafts()]);
    await openConversation(conversationId);
    setActionResult({
      status: result.delayed_queue ? "success" : "warn",
      title: "Перенос follow-up",
      message: result.delayed_queue
        ? `Follow-up перенесен. Писем в очереди: ${result.delayed_queue}. Следующая отправка: ${fmtDate(result.next_scheduled_at)}.`
        : "Активных follow-up для переноса не найдено.",
      details: result,
    });
  });
});

document.body.addEventListener("click", (event) => {
  const draftFilter = event.target.closest("[data-outreach-draft-filter]");
  if (draftFilter) {
    state.outreachDraftFilter = draftFilter.dataset.outreachDraftFilter || "ready";
    state.selectedOutreachDraftIds = new Set();
    clearOutreachDraftLaunchReview();
    loadOutreachDrafts();
    return;
  }

  const draftId = event.target.dataset.startDraft;
  const cancelDraftId = event.target.dataset.cancelDraft;
  const editDraftId = event.target.dataset.editOutreachDraft;
  const deleteDraftId = event.target.dataset.deleteDraft;
  if (editDraftId) {
    openOutreachDraftDrawer(editDraftId);
    return;
  }
  if (deleteDraftId) {
    const draft = state.outreachDrafts.find((item) => item.id === deleteDraftId);
    const label = draft ? `${draft.company || "Без компании"} · ${draft.to_email}` : "этот черновик";
    if (!window.confirm(`Удалить черновик “${label}”? Это уберет письмо из списка черновиков.`)) return;
    runAction({
      title: "Удаление черновика",
      button: event.target,
    }, async () => {
      const result = await api(`/api/outreach/drafts/${deleteDraftId}`, { method: "DELETE" });
      state.selectedOutreachDraftIds.delete(deleteDraftId);
      clearOutreachDraftLaunchReview();
      await Promise.all([loadOutreachDrafts(), loadOutreachImports(), loadDashboard()]);
      refreshOpenOutreachDraftDrawer(deleteDraftId);
      setActionResult({
        status: "success",
        title: "Удаление черновика",
        message: `Черновик удален. Удалено шагов цепочки: ${result.deleted_steps}.`,
        details: result,
      });
    });
    return;
  }
  if (draftId) {
    runAction({
      title: "Запуск черновика",
      button: event.target,
    }, async () => startOutreachDrafts([draftId]));
    return;
  }
  if (cancelDraftId) {
    runAction({
      title: "Отмена черновика",
      button: event.target,
    }, async () => {
      const result = await api(`/api/outreach/drafts/${cancelDraftId}/cancel`, { method: "POST" });
      state.selectedOutreachDraftIds.delete(cancelDraftId);
      await Promise.all([loadOutreachDrafts(), loadQueue(), loadConversations(), loadReviewConversations()]);
      if ($("#outreachDraftDrawer").open) refreshOpenOutreachDraftDrawer(cancelDraftId);
      setActionResult({
        status: "success",
        title: "Отмена черновика",
        message: `Черновик отменен. Писем снято с очереди: ${result.cancelled_queue}.`,
        details: result,
      });
    });
  }
});

["conversationStatusFilter", "conversationClassificationFilter", "conversationReviewOnly"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    state.conversationPreset = "custom";
    loadConversations();
  });
});

$$("[data-conversation-preset]").forEach((button) => button.addEventListener("click", () => {
  applyConversationPreset(button.dataset.conversationPreset || "all");
  loadConversations();
}));

$("#reviewClassificationFilter")?.addEventListener("change", () => loadReviewConversations());

[
  "aiExportStatus",
  "aiExportClassification",
  "aiExportSegment",
  "aiExportCampaign",
  "aiExportImport",
  "aiExportMailbox",
  "aiExportDateFrom",
  "aiExportDateTo",
  "aiExportReviewOnly",
  "aiExportRepliedOnly",
].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", updateAiExportLinks);
});

document.body.addEventListener("click", (event) => {
  const openId = event.target.dataset.openConversation;
  const stopId = event.target.dataset.stopConversation;
  const continueId = event.target.dataset.continueConversation;
  if (openId) {
    runAction({ title: "Открытие диалога", button: event.target }, async () => {
      await openConversation(openId);
      setActionResult({ status: "success", title: "Открытие диалога", message: "Диалог загружен." });
    });
    return;
  }
  if (stopId) {
    runAction({ title: "Остановка цепочки", button: event.target }, async () => {
      const result = await api(`/api/outreach/conversations/${stopId}/stop`, { method: "POST" });
      await Promise.all([loadConversations(), loadReviewConversations(), loadQueue(), loadOutreachDrafts()]);
      setActionResult({
        status: "success",
        title: "Остановка цепочки",
        message: `Отменено писем в очереди: ${result.cancelled_queue}.`,
        details: result,
      });
    });
    return;
  }
  if (continueId) {
    runAction({ title: "Продолжение follow-up", button: event.target }, async () => {
      const result = await api(`/api/outreach/conversations/${continueId}/continue`, { method: "POST" });
      await Promise.all([loadConversations(), loadReviewConversations(), loadQueue(), loadOutreachDrafts()]);
      setActionResult({
        status: "success",
        title: "Продолжение follow-up",
        message: `Разрешено писем в очереди: ${result.approved_queue}.`,
        details: result,
      });
    });
  }
});

$("#validateBtn").addEventListener("click", (event) => runAction({
  title: "Проверка email",
  button: event.currentTarget,
}, async () => {
  const result = await api("/api/validation/run", { method: "POST" });
  setActionResult({
    status: "success",
    title: "Проверка email",
    message: `В очередь поставлено ${result.queued} задач.`,
    details: result,
  });
}));

$("#mailboxForm").addEventListener("submit", (event) => runAction({
  title: "Сохранение почты",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const payload = formJson(event.target);
  payload.warmup_enabled = event.target.elements.warmup_enabled.checked;
  const result = await api("/api/mailboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  event.target.reset();
  await refresh();
  setActionResult({
    status: "success",
    title: "Сохранение почты",
    message: `Почта ${result.email} сохранена. Теперь нажми «Проверить SMTP/IMAP».`,
    details: result,
  });
}));

document.body.addEventListener("submit", (event) => {
  const warmupLimitId = event.target.dataset.warmupLimit;
  if (warmupLimitId) {
    event.preventDefault();
    runAction({
      title: "Сохранение лимита прогрева",
      target: { type: "mailbox", id: warmupLimitId },
      button: event.submitter,
    }, async () => {
      const dailyWarmupLimit = Number(event.target.elements.daily_warmup_limit.value);
      const result = await api(`/api/mailboxes/${warmupLimitId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_warmup_limit: dailyWarmupLimit }),
      });
      await refresh();
      setActionResult({
        status: "success",
        title: "Сохранение лимита прогрева",
        message: `Лимит для ${result.email} сохранен: ${result.daily_warmup_limit}/день.`,
        details: result,
        target: { type: "mailbox", id: warmupLimitId },
      });
    });
    return;
  }

  const mailboxId = event.target.dataset.mailboxEdit;
  if (!mailboxId) return;
  event.preventDefault();
  runAction({
    title: "Обновление подключения",
    target: { type: "mailbox", id: mailboxId },
    button: event.submitter,
  }, async () => {
    const payload = formJson(event.target);
    payload.smtp_port = Number(payload.smtp_port);
    payload.imap_port = Number(payload.imap_port);
    payload.daily_warmup_limit = Number(payload.daily_warmup_limit);
    payload.daily_send_limit = payload.daily_send_limit ? Number(payload.daily_send_limit) : "";
    payload.min_delay_minutes = Number(payload.min_delay_minutes);
    payload.max_delay_minutes = Number(payload.max_delay_minutes);
    payload.send_days = Array.isArray(payload.send_days)
      ? payload.send_days.map(Number)
      : payload.send_days
        ? [Number(payload.send_days)]
        : [];
    payload.is_active = event.target.elements.is_active.checked;
    payload.warmup_enabled = event.target.elements.warmup_enabled.checked;
    payload.smtp_secure = event.target.elements.smtp_secure.checked;
    payload.imap_secure = event.target.elements.imap_secure.checked;
    const result = await api(`/api/mailboxes/${mailboxId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await refresh();
    setActionResult({
      status: "success",
      title: "Обновление подключения",
      message: `Настройки ${result.email} сохранены. Теперь нажми «Проверить SMTP/IMAP».`,
      details: result,
      target: { type: "mailbox", id: mailboxId },
    });
  });
});

$("#campaignForm").addEventListener("submit", (event) => runAction({
  title: event.target.elements.campaign_id.value ? "Обновление кампании" : "Создание кампании",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  syncCampaignSegmentInput();
  const payload = formJson(event.target);
  const campaignId = payload.campaign_id;
  delete payload.campaign_id;
  payload.tracking_enabled = event.target.elements.tracking_enabled.checked;
  payload.manual_approval_required = event.target.elements.manual_approval_required.checked;
  const result = await api(campaignId ? `/api/campaigns/${campaignId}` : "/api/campaigns", {
    method: campaignId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  resetCampaignForm();
  await refresh();
  $("#activeCampaign").value = result.id;
  $("#stepCampaign").value = result.id;
  renderCampaignStepList();
  setActionResult({
    status: "success",
    title: campaignId ? "Обновление кампании" : "Создание кампании",
    message: campaignId ? `Кампания «${result.name}» обновлена.` : `Кампания «${result.name}» создана.`,
    details: result,
  });
  switchCampaignStep(campaignId ? "campaign" : "letter");
}));

$("#stepForm").addEventListener("submit", (event) => runAction({
  title: event.target.elements.step_id.value ? "Обновление шага" : "Добавление шага",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const payload = formJson(event.target);
  payload.body_template_html = $("#htmlEditor").innerHTML;
  const stepId = payload.step_id;
  delete payload.step_id;
  const result = await api(stepId ? `/api/steps/${stepId}` : `/api/campaigns/${payload.campaign_id}/steps`, {
    method: stepId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await refresh();
  resetStepForm();
  $("#stepCampaign").value = payload.campaign_id;
  renderCampaignStepList();
  setActionResult({
    status: "success",
    title: stepId ? "Обновление шага" : "Добавление шага",
    message: stepId ? `Шаг «${result.name}» обновлен.` : `Шаг «${result.name}» добавлен и показан справа.`,
    details: result,
  });
  switchCampaignStep("letter");
}));

$("#attachmentForm").addEventListener("submit", (event) => runAction({
  title: "Загрузка вложения",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const form = new FormData(event.target);
  const stepId = form.get("step_id");
  if (!stepId || stepId === "null") {
    throw new Error("Сначала добавь шаг письма, затем выбери его для вложения.");
  }
  form.delete("step_id");
  const result = await api(`/api/steps/${stepId}/attachments`, { method: "POST", body: form });
  event.target.reset();
  await refresh();
  setActionResult({ status: "success", title: "Загрузка вложения", message: "Вложение добавлено к шагу.", details: result });
  switchCampaignStep("letter");
}));

$("#enrollBtn").addEventListener("click", (event) => runAction({
  title: "Добавление лидов в кампанию",
  button: event.currentTarget,
}, async () => {
  const campaignId = $("#activeCampaign").value;
  const leadIds = [...state.selectedCampaignLeadIds];
  if (!leadIds.length) throw new Error("Выбери хотя бы одного лида в таблице ниже.");
  const mailboxIds = state.mailboxes.map((mailbox) => mailbox.id);
  const result = await api(`/api/campaigns/${campaignId}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lead_ids: leadIds, mailbox_ids: mailboxIds }),
  });
  await refresh();
  setActionResult({
    status: "success",
    title: "Добавление лидов в кампанию",
    message: `Выбранные лиды добавлены: ${leadIds.length}. Доступных почт для отправки: ${mailboxIds.length}.`,
    details: result,
  });
  state.selectedCampaignLeadIds = new Set();
  switchCampaignStep("check");
}));

$("#preflightBtn").addEventListener("click", (event) => runAction({
  title: "Проверка перед запуском",
  pending: "Проверяю кампанию и пробую безопасные автоисправления...",
  button: event.currentTarget,
}, async () => {
  const fixResult = await api(`/api/campaigns/${$("#activeCampaign").value}/preflight/fix`, { method: "POST" });
  const result = fixResult.preflight;
  $("#preflightResult").innerHTML = renderPreflightResult(result, fixResult);
  await refresh();
  $("#preflightResult").innerHTML = renderPreflightResult(result, fixResult);
  setActionResult({
    status: result.ok ? "success" : "error",
    title: "Проверка перед запуском",
    message: result.ok
      ? "Кампания готова к запуску."
      : `Автоматически обработано: ${fixResult.fixes?.length || 0}. Осталось ошибок: ${result.errors?.length || 0}.`,
    details: fixResult,
  });
  if (result.ok) switchCampaignStep("launch");
}));

async function startCampaign(mode) {
  const result = await api(`/api/campaigns/${$("#activeCampaign").value}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  $("#preflightResult").innerHTML = renderPreflightResult(result.preflight);
  await refresh();
  if (result.queued > 0) switchView("queue");
  const message = result.queued === 0
    ? launchEmptyHint(result)
    : result.requiresApproval
    ? `${queueModeLabel(mode)}: в очередь поставлено ${result.queued} писем, перед отправкой нужно подтвердить.`
    : `${queueModeLabel(mode)}: в очередь поставлено ${result.queued} писем, дополнительное подтверждение не нужно.`;
  setActionResult({
    status: result.queued > 0 ? "success" : "warn",
    title: mode === "test" ? "Тестовый запуск кампании" : "Запуск кампании",
    message,
    details: result,
  });
}

$("#startManualBtn").addEventListener("click", (event) => runAction({ title: "Постановка на ручную проверку", button: event.currentTarget }, () => startCampaign("manual")));
$("#startAutoBtn").addEventListener("click", (event) => runAction({ title: "Запуск отправки", button: event.currentTarget }, () => startCampaign("auto")));
$("#startTestBtn").addEventListener("click", (event) => runAction({ title: "Тестовый запуск кампании", button: event.currentTarget }, () => startCampaign("test")));

$("#approveAllBtn").addEventListener("click", (event) => runAction({
  title: "Подтверждение ожидающих писем",
  button: event.currentTarget,
}, async () => {
  const result = await api(`/api/campaigns/${$("#activeCampaign").value}/approve-pending`, { method: "POST" });
  await refresh();
  setActionResult({
    status: "success",
    title: "Подтверждение ожидающих писем",
    message: `Подтверждено писем: ${result.approved}.`,
    details: result,
  });
}));

document.body.addEventListener("click", async (event) => {
  const mailboxId = event.target.dataset.checkMailbox;
  const syncMailboxId = event.target.dataset.syncMailbox;
  const toggleWarmupId = event.target.dataset.toggleWarmup;
  const approveId = event.target.dataset.approve;
  const deleteAttachmentId = event.target.dataset.deleteAttachment;
  const deleteSuppressionId = event.target.dataset.deleteSuppression;
  const warmupPage = event.target.dataset.warmupPage;
  const queueGroupRow = event.target.closest("[data-queue-group-toggle]");
  if (warmupPage) {
    state.warmupPage = Number(warmupPage);
    await loadWarmup();
    return;
  }
  if (queueGroupRow && !event.target.closest("button,a,input,select,textarea")) {
    const key = queueGroupRow.dataset.queueGroupToggle;
    if (state.expandedQueueGroups.has(key)) state.expandedQueueGroups.delete(key);
    else state.expandedQueueGroups.add(key);
    loadQueue();
    return;
  }
  if (mailboxId) {
    await runAction({
      title: "Проверка SMTP/IMAP",
      target: { type: "mailbox", id: mailboxId },
      button: event.target,
    }, async () => {
      const result = await api(`/api/mailboxes/${mailboxId}/check`, { method: "POST" });
      await refresh();
      const dryRun = result.smtp?.dryRun || result.imap?.dryRun;
      const smtpText = result.smtp?.ok ? "SMTP: успешно" : `SMTP: ошибка ${result.smtp?.error || "неизвестно"}`;
      const imapText = result.imap?.ok ? "IMAP: успешно" : `IMAP: ошибка ${result.imap?.error || "неизвестно"}`;
      setActionResult({
        status: dryRun ? "warn" : result.ok ? "success" : "error",
        title: "Проверка SMTP/IMAP",
        message: dryRun
          ? "Включен безопасный режим: сервис записал проверку как успешную, но к SMTP/IMAP реально не подключался."
          : `${smtpText}. ${imapText}. DNS: MX ${result.domain?.mxStatus || "-"}, SPF ${result.domain?.spfStatus || "-"}, DKIM ${result.domain?.dkimStatus || "-"}, DMARC ${result.domain?.dmarcStatus || "-"}.`,
        details: result,
        target: { type: "mailbox", id: mailboxId },
      });
    });
    return;
  }
  if (approveId) {
    await runAction({
      title: "Подтверждение письма",
      button: event.target,
    }, async () => {
      const result = await api(`/api/sending/${approveId}/approve`, { method: "POST" });
      await refresh();
      setActionResult({ status: "success", title: "Подтверждение письма", message: "Письмо подтверждено для отправки.", details: result });
    });
    return;
  }
  if (syncMailboxId) {
    await runAction({
      title: "Синхронизация входящих",
      target: { type: "mailbox", id: syncMailboxId },
      button: event.target,
    }, async () => {
      const result = await api(`/api/mailboxes/${syncMailboxId}/sync`, { method: "POST" });
      scheduleInboxSyncRefreshes();
      setActionResult({
        status: "success",
        title: "Синхронизация входящих",
        message: "Задача поставлена в очередь worker. Сервис перечитает последние письма и попробует связать ответы с цепочками.",
        details: result,
        target: { type: "mailbox", id: syncMailboxId },
      });
    });
    return;
  }
  if (toggleWarmupId) {
    const enabled = event.target.dataset.enabled === "true";
    await runAction({
      title: enabled ? "Включение прогрева" : "Выключение прогрева",
      target: { type: "mailbox", id: toggleWarmupId },
      button: event.target,
    }, async () => {
      const result = await api(`/api/mailboxes/${toggleWarmupId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warmup_enabled: event.target.dataset.enabled }),
      });
      await refresh();
      setActionResult({
        status: "success",
        title: enabled ? "Включение прогрева" : "Выключение прогрева",
        message: enabled ? "Прогрев включен для mailbox." : "Прогрев выключен для mailbox.",
        details: result,
        target: { type: "mailbox", id: toggleWarmupId },
      });
    });
    return;
  }
  if (deleteAttachmentId) {
    await runAction({
      title: "Удаление вложения",
      button: event.target,
    }, async () => {
      const result = await api(`/api/attachments/${deleteAttachmentId}`, { method: "DELETE" });
      await refresh();
      setActionResult({ status: "success", title: "Удаление вложения", message: "Вложение удалено.", details: result });
    });
    return;
  }
  if (deleteSuppressionId) {
    await runAction({
      title: "Удаление из стоп-листа",
      button: event.target,
    }, async () => {
      const result = await api(`/api/suppressions/${deleteSuppressionId}`, { method: "DELETE" });
      await refresh();
      setActionResult({ status: "success", title: "Удаление из стоп-листа", message: "Запись удалена из стоп-листа.", details: result });
    });
  }
});

document.body.addEventListener("change", async (event) => {
  const id = event.target.dataset.classify;
  if (!id) return;
  await runAction({
    title: "Классификация ответа",
  }, async () => {
    const result = await api(`/api/inbox/${id}/classification`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classification: event.target.value }),
    });
    setActionResult({
      status: "success",
      title: "Классификация ответа",
      message: `Класс ответа обновлен: ${statusLabel(event.target.value)}.`,
      details: result,
    });
    await Promise.all([loadInbox(), loadConversations(), loadReviewConversations(), loadDashboard()]);
  });
});

document.body.addEventListener("change", async (event) => {
  const conversationId = event.target.dataset.classifyConversation;
  if (!conversationId) return;
  await runAction({
    title: "Классификация диалога",
  }, async () => {
    const result = await api(`/api/outreach/conversations/${conversationId}/classification`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classification: event.target.value }),
    });
    await Promise.all([loadConversations(), loadReviewConversations(), loadDashboard()]);
    if ($("#conversationDialog").open) await openConversation(conversationId);
    setActionResult({
      status: "success",
      title: "Классификация диалога",
      message: `Диалог помечен как «${statusLabel(event.target.value)}». Отменено будущих follow-up: ${result.cancelledQueue || 0}.`,
      details: result,
    });
  });
});

$("#syncInboxBtn").addEventListener("click", (event) => runAction({
  title: "Синхронизация всех входящих",
  button: event.currentTarget,
}, async () => {
  const result = await api("/api/inbox/sync", { method: "POST" });
  scheduleInboxSyncRefreshes();
  setActionResult({
    status: "success",
    title: "Синхронизация всех входящих",
    message: `В очередь поставлено ${result.queued} IMAP-задач.`,
    details: result,
  });
}));

$("#warmupNowBtn").addEventListener("click", (event) => runAction({
  title: "Warmup сейчас",
  button: event.currentTarget,
}, async () => {
  const result = await api("/api/warmup/send-now", { method: "POST" });
  setActionResult({
    status: "success",
    title: "Warmup сейчас",
    message: "Warmup-письмо поставлено в очередь worker.",
    details: result,
  });
}));

$("#suppressionForm").addEventListener("submit", (event) => runAction({
  title: "Добавление в стоп-лист",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const result = await api("/api/suppressions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formJson(event.target)),
  });
  event.target.reset();
  await refresh();
  setActionResult({
    status: "success",
    title: "Добавление в стоп-лист",
    message: "Запись добавлена в стоп-лист.",
    details: result,
  });
}));

document.body.addEventListener("submit", (event) => {
  if (event.target.id !== "runtimeSettingsForm") return;
  event.preventDefault();
  runAction({
    title: "Сохранение runtime настроек",
    button: event.submitter,
  }, async () => {
    const payload = formJson(event.target);
    payload.mailDryRun = payload.mailDryRun === "true";
    payload.maxAttachmentMb = Number(payload.maxAttachmentMb);
    payload.timeZone = payload.timeZone || currentTimeZone();
    const inboxSyncMinutes = Number(payload.inboxSyncMinutes || 0);
    const inboxSyncSeconds = Number(payload.inboxSyncSeconds || 0);
    payload.inboxSyncIntervalSeconds = Math.max(1, Math.round((inboxSyncMinutes * 60) + inboxSyncSeconds));
    delete payload.inboxSyncMinutes;
    delete payload.inboxSyncSeconds;
    const result = await api("/api/runtime-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await Promise.all([loadHealth(), loadSettings(), loadEnvCheck()]);
    setActionResult({
      status: "success",
      title: "Сохранение runtime настроек",
      message: result.message,
      details: result,
    });
  });
});

$("#closeLeadDialog").addEventListener("click", () => $("#leadDialog").close());
$("#closeConversationDialog").addEventListener("click", () => $("#conversationDialog").close());
$("#closeOutreachDraftDrawer").addEventListener("click", () => {
  state.openOutreachDraftId = null;
  $("#outreachDraftDrawer").close();
});
$("#outreachDraftDrawer").addEventListener("close", () => {
  state.openOutreachDraftId = null;
});

switchView(viewFromLocation());
refresh();
setInterval(loadQueue, 15000);
setInterval(loadWarmup, 30000);
