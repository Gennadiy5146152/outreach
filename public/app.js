const state = {
  campaigns: [],
  mailboxes: [],
  leads: [],
  queue: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || data?.errors?.join("\n") || response.statusText);
  return data;
}

function formJson(form) {
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].map(([key, value]) => [key, value]));
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2500);
}

function fmtDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("ru-RU");
}

function pill(value) {
  const cls = ["failed", "invalid", "bounced"].includes(value) ? "bad" : ["pending", "risky", "retrying"].includes(value) ? "warn" : "";
  return `<span class="pill ${cls}">${value || ""}</span>`;
}

function switchView(view) {
  $$(".view").forEach((node) => node.classList.remove("active"));
  $(`#${view}View`).classList.add("active");
  $$("nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#title").textContent = {
    dashboard: "Обзор",
    leads: "База",
    mailboxes: "Почта",
    campaigns: "Кампании",
    queue: "Очередь",
    inbox: "Входящие",
    events: "События",
  }[view];
}

async function loadHealth() {
  const health = await api("/api/health");
  $("#health").textContent = `OK · dry-run: ${health.dryRun ? "да" : "нет"}`;
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
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
}

async function loadLeads() {
  const search = encodeURIComponent($("#leadSearch")?.value || "");
  state.leads = await api(`/api/leads?search=${search}`);
  $("#leadsTable").innerHTML = `
    <thead><tr><th>Компания</th><th>Email</th><th>Сегмент</th><th>Статус</th><th>Валидация</th><th>Источник</th></tr></thead>
    <tbody>
      ${state.leads
        .map(
          (lead) => `
            <tr>
              <td><strong>${lead.company}</strong><br><span class="muted">${lead.contact_name || ""}</span></td>
              <td>${lead.email}</td>
              <td>${lead.segment || ""}</td>
              <td>${pill(lead.status)}</td>
              <td>${pill(lead.validation_status)}<br><span class="muted">${lead.validation_reason || ""}</span></td>
              <td>${lead.source || ""}</td>
            </tr>
          `,
        )
        .join("")}
    </tbody>
  `;
}

async function loadMailboxes() {
  state.mailboxes = await api("/api/mailboxes");
  $("#mailboxList").innerHTML = state.mailboxes
    .map(
      (mailbox) => `
      <article class="card">
        <strong>${mailbox.name}</strong>
        <p>${mailbox.email} · ${mailbox.provider}</p>
        <p>SMTP: ${mailbox.smtp_verified_at ? "ok" : "нет"} · IMAP: ${mailbox.imap_verified_at ? "ok" : "нет"}</p>
        <p>MX/SPF/DKIM/DMARC: ${mailbox.mx_status || "-"} / ${mailbox.spf_status || "-"} / ${mailbox.dkim_status || "-"} / ${mailbox.dmarc_status || "-"}</p>
        <button data-check-mailbox="${mailbox.id}">Проверить</button>
      </article>
    `,
    )
    .join("");
}

async function loadCampaigns() {
  state.campaigns = await api("/api/campaigns");
  const options = state.campaigns.map((campaign) => `<option value="${campaign.id}">${campaign.name}</option>`).join("");
  $("#stepCampaign").innerHTML = options;
  $("#activeCampaign").innerHTML = options;
  $("#campaignList").innerHTML = state.campaigns
    .map(
      (campaign) => `
        <article class="card">
          <strong>${campaign.name}</strong> ${pill(campaign.status)}
          <p>${campaign.description || ""}</p>
          <p>Шаги: ${campaign.steps.length} · tracking: ${campaign.tracking_enabled ? "on" : "off"} · manual: ${campaign.manual_approval_required ? "да" : "нет"}</p>
          <ol>${campaign.steps.map((step) => `<li>${step.name}: ${step.subject_template}</li>`).join("")}</ol>
        </article>
      `,
    )
    .join("");
}

