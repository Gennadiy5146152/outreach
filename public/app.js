const state = {
  campaigns: [],
  mailboxes: [],
  leads: [],
  campaignLeads: [],
  campaignAvailableLeads: [],
  selectedCampaignLeadIds: new Set(),
  selectedCampaignEnrollmentIds: new Set(),
  segments: [],
  queue: [],
  suppressions: [],
  warmup: null,
  warmupPage: 1,
  warmupPageSize: 20,
  dashboard: null,
  settings: null,
  envCheck: null,
  health: null,
  editorTarget: null,
  campaignStep: "campaign",
  actionResults: {
    global: null,
    mailboxes: {},
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

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
  const body = typeof details === "string" ? details : JSON.stringify(details, null, 2);
  return `<details><summary>Детали</summary><pre>${esc(body)}</pre></details>`;
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
  return new Date(value).toLocaleString("ru-RU");
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
  unknown: "еще не проверяли",
  valid: "можно отправлять",
  risky: "нужна проверка",
  pending: "в очереди",
  retrying: "повтор",
  failed: "ошибка",
  cancelled: "отменено",
  bounced: "недоставка",
  approval: "ждет подтверждения",
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

const EVENT_LABELS = {
  lead_created: "Лид добавлен",
  email_validated: "Email проверен",
  email_sent: "Письмо отправлено",
  email_opened: "Письмо открыто",
  mailbox_error: "Ошибка почтового ящика",
  reply_classified: "Ответ классифицирован",
  positive_reply_received: "Получен позитивный ответ",
  neutral_reply_received: "Получен нейтральный ответ",
  negative_reply_received: "Получен негативный ответ",
  auto_reply_received: "Получен автоответ",
  unsubscribe_received: "Получена отписка",
  not_target_received: "Получен ответ “не целевой”",
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
};

function statusLabel(value) {
  return STATUS_LABELS[value] || REPLY_CLASS_LABELS[value] || value || "";
}

function validationReasonText(value) {
  return VALIDATION_REASON_LABELS[value] || value || "";
}

function queueModeLabel(value) {
  return {
    test: "тест на свои почты",
    manual: "ручная проверка перед отправкой",
    auto: "обычная отправка",
  }[value] || value || "";
}

function queueStatusHint(item) {
  if (item.requires_approval && !item.approved_at) return "Перед отправкой нужно подтвердить письмо.";
  if (item.status === "pending") return "Ждет своего времени отправки.";
  if (item.status === "retrying") return "Будет повторная попытка после ошибки.";
  if (item.status === "sent") return "Письмо уже отправлено.";
  if (item.status === "failed") return item.last_error || "Отправка завершилась ошибкой.";
  return "";
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
  if (payload.error) parts.push(`ошибка: ${payload.error}`);
  if (payload.dryRun !== undefined) parts.push(`dry-run: ${payload.dryRun ? "да" : "нет"}`);
  if (payload.provider) parts.push(`провайдер: ${payload.provider}`);
  if (payload.status) parts.push(`статус: ${statusLabel(payload.status)}`);
  return parts.join(" · ") || "Подробности доступны в деталях.";
}

function pill(value) {
  const cls = ["failed", "invalid", "bounced"].includes(value) ? "bad" : ["pending", "risky", "retrying"].includes(value) ? "warn" : "";
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

function switchView(view) {
  $$(".view").forEach((node) => node.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
  $$("nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#title").textContent = {
    dashboard: "Обзор",
    start: "Что делать",
    leads: "База",
    mailboxes: "1. Почта",
    campaigns: "4. Рассылка",
    queue: "Очередь",
    inbox: "Входящие",
    warmup: "Прогрев",
    suppression: "Стоп-лист",
    events: "События",
    settings: "Настройки",
  }[view];
}

function switchCampaignStep(step) {
  state.campaignStep = step;
  $$("[data-campaign-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.campaignPanel === step));
  $$("[data-campaign-step]").forEach((button) => button.classList.toggle("active", button.dataset.campaignStep === step));
}

async function loadHealth() {
  const health = await api("/api/health");
  state.health = health;
  $("#health").textContent = `OK · dry-run: ${health.dryRun ? "да" : "нет"} · tracking: ${health.publicTrackingUrl ? "on" : "off"}`;
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
  const readyLeads = Number(data.leads.valid || 0) + Number(data.leads.risky || 0);
  const metrics = [
    ["Всего лидов", data.leads.total, "в базе"],
    ["Готовы к отправке", readyLeads, "valid + risky"],
    ["Отправлено писем", data.messages.sent, "рассылки, без прогрева"],
    ["Уникальные открытия", data.opens.unique, `${data.rates.openRate}% от отправленных`],
    ["Ответы", data.replies.total, `${data.rates.replyRate}% от отправленных, без прогрева`],
    ["Положительные ответы", data.replies.positive, "по рассылкам, без прогрева"],
  ];
  $("#metrics").innerHTML = metrics
    .map(([label, value, hint]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${hint}</small></div>`)
    .join("");
  $("#queueSummary").innerHTML = `
    <p>Ждут отправки: <strong>${data.queue.pending}</strong></p>
    <p>Отправлены из очереди: <strong>${data.queue.sent}</strong></p>
    <p>Ошибки отправки: <strong>${data.queue.failed}</strong></p>
  `;
  $("#kpi").innerHTML = `
    <p>Все открытия: <strong>${data.opens.raw}</strong></p>
    <p>Уникальные открытия: <strong>${data.opens.unique}</strong></p>
    <p>Доля открытий: <strong>${data.rates.openRate}%</strong></p>
    <p>Доля ответов: <strong>${data.rates.replyRate}%</strong></p>
    <p>Недоставки: <strong>${data.messages.bounced}</strong></p>
  `;
  renderSetupChecklist();
}

async function loadLeads() {
  const search = encodeURIComponent($("#leadSearch")?.value || "");
  const validation = encodeURIComponent($("#leadValidationFilter")?.value || "");
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
  $("#leadsTable").innerHTML = `
    <thead><tr><th>Компания</th><th>Email</th><th>Сегмент</th><th>Статус</th><th>Проверка email</th><th>Источник</th></tr></thead>
    <tbody>
      ${state.leads.length
        ? state.leads
        .map(
          (lead) => `
            <tr data-lead-id="${lead.id}">
              <td><strong>${esc(lead.company)}</strong><br><span class="muted">${esc(lead.contact_name || "")}</span></td>
              <td>${esc(lead.email)}</td>
              <td>${esc(lead.segment || "")}</td>
              <td>${pill(lead.status)}</td>
              <td>${pill(lead.validation_status)}<br><span class="muted">${esc(validationReasonText(lead.validation_reason))}</span></td>
              <td>${esc(lead.source || "")}</td>
            </tr>
          `,
        )
        .join("")
        : `<tr><td colspan="6" class="muted">Лидов пока нет. Добавь одного вручную или импортируй CSV, затем нажми “Запустить проверку email”.</td></tr>`}
    </tbody>
  `;
}

async function loadSegments() {
  try {
    state.segments = await api("/api/segments");
    renderLeadSegmentFilter();
    renderSegmentPickers();
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

function updateCampaignEnrollmentSelection() {
  const activeIds = new Set(state.campaignLeads
    .filter((lead) => lead.enrollment_status === "active")
    .map((lead) => lead.enrollment_id));
  state.selectedCampaignEnrollmentIds = new Set([...state.selectedCampaignEnrollmentIds].filter((id) => activeIds.has(id)));
  const count = state.selectedCampaignEnrollmentIds.size;
  const selection = $("#campaignEnrollmentSelection");
  const selectAll = $("#campaignEnrollmentSelectAll");
  const keepButton = $("#keepCampaignLeadsBtn");
  if (selection) selection.textContent = `Выбрано для отправки: ${count}`;
  if (selectAll) {
    const active = [...activeIds];
    selectAll.disabled = active.length === 0;
    selectAll.checked = active.length > 0 && active.every((id) => state.selectedCampaignEnrollmentIds.has(id));
    selectAll.indeterminate = count > 0 && !selectAll.checked;
  }
  if (keepButton) keepButton.disabled = count === 0 || count === activeIds.size;
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
          <span>${mailbox.smtp_verified_at ? "SMTP проверен" : "SMTP не проверен"}</span>
          <span>${mailbox.imap_verified_at ? "IMAP проверен" : "IMAP не проверен"}</span>
          <span>${mailbox.last_inbox_sync_at ? `Входящие: ${fmtDate(mailbox.last_inbox_sync_at)}` : "Входящие еще не синхронизировались"}</span>
        </div>
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
  summary.textContent = `В кампании: ${state.campaignLeads.length} · отправятся: ${activeCount} · выключены: ${pausedCount} · mailbox: ${mailboxCount}`;
  table.innerHTML = `
    <thead><tr><th></th><th>Компания</th><th>Email</th><th>Сегмент</th><th>Проверка</th><th>Mailbox</th><th>Статус</th><th>Следующая отправка</th><th></th></tr></thead>
    <tbody>
      ${state.campaignLeads.length
        ? state.campaignLeads.map((lead) => `
          <tr class="${lead.enrollment_status === "active" ? "" : "muted-row"}">
            <td>
              <input type="checkbox" data-campaign-enrollment-id="${lead.enrollment_id}" ${state.selectedCampaignEnrollmentIds.has(lead.enrollment_id) ? "checked" : ""} ${lead.enrollment_status === "active" ? "" : "disabled"} />
            </td>
            <td><strong>${esc(lead.company)}</strong><br><span class="muted">${esc(lead.contact_name || "")}</span></td>
            <td>${esc(lead.email)}</td>
            <td>${esc(lead.segment || "")}</td>
            <td>${pill(lead.validation_status)}<br><span class="muted">${esc(validationReasonText(lead.validation_reason))}</span></td>
            <td>${esc(lead.mailbox_email || "не назначен")}</td>
            <td>${pill(lead.enrollment_status)}</td>
            <td>${fmtDate(lead.next_send_at) || "по запуску"}</td>
            <td>
              ${lead.enrollment_status === "active"
                ? `<button class="small-button" data-pause-enrollment="${lead.enrollment_id}">Убрать из кампании</button>`
                : lead.enrollment_status === "paused"
                ? `<button class="small-button" data-resume-enrollment="${lead.enrollment_id}">Вернуть в отправку</button>`
                : `<span class="muted">не отправляется</span>`}
            </td>
          </tr>
        `).join("")
        : `<tr><td colspan="9" class="muted">В этой кампании пока нет лидов. Выбери нужных лидов выше и нажми “Добавить выбранных лидов”.</td></tr>`}
    </tbody>
  `;
  updateCampaignEnrollmentSelection();
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
      text: `Mailbox с прогревом: ${warmupEnabled}. Прогрев работает только между твоими ящиками.`,
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

async function loadQueue() {
  const [queue, progress] = await Promise.all([api("/api/sending"), api("/api/sending/progress")]);
  state.queue = queue;
  const total = state.queue.length;
  const next = state.queue.find((item) => ["pending", "retrying"].includes(item.status));
  $("#sendProgress").innerHTML = `
    <div class="progress">
      <div class="bar"><span style="width:${progress.percent}%"></span></div>
      <div>
        <strong>Отправка:</strong> ${progress.sent} из ${progress.total} · ошибок: ${progress.failed} · осталось примерно ${progress.etaMinutes} мин.
        ${next ? `<br><span class="muted">Следующее письмо: через ${fmtCountdown(next.scheduled_at)} · ${fmtDate(next.scheduled_at)}</span>` : ""}
      </div>
    </div>
  `;
  $("#queueTable").innerHTML = `
    <thead><tr><th>Когда отправлять</th><th>Кампания</th><th>Получатель</th><th>Почта отправителя</th><th>Письмо</th><th>Режим</th><th>Состояние</th><th>Что сделать</th></tr></thead>
    <tbody>
      ${state.queue.length
        ? state.queue
        .map(
          (item) => `
            <tr>
              <td>${fmtDate(item.scheduled_at)}</td>
              <td>${esc(item.campaign_name)}</td>
              <td>${esc(item.company)}<br><span class="muted">${esc(item.email)}</span></td>
              <td>${esc(item.mailbox_email || "")}</td>
              <td>${esc(item.step_name || "")}</td>
              <td>${esc(queueModeLabel(item.mode))}</td>
              <td>${pill(item.status)} ${item.requires_approval && !item.approved_at ? pill("approval") : ""}<br><span class="muted">${esc(queueStatusHint(item))}</span></td>
              <td>${item.requires_approval && !item.approved_at ? `<button data-approve="${item.id}">Подтвердить</button>` : `<span class="muted">Действий нет</span>`}</td>
            </tr>
          `,
        )
        .join("")
        : `<tr><td colspan="8" class="muted">Очередь пуста. Нажми “Запустить отправку” или “Тест на мои почты”, и здесь появятся письма с временем отправки. Если после запуска пусто, смотри сообщение сверху: там будет причина.</td></tr>`}
    </tbody>
  `;
}

async function loadInbox() {
  const inbox = await api("/api/inbox");
  $("#inboxList").innerHTML = inbox
    .map(
      (item) => `
        <article class="card inbox-card">
          <div class="inbox-card-head">
            <div>
              <strong>${esc(item.subject || "Без темы")}</strong>
              <p>${esc(item.company || "Без компании")} · ${esc(item.lead_email || "")} · ${fmtDate(item.received_at || item.created_at)}</p>
            </div>
            ${pill(item.reply_classification || item.type)}
          </div>
          <pre class="inbox-message">${esc((item.body_text || "").slice(0, 2500))}</pre>
          <label class="field inbox-classify"><span>Класс ответа</span><select data-classify="${item.id}">
            ${["positive_reply", "neutral_reply", "negative_reply", "auto_reply", "unsubscribe", "not_target", "bounce", "unknown"]
              .map((value) => `<option value="${value}" ${value === item.reply_classification ? "selected" : ""}>${esc(statusLabel(value))}</option>`)
              .join("")}
          </select></label>
        </article>
      `,
    )
    .join("");
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
      <div class="settings-footer">
        <p>Вложения: ${esc(settings.runtime.attachmentDir)}</p>
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

async function refresh() {
  await Promise.all([
    loadHealth(),
    loadEnvCheck(),
    loadDashboard(),
    loadSegments(),
    loadLeads(),
    loadMailboxes(),
    loadCampaigns(),
    loadQueue(),
    loadInbox(),
    loadWarmup(),
    loadSuppressions(),
    loadEvents(),
    loadSettings(),
  ]);
}

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
$("#leadValidationFilter").addEventListener("change", () => loadLeads());
$("#leadFiltersReset").addEventListener("click", () => {
  $("#leadSearch").value = "";
  $("#leadSegmentFilter").value = "";
  $("#leadValidationFilter").value = "";
  loadLeads();
});
$("#activeCampaign").addEventListener("change", () => loadCampaignLeads());
$("#stepCampaign").addEventListener("change", () => renderCampaignStepList());
$("#stepEditResetBtn").addEventListener("click", () => resetStepForm());
$("#campaignEditResetBtn").addEventListener("click", () => resetCampaignForm());
$("#campaignLeadSelectAll").addEventListener("change", (event) => {
  const ids = state.campaignAvailableLeads.map((lead) => lead.id);
  state.selectedCampaignLeadIds = event.currentTarget.checked ? new Set(ids) : new Set();
  renderCampaignAvailableLeads();
});

$("#campaignEnrollmentSelectAll").addEventListener("change", (event) => {
  const ids = state.campaignLeads
    .filter((lead) => lead.enrollment_status === "active")
    .map((lead) => lead.enrollment_id);
  state.selectedCampaignEnrollmentIds = event.currentTarget.checked ? new Set(ids) : new Set();
  $$("[data-campaign-enrollment-id]").forEach((input) => {
    input.checked = state.selectedCampaignEnrollmentIds.has(input.dataset.campaignEnrollmentId);
  });
  updateCampaignEnrollmentSelection();
});

$("#keepCampaignLeadsBtn").addEventListener("click", (event) => runAction({
  title: "Оставить выбранных лидов",
  button: event.currentTarget,
}, async () => {
  const campaignId = $("#activeCampaign").value;
  const enrollmentIds = [...state.selectedCampaignEnrollmentIds];
  const result = await api(`/api/campaigns/${campaignId}/enrollments/keep-selected`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollment_ids: enrollmentIds }),
  });
  await loadCampaignLeads();
  setActionResult({
    status: "success",
    title: "Оставить выбранных лидов",
    message: `Оставлено для отправки: ${result.kept}. Выключено из кампании: ${result.paused}. Отменено писем в очереди: ${result.cancelled_queue}.`,
    details: result,
  });
}));

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
  const enrollmentId = event.target.dataset.campaignEnrollmentId;
  if (!enrollmentId) return;
  if (event.target.checked) {
    state.selectedCampaignEnrollmentIds.add(enrollmentId);
  } else {
    state.selectedCampaignEnrollmentIds.delete(enrollmentId);
  }
  updateCampaignEnrollmentSelection();
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

  const pauseEnrollment = event.target.closest("[data-pause-enrollment]");
  if (pauseEnrollment) {
    runAction({
      title: "Убрать лида из кампании",
      button: pauseEnrollment,
    }, async () => {
      const result = await api(`/api/enrollments/${pauseEnrollment.dataset.pauseEnrollment}/pause`, { method: "POST" });
      await loadCampaignLeads();
      setActionResult({
        status: "success",
        title: "Убрать лида из кампании",
        message: `Лид больше не будет отправляться. Отменено писем в очереди: ${result.cancelled_queue}.`,
        details: result,
      });
    });
    return;
  }

  const resumeEnrollment = event.target.closest("[data-resume-enrollment]");
  if (resumeEnrollment) {
    runAction({
      title: "Вернуть лида в отправку",
      button: resumeEnrollment,
    }, async () => {
      const result = await api(`/api/enrollments/${resumeEnrollment.dataset.resumeEnrollment}/resume`, { method: "POST" });
      await loadCampaignLeads();
      setActionResult({
        status: "success",
        title: "Вернуть лида в отправку",
        message: "Лид снова активен и попадет в следующий запуск.",
        details: result,
      });
    });
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
  title: "Сохранение mailbox",
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
    title: "Сохранение mailbox",
    message: `Mailbox ${result.email} сохранен. Теперь нажми «Проверить SMTP/IMAP».`,
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
  switchCampaignStep("leads");
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
    message: `Выбранные лиды добавлены: ${leadIds.length}. Mailbox для отправки: ${mailboxIds.length}.`,
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
  if (warmupPage) {
    state.warmupPage = Number(warmupPage);
    await loadWarmup();
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
      const smtpText = result.smtp?.ok ? "SMTP: ok" : `SMTP: ошибка ${result.smtp?.error || "unknown"}`;
      const imapText = result.imap?.ok ? "IMAP: ok" : `IMAP: ошибка ${result.imap?.error || "unknown"}`;
      setActionResult({
        status: dryRun ? "warn" : result.ok ? "success" : "error",
        title: "Проверка SMTP/IMAP",
        message: dryRun
          ? "Включен dry-run: сервис записал проверку как успешную, но к SMTP/IMAP реально не подключался."
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
      await refresh();
      setActionResult({
        status: "success",
        title: "Синхронизация входящих",
        message: "Задача поставлена в очередь worker. Новые письма появятся во «Входящих» после обработки.",
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
      message: `Класс ответа обновлен на ${event.target.value}.`,
      details: result,
    });
  });
});

$("#syncInboxBtn").addEventListener("click", (event) => runAction({
  title: "Синхронизация всех входящих",
  button: event.currentTarget,
}, async () => {
  const result = await api("/api/inbox/sync", { method: "POST" });
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

refresh();
setInterval(loadQueue, 15000);
setInterval(loadWarmup, 30000);
