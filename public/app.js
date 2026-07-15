const state = {
  campaigns: [],
  mailboxes: [],
  leads: [],
  queue: [],
  suppressions: [],
  warmup: null,
  dashboard: null,
  settings: null,
  envCheck: null,
  health: null,
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

function pill(value) {
  const cls = ["failed", "invalid", "bounced"].includes(value) ? "bad" : ["pending", "risky", "retrying"].includes(value) ? "warn" : "";
  return `<span class="pill ${cls}">${value || ""}</span>`;
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

async function loadHealth() {
  const health = await api("/api/health");
  state.health = health;
  $("#health").textContent = `OK · dry-run: ${health.dryRun ? "да" : "нет"} · tracking: ${health.publicTrackingUrl ? "on" : "off"}`;
  const runtimeModeText = $("#runtimeModeText");
  if (runtimeModeText) {
    runtimeModeText.textContent = health.dryRun
      ? "Сейчас включен безопасный режим: MAIL_DRY_RUN=true. Сервис все покажет в интерфейсе, но реальные письма наружу не отправит."
      : "Сейчас включена реальная отправка: MAIL_DRY_RUN=false. Проверки SMTP/IMAP и отправка писем будут выполняться по-настоящему.";
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
        <p class="muted">После изменения .env выполни: docker compose restart web worker</p>
      </section>
    </div>
  `;
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  state.dashboard = data;
  const metrics = [
    ["Лидов", data.leads.total],
    ["Valid", data.leads.valid],
    ["Sent", data.messages.sent],
    ["Open rate", `${data.rates.openRate}%`],
    ["Reply rate", `${data.rates.replyRate}%`],
  ];
  $("#metrics").innerHTML = metrics.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#queueSummary").innerHTML = `
    <p>Pending: <strong>${data.queue.pending}</strong></p>
    <p>Failed: <strong>${data.queue.failed}</strong></p>
    <p>Sent: <strong>${data.queue.sent}</strong></p>
  `;
  $("#kpi").innerHTML = `
    <p>Raw opens: <strong>${data.opens.raw}</strong></p>
    <p>Unique opens: <strong>${data.opens.unique}</strong></p>
    <p>Ответы: <strong>${data.replies.total}</strong></p>
    <p>Положительные: <strong>${data.replies.positive}</strong></p>
  `;
  renderSetupChecklist();
}

async function loadLeads() {
  const search = encodeURIComponent($("#leadSearch")?.value || "");
  state.leads = await api(`/api/leads?search=${search}`);
  $("#leadsTable").innerHTML = `
    <thead><tr><th>Компания</th><th>Email</th><th>Сегмент</th><th>Статус</th><th>Валидация</th><th>Источник</th></tr></thead>
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
              <td>${pill(lead.validation_status)}<br><span class="muted">${esc(lead.validation_reason || "")}</span></td>
              <td>${esc(lead.source || "")}</td>
            </tr>
          `,
        )
        .join("")
        : `<tr><td colspan="6" class="muted">Лидов пока нет. Добавь одного вручную или импортируй CSV, затем нажми “Запустить проверку email”.</td></tr>`}
    </tbody>
  `;
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
  const options = state.campaigns.map((campaign) => `<option value="${campaign.id}">${campaign.name}</option>`).join("");
  $("#stepCampaign").innerHTML = options;
  $("#activeCampaign").innerHTML = options;
  $("#attachmentStep").innerHTML = state.campaigns
    .flatMap((campaign) => campaign.steps.map((step) => ({ ...step, campaignName: campaign.name })))
    .map((step) => `<option value="${step.id}">${esc(step.campaignName)} / ${esc(step.name)}</option>`)
    .join("");
  renderAttachments();
  $("#campaignList").innerHTML = state.campaigns.length
    ? state.campaigns.map(
      (campaign) => `
        <article class="card">
          <strong>${esc(campaign.name)}</strong> ${pill(campaign.status)}
          <p>${esc(campaign.description || "")}</p>
          <p>Шаги: ${campaign.steps.length} · tracking: ${campaign.tracking_enabled ? "on" : "off"} · manual: ${campaign.manual_approval_required ? "да" : "нет"}</p>
          <ol>${campaign.steps.map((step) => `<li>${esc(step.name)}: ${esc(step.subject_template)} (${step.attachments?.length || 0} влож.)</li>`).join("")}</ol>
        </article>
      `,
    )
    .join("")
    : `<article class="card"><strong>Рассылок пока нет</strong><p>Создай кампанию, затем добавь хотя бы один шаг письма.</p></article>`;
  renderSetupChecklist();
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
        ? "Жду ответ backend по MAIL_DRY_RUN."
        : runtimeDryRun
        ? "Можно спокойно нажимать кнопки: реальные письма не отправятся."
        : "MAIL_DRY_RUN=false: SMTP/IMAP и отправка работают по-настоящему.",
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
      <div>Прогресс: ${progress.sent}/${progress.total}. Ошибок: ${progress.failed}. ETA: ~${progress.etaMinutes} мин. ${
        next ? `До следующего письма: ${fmtCountdown(next.scheduled_at)} (${fmtDate(next.scheduled_at)})` : ""
      }</div>
    </div>
  `;
  $("#queueTable").innerHTML = `
    <thead><tr><th>Когда</th><th>Кампания</th><th>Лид</th><th>Mailbox</th><th>Шаг</th><th>Статус</th><th>Ошибка</th><th></th></tr></thead>
    <tbody>
      ${state.queue
        .map(
          (item) => `
            <tr>
              <td>${fmtDate(item.scheduled_at)}</td>
              <td>${esc(item.campaign_name)}</td>
              <td>${esc(item.company)}<br><span class="muted">${esc(item.email)}</span></td>
              <td>${esc(item.mailbox_email || "")}</td>
              <td>${esc(item.step_name || "")}</td>
              <td>${pill(item.status)} ${item.requires_approval && !item.approved_at ? pill("approval") : ""}</td>
              <td>${esc(item.last_error || "")}</td>
              <td>${item.requires_approval && !item.approved_at ? `<button data-approve="${item.id}">OK</button>` : ""}</td>
            </tr>
          `,
        )
        .join("")}
    </tbody>
  `;
}

async function loadInbox() {
  const inbox = await api("/api/inbox");
  $("#inboxList").innerHTML = inbox
    .map(
      (item) => `
        <article class="card">
          <strong>${esc(item.subject)}</strong> ${pill(item.reply_classification || item.type)}
          <p>${esc(item.company || "")} · ${esc(item.lead_email || "")} · ${fmtDate(item.received_at || item.created_at)}</p>
          <pre>${esc((item.body_text || "").slice(0, 2500))}</pre>
          <select data-classify="${item.id}">
            ${["positive_reply", "neutral_reply", "negative_reply", "auto_reply", "unsubscribe", "not_target", "bounce", "unknown"]
              .map((value) => `<option value="${value}" ${value === item.reply_classification ? "selected" : ""}>${value}</option>`)
              .join("")}
          </select>
        </article>
      `,
    )
    .join("");
}

async function loadWarmup() {
  state.warmup = await api("/api/warmup");
  $("#warmupStats").innerHTML = `
    <p>Отправлено warmup: <strong>${state.warmup.stats.sent}</strong></p>
    <p>Ответов warmup: <strong>${state.warmup.stats.replies}</strong></p>
    <p>Ошибок: <strong>${state.warmup.stats.errors}</strong></p>
  `;
  $("#warmupMailboxList").innerHTML = state.warmup.mailboxes
    .map(
      (mailbox) => `
        <article class="card">
          <strong>${esc(mailbox.name)}</strong>
          <p>${esc(mailbox.email)} · ${pill(mailbox.health_status)} · лимит ${mailbox.daily_warmup_limit}/день</p>
          <button data-toggle-warmup="${mailbox.id}" data-enabled="${!mailbox.warmup_enabled}">${mailbox.warmup_enabled ? "Выключить" : "Включить"}</button>
        </article>
      `,
    )
    .join("");
  $("#warmupEventsTable").innerHTML = `
    <thead><tr><th>Время</th><th>Тип</th><th>Payload</th></tr></thead>
    <tbody>${state.warmup.events
      .map((event) => `<tr><td>${fmtDate(event.created_at)}</td><td>${event.event_type}</td><td><pre>${esc(JSON.stringify(event.payload, null, 2))}</pre></td></tr>`)
      .join("")}</tbody>
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
    <form id="runtimeSettingsForm" class="form settings-form">
      <label class="field">
        <span>Режим отправки</span>
        <select name="mailDryRun">
          <option value="true" ${settings.runtime.dryRun ? "selected" : ""}>Безопасный dry-run: не отправлять реальные письма</option>
          <option value="false" ${!settings.runtime.dryRun ? "selected" : ""}>Реальная отправка: SMTP/IMAP работают по-настоящему</option>
        </select>
      </label>
      <label class="field">
        <span>PUBLIC_TRACKING_URL</span>
        <input name="publicTrackingUrl" value="${esc(settings.runtime.publicTrackingUrl || "")}" placeholder="https://your-public-tunnel.example" />
      </label>
      <label class="field">
        <span>Максимальный размер вложения, МБ</span>
        <input name="maxAttachmentMb" type="number" min="1" max="200" step="1" value="${settings.runtime.maxAttachmentMb}" />
      </label>
      <button>Сохранить runtime настройки</button>
    </form>
    <div class="cards settings-summary">
      <article class="card"><strong>Текущий режим</strong><p>${settings.runtime.dryRun ? "dry-run включен" : "реальная отправка включена"}</p></article>
      <article class="card"><strong>Tracking URL</strong><p>${esc(settings.runtime.publicTrackingUrl || "не задан")}</p></article>
      <article class="card"><strong>Папка вложений</strong><p>${esc(settings.runtime.attachmentDir)}</p></article>
    </div>
    <p class="muted">После сохранения значения пишутся в .env. Для фоновой отправки и лимита вложений перезапусти web и worker.</p>
  `;
  renderSetupChecklist();
}

async function loadEvents() {
  const events = await api("/api/events");
  $("#eventsTable").innerHTML = `
    <thead><tr><th>Время</th><th>Тип</th><th>Payload</th></tr></thead>
    <tbody>
      ${events.map((event) => `<tr><td>${fmtDate(event.created_at)}</td><td>${event.event_type}</td><td><pre>${esc(JSON.stringify(event.payload, null, 2))}</pre></td></tr>`).join("")}
    </tbody>
  `;
}

async function refresh() {
  await Promise.all([
    loadHealth(),
    loadEnvCheck(),
    loadDashboard(),
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
$("#leadSearch").addEventListener("input", () => loadLeads());

document.body.addEventListener("click", (event) => {
  const go = event.target.dataset.go;
  if (go) switchView(go);
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

$("#campaignForm").addEventListener("submit", (event) => runAction({
  title: "Создание кампании",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const payload = formJson(event.target);
  payload.tracking_enabled = event.target.elements.tracking_enabled.checked;
  payload.manual_approval_required = event.target.elements.manual_approval_required.checked;
  const result = await api("/api/campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  event.target.reset();
  await refresh();
  setActionResult({ status: "success", title: "Создание кампании", message: `Кампания «${result.name}» создана.`, details: result });
}));

$("#stepForm").addEventListener("submit", (event) => runAction({
  title: "Добавление шага",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const payload = formJson(event.target);
  payload.body_template_html = $("#htmlEditor").innerHTML;
  const result = await api(`/api/campaigns/${payload.campaign_id}/steps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await refresh();
  setActionResult({ status: "success", title: "Добавление шага", message: `Шаг «${result.name}» добавлен.`, details: result });
}));

$("#attachmentForm").addEventListener("submit", (event) => runAction({
  title: "Загрузка вложения",
  button: event.submitter,
}, async () => {
  event.preventDefault();
  const form = new FormData(event.target);
  const stepId = form.get("step_id");
  form.delete("step_id");
  const result = await api(`/api/steps/${stepId}/attachments`, { method: "POST", body: form });
  event.target.reset();
  await refresh();
  setActionResult({ status: "success", title: "Загрузка вложения", message: "Вложение добавлено к шагу.", details: result });
}));

$("#enrollBtn").addEventListener("click", (event) => runAction({
  title: "Добавление лидов в кампанию",
  button: event.currentTarget,
}, async () => {
  const campaignId = $("#activeCampaign").value;
  const leadIds = state.leads.filter((lead) => ["valid", "risky"].includes(lead.validation_status)).map((lead) => lead.id);
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
    message: `Добавлены valid/risky лиды: ${leadIds.length}. Mailbox для отправки: ${mailboxIds.length}.`,
    details: result,
  });
}));

