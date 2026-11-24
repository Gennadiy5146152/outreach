const $ = (id) => document.getElementById(id);
let csrf = "",
  campaigns = [],
  campaignId = "",
  draftPage = 1,
  queuePage = 1,
  qrId = "",
  verifiedEmail = "",
  qrTimer,
  plan = null;
let invite = new URLSearchParams(location.hash.slice(1)).get("invite");
if (invite) history.replaceState(null, "", location.pathname);
const errors = {
  telegram_connection_attention_required:
    "Отправка остановлена из-за ограничения Telegram или неопределённой доставки. Проверьте результат в Telegram, затем подключите профиль заново после решения проблемы.",
  invalid_email: "Проверьте адрес электронной почты.",
  email_auth_not_configured:
    "Отправка писем пока не настроена. Обратитесь к администратору.",
  token_scope_invalid: "Выберите права и разрешённые рассылки для токена.",
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
  password_requires_12_characters:
    "Пароль должен содержать минимум 12 символов.",
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
  const res = await fetch("/api/cabinet" + path, {
    method: method || (body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Сервис недоступен.");
  }
  if (!res.ok)
    throw new Error(
      errors[data.error] ||
        "Не удалось выполнить действие. Обновите страницу и попробуйте ещё раз.",
    );
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
  $(id).addEventListener("submit", (event) => {
    event.preventDefault();
    work(async () => {
      const b = event.submitter || event.target.querySelector("button");
      if (b) b.disabled = true;
      try {
        await fn(Object.fromEntries(new FormData(event.target)), event.target);
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
    p.minLength = 12;
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
  } catch (e) {
    location.replace("/login.html");
  }
}
async function refresh() {
  await loadConnections();
  campaigns = await api("/campaigns");
  $("campaignCount").textContent = campaigns.length;
  $("campaignSelect").replaceChildren();
  $("tokenCampaigns").replaceChildren();
  $("tokenForm").querySelector("button").disabled = !campaigns.length;
  if (!campaigns.length)
    $("tokenCampaigns").append(
      node(
        "p",
        "Сначала создайте рассылку. Затем выберите, к каким рассылкам будет доступ у токена.",
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
  await loadContent();
  await loadTokens();
}
async function loadConnections() {
  const list = await api("/connections");
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
      c.label,
      (statuses[c.status] || c.status) +
        " · @" +
        (c.username || c.expected_username) +
        (c.error_code
          ? " · " + (errors[c.error_code] || "Нужно подключить профиль заново.")
          : ""),
    );
    box.dataset.status = c.status;
    if (c.status !== "connected")
      box.append(
        button("Войти по QR", async () => {
          await api(`/connections/${c.id}/qr`, {});
          watchQr(c.id);
        }),
      );
    box.append(
      button("Отключить", async () => {
        if (!confirm("Отключить профиль и отменить его оставшуюся очередь?"))
          return;
        await api(`/connections/${c.id}/disconnect`, {});
        if (qrId === c.id) {
          clearTimeout(qrTimer);
          $("qrPanel").hidden = true;
        }
        await refresh();
      }),
    );
    $("connections").append(box);
    const o = node("option", c.label);
    o.value = c.id;
    $("connectionSelect").append(o);
  }
}
function watchQr(id) {
  qrId = id;
  clearTimeout(qrTimer);
  $("qrPanel").hidden = false;
  const poll = async () => {
    try {
      const data = await api(`/connections/${id}/qr`);
      if (qrId !== id) return;
      const titles = {
        pending_qr: "Готовим QR-код…",
        qr_ready: "Отсканируйте QR-код",
        password_required: "Введите облачный пароль Telegram",
        connected: "Telegram подключён",
        expired: "QR истёк. Запросите новый.",
        error: "Не удалось подключить Telegram",
        disconnected: "Telegram отключён",
      };
      $("qrStatus").textContent = titles[data.status] || data.status;
      $("qrError").textContent = data.error_code
        ? errors[data.error_code] ||
          "Не удалось подключиться. Попробуйте ещё раз."
        : "";
      $("qrImage").hidden = !data.qr_svg;
      $("qrImage").src = data.qr_svg
        ? "data:image/svg+xml;base64," + btoa(data.qr_svg)
        : "";
      $("twoFactor").hidden = data.status !== "password_required";
      if (data.status === "connected") {
        await refresh();
        return;
      }
      if (["expired", "error", "disconnected"].includes(data.status)) return;
      qrTimer = setTimeout(poll, 2000);
    } catch (e) {
      $("qrError").textContent = e.message;
    }
  };
  poll();
}
async function loadContent() {
  $("drafts").replaceChildren();
  $("queue").replaceChildren();
  $("thread").replaceChildren();
  const c = campaigns.find((c) => c.id === campaignId);
  $("campaignState").textContent = c
    ? `${c.paused ? "На паузе" : "Запущена"} · до ${c.daily_limit} сообщений в день · ${c.window_start.slice(0, 5)}–${c.window_end.slice(0, 5)} МСК`
    : "Создайте рассылку.";
  if (!c) return;
  await loadDrafts();
  await loadQueue();
}
async function loadDrafts() {
  if (!campaignId) return;
  const list = await api(`/campaigns/${campaignId}/drafts?page=${draftPage}`);
  $("drafts").replaceChildren();
  if (!list.length)
    $("drafts").append(
      node(
        "p",
        "Черновиков пока нет. Добавьте сообщение или импортируйте подготовленные тексты.",
        "muted",
      ),
    );
  $("draftPage").textContent = "Страница " + draftPage;
  $("prevDrafts").disabled = draftPage <= 1;
  $("nextDrafts").disabled = list.length < 100;
  for (const d of list) {
    const box = card(d.name || d.address);
    const label = node("label", undefined, "check"),
      input = node("input");
    input.type = "checkbox";
    input.value = d.id;
    input.name = "draft";
    label.append(
      input,
      document.createTextNode(d.address + (d.stopped ? " · остановлен" : "")),
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
  for (const job of list) {
    const box = card(
      job.address,
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
        item.address + (item.scheduled_at ? " · " + at(item.scheduled_at) : ""),
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
  await loadConnections();
  watchQr(c.id);
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
  await refresh();
});
form("draftForm", async (data, element) => {
  if (!campaignId) throw new Error("Выберите рассылку.");
  await api(`/campaigns/${campaignId}/drafts`, data);
  element.reset();
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
  if (!campaign_ids.length)
    throw new Error("Выберите хотя бы одну разрешённую рассылку.");
  const result = await api("/tokens", {
    name: data.name,
    expires_in_days: Number(data.expires_in_days),
    scopes,
    campaign_ids,
  });
  $("tokenValue").textContent = result.token;
  $("tokenCopyStatus").textContent = "";
  $("tokenReveal").hidden = false;
  await loadTokens();
});
form("emailForm", async (data) => {
  const result = await api("/profile/email", data);
  $("emailMessage").textContent = result.message;
});
$("hideToken").onclick = () => {
  $("tokenValue").textContent = "";
  $("tokenCopyStatus").textContent = "";
  $("tokenReveal").hidden = true;
};
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
    clearTimeout(qrTimer);
    location.reload();
  });
$("campaignSelect").onchange = () =>
  work(async () => {
    campaignId = $("campaignSelect").value;
    draftPage = queuePage = 1;
    await loadContent();
  });
for (const [id, fn] of Object.entries({
  refreshDrafts: refresh,
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
  campaigns: "Рассылки",
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