async function loadQueue() {
  state.queue = await api("/api/sending");
  const total = state.queue.length;
  const sent = state.queue.filter((item) => item.status === "sent").length;
  const failed = state.queue.filter((item) => item.status === "failed").length;
  const next = state.queue.find((item) => ["pending", "retrying"].includes(item.status));
  const percent = total ? Math.round((sent / total) * 100) : 0;
  const etaMinutes = state.queue.filter((item) => ["pending", "retrying"].includes(item.status)).length * 12;
  $("#sendProgress").innerHTML = `
    <div class="progress">
      <div class="bar"><span style="width:${percent}%"></span></div>
      <div>Прогресс: ${sent}/${total}. Ошибок: ${failed}. ETA: ~${etaMinutes} мин. ${
        next ? `До следующего: ${fmtDate(next.scheduled_at)}` : ""
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
              <td>${item.campaign_name}</td>
              <td>${item.company}<br><span class="muted">${item.email}</span></td>
              <td>${item.mailbox_email || ""}</td>
              <td>${item.step_name || ""}</td>
              <td>${pill(item.status)} ${item.requires_approval && !item.approved_at ? pill("approval") : ""}</td>
              <td>${item.last_error || ""}</td>
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
          <strong>${item.subject}</strong> ${pill(item.reply_classification || item.type)}
          <p>${item.company || ""} · ${item.lead_email || ""} · ${fmtDate(item.received_at || item.created_at)}</p>
          <pre>${(item.body_text || "").slice(0, 2500)}</pre>
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

async function loadEvents() {
  const events = await api("/api/events");
  $("#eventsTable").innerHTML = `
    <thead><tr><th>Время</th><th>Тип</th><th>Payload</th></tr></thead>
    <tbody>
      ${events.map((event) => `<tr><td>${fmtDate(event.created_at)}</td><td>${event.event_type}</td><td><pre>${JSON.stringify(event.payload, null, 2)}</pre></td></tr>`).join("")}
    </tbody>
  `;
}

async function refresh() {
  await Promise.all([loadHealth(), loadDashboard(), loadLeads(), loadMailboxes(), loadCampaigns(), loadQueue(), loadInbox(), loadEvents()]);
}

$$("nav button").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
$("#refreshBtn").addEventListener("click", () => refresh().then(() => toast("Обновлено")));
$("#leadSearch").addEventListener("input", () => loadLeads());

$("#leadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formJson(event.target)),
  });
  event.target.reset();
  await refresh();
  toast("Лид добавлен");
});

$("#importForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = new FormData(event.target);
  const result = await api("/api/leads/import", { method: "POST", body });
  await refresh();
  toast(`Импорт: ${result.imported}, дубли: ${result.duplicates}, пропуск: ${result.skipped}`);
});

$("#validateBtn").addEventListener("click", async () => {
  const result = await api("/api/validation/run", { method: "POST" });
  toast(`Поставлено в очередь: ${result.queued}`);
});

$("#mailboxForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/mailboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formJson(event.target)),
  });
  event.target.reset();
  await refresh();
  toast("Mailbox сохранен");
});

$("#campaignForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formJson(event.target)),
  });
  event.target.reset();
  await refresh();
  toast("Кампания создана");
});

$("#stepForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formJson(event.target);
  payload.body_template_html = $("#htmlEditor").innerHTML;
  await api(`/api/campaigns/${payload.campaign_id}/steps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await refresh();
  toast("Шаг добавлен");
});

$("#enrollBtn").addEventListener("click", async () => {
  const campaignId = $("#activeCampaign").value;
  const leadIds = state.leads.filter((lead) => ["valid", "risky"].includes(lead.validation_status)).map((lead) => lead.id);
  const mailboxIds = state.mailboxes.map((mailbox) => mailbox.id);
  await api(`/api/campaigns/${campaignId}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lead_ids: leadIds, mailbox_ids: mailboxIds }),
  });
  await refresh();
  toast("Лиды добавлены в кампанию");
});

$("#preflightBtn").addEventListener("click", async () => {
  const result = await api(`/api/campaigns/${$("#activeCampaign").value}/preflight`);
  $("#preflightResult").textContent = JSON.stringify(result, null, 2);
});

async function startCampaign(mode) {
  const result = await api(`/api/campaigns/${$("#activeCampaign").value}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  $("#preflightResult").textContent = JSON.stringify(result, null, 2);
  await refresh();
  toast(`Очередь: ${result.queued}`);
}

$("#startManualBtn").addEventListener("click", () => startCampaign("manual"));
$("#startAutoBtn").addEventListener("click", () => startCampaign("auto"));
$("#startTestBtn").addEventListener("click", () => startCampaign("test"));

$("#approveAllBtn").addEventListener("click", async () => {
  await api(`/api/campaigns/${$("#activeCampaign").value}/approve-pending`, { method: "POST" });
  await refresh();
  toast("Pending подтверждены");
});

document.body.addEventListener("click", async (event) => {
  const mailboxId = event.target.dataset.checkMailbox;
  const approveId = event.target.dataset.approve;
  if (mailboxId) {
    const result = await api(`/api/mailboxes/${mailboxId}/check`, { method: "POST" });
    await refresh();
    toast(`Проверка: ${JSON.stringify(result.domain)}`);
  }
  if (approveId) {
    await api(`/api/sending/${approveId}/approve`, { method: "POST" });
    await refresh();
    toast("Письмо подтверждено");
  }
});

document.body.addEventListener("change", async (event) => {
  const id = event.target.dataset.classify;
  if (!id) return;
  await api(`/api/inbox/${id}/classification`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classification: event.target.value }),
  });
  toast("Класс ответа обновлен");
});

refresh();
setInterval(loadQueue, 15000);