$("#preflightBtn").addEventListener("click", (event) => runAction({
  title: "Проверка перед запуском",
  button: event.currentTarget,
}, async () => {
  const result = await api(`/api/campaigns/${$("#activeCampaign").value}/preflight`);
  $("#preflightResult").textContent = JSON.stringify(result, null, 2);
  setActionResult({
    status: result.ok ? "success" : "error",
    title: "Проверка перед запуском",
    message: result.ok ? "Кампания готова к запуску." : `Запуск заблокирован: ${result.errors?.length || 0} ошибок.`,
    details: result,
  });
}));

async function startCampaign(mode) {
  const result = await api(`/api/campaigns/${$("#activeCampaign").value}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  $("#preflightResult").textContent = JSON.stringify(result, null, 2);
  await refresh();
  setActionResult({
    status: "success",
    title: mode === "test" ? "Тестовый запуск кампании" : "Запуск кампании",
    message: `Режим ${mode}: в очередь поставлено ${result.queued} писем.`,
    details: result,
  });
}

$("#startManualBtn").addEventListener("click", (event) => runAction({ title: "Запуск кампании", button: event.currentTarget }, () => startCampaign("manual")));
$("#startAutoBtn").addEventListener("click", (event) => runAction({ title: "Автозапуск кампании", button: event.currentTarget }, () => startCampaign("auto")));
$("#startTestBtn").addEventListener("click", (event) => runAction({ title: "Тестовый запуск кампании", button: event.currentTarget }, () => startCampaign("test")));

$("#approveAllBtn").addEventListener("click", (event) => runAction({
  title: "Подтверждение pending",
  button: event.currentTarget,
}, async () => {
  const result = await api(`/api/campaigns/${$("#activeCampaign").value}/approve-pending`, { method: "POST" });
  await refresh();
  setActionResult({
    status: "success",
    title: "Подтверждение pending",
    message: "Pending-письма подтверждены.",
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
  if (mailboxId) {
    await runAction({
      title: "Проверка SMTP/IMAP",
      target: { type: "mailbox", id: mailboxId },
      button: event.target,
    }, async () => {
      const result = await api(`/api/mailboxes/${mailboxId}/check`, { method: "POST" });
      await refresh();
      const dryRun = result.smtp?.dryRun || result.imap?.dryRun;
      setActionResult({
        status: dryRun ? "warn" : "success",
        title: "Проверка SMTP/IMAP",
        message: dryRun
          ? "MAIL_DRY_RUN=true: сервис записал проверку как успешную, но к SMTP/IMAP реально не подключался."
          : `SMTP подключился, IMAP открыл INBOX. DNS: MX ${result.domain?.mxStatus || "-"}, SPF ${result.domain?.spfStatus || "-"}, DKIM ${result.domain?.dkimStatus || "-"}, DMARC ${result.domain?.dmarcStatus || "-"}.`,
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
      status: "warn",
      title: "Сохранение runtime настроек",
      message: `${result.message} Выполни: docker compose restart web worker.`,
      details: result,
    });
  });
});

$("#closeLeadDialog").addEventListener("click", () => $("#leadDialog").close());

refresh();
setInterval(loadQueue, 15000);
setInterval(loadWarmup, 30000);
