const $ = (id) => document.getElementById(id);
const errors = {
  invalid_credentials: "Неверный email, логин или пароль.",
  invalid_email: "Проверьте адрес электронной почты.",
  email_link_invalid:
    "Ссылка уже использована или срок её действия истёк. Запросите новое письмо.",
  password_requires_12_characters:
    "Пароль должен содержать не менее 12 символов.",
  email_wrong_account:
    "Войдите в тот кабинет, где вы запросили привязку почты, затем откройте ссылку ещё раз.",
  owner_session_required:
    "Для привязки почты войдите в свой кабинет и откройте ссылку ещё раз.",
  cabinet_auth_required:
    "Для привязки почты войдите в свой кабинет и откройте ссылку ещё раз.",
  too_many_requests: "Слишком много попыток. Попробуйте через 15 минут.",
  registration_disabled:
    "Регистрация пока недоступна. Обратитесь к администратору.",
  email_auth_not_configured:
    "Отправка писем ещё не настроена. Обратитесь к администратору.",
  origin_denied: "Откройте страницу по основному адресу сервиса.",
  cabinet_https_not_configured: "Сервис ещё настраивается. Попробуйте позже.",
};
let confirmation = new URLSearchParams(location.hash.slice(1)).get("confirm"),
  kind = "",
  options = {};
if (confirmation)
  history.replaceState(null, "", location.pathname + "#confirm");
function message(text, ok = false) {
  $("loginMessage").hidden = false;
  $("loginMessage").textContent = text;
  $("loginMessage").classList.toggle("success", ok);
}
async function request(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Сервис временно недоступен. Попробуйте ещё раз.");
  }
  if (!response.ok)
    throw new Error(
      errors[data.error] ||
        "Не удалось выполнить действие. Попробуйте ещё раз.",
    );
  return data;
}
function pane(name) {
  for (const mode of ["login", "register", "recover", "confirm"])
    $(mode + "Pane").hidden = mode !== name;
  const heading = $(name + "Pane").querySelector("h1");
  heading.tabIndex = -1;
  heading.classList.add("page-heading");
  document.title = heading.textContent + " · Outreach";
}
function mode() {
  const current = location.hash.slice(1);
  pane(
    current === "register"
      ? "register"
      : current === "recover"
        ? "recover"
        : current === "confirm" && confirmation
          ? "confirm"
          : "login",
  );
  $("loginMessage").hidden = true;
}
function bind(id, callback) {
  $(id).onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter || event.target.querySelector("button");
    if (button) button.disabled = true;
    $("loginMessage").hidden = true;
    try {
      await callback(
        Object.fromEntries(new FormData(event.target)),
        event.target,
      );
    } catch (error) {
      message(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  };
}
bind("loginForm", async (data) => {
  const result = await request("/api/auth/login", data);
  location.href = result.redirect || "/";
});
bind("registerForm", async (data, form) => {
  if (!options.registration) throw new Error(errors.registration_disabled);
  const result = await request("/api/cabinet/auth/register", data);
  form.reset();
  message(result.message, true);
});
bind("recoverForm", async (data, form) => {
  if (!options.recovery) throw new Error(errors.email_auth_not_configured);
  const result = await request("/api/cabinet/auth/recover", data);
  form.reset();
  message(result.message, true);
});
bind("confirmForm", async (data, form) => {
  if (kind !== "attach" && data.password !== data.repeat)
    throw new Error("Пароли не совпадают.");
  const result = await request("/api/cabinet/auth/email/complete", {
    token: confirmation,
    ...(kind !== "attach" ? { password: data.password } : {}),
  });
  form.reset();
  confirmation = null;
  if (result.kind === "register" || result.kind === "attach") {
    location.href = "/cabinet";
    return;
  }
  history.replaceState(null, "", location.pathname + "#login");
  pane("login");
  message(
    result.kind === "admin_reset"
      ? "Пароль изменён. Войдите с новым паролем."
      : "Пароль изменён. Войдите заново. Старые сеансы и MCP-токены отозваны, очередь этого кабинета остановлена.",
    true,
  );
});
window.addEventListener("hashchange", () => {
  const incoming = new URLSearchParams(location.hash.slice(1)).get("confirm");
  if (incoming) {
    confirmation = incoming;
    history.replaceState(null, "", location.pathname + "#confirm");
    boot();
  } else {
    mode();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    document
      .querySelector(".auth-card > div:not([hidden]) h1")
      .focus({ preventScroll: true });
  }
});
history.scrollRestoration = "manual";
async function boot() {
  mode();
  try {
    options = await request("/api/cabinet/auth/options");
    $("registerLink").hidden = !options.registration;
    $("recoverLink").hidden = !options.recovery;
    if (confirmation) {
      const requested = confirmation;
      const info = await request("/api/cabinet/auth/email/inspect", {
        token: requested,
      });
      if (confirmation !== requested) return;
      kind = info.kind;
      $("confirmTitle").textContent =
        kind === "attach"
          ? "Подтвердить почту"
          : kind === "register"
            ? "Задайте пароль"
            : "Новый пароль";
      document.title = $("confirmTitle").textContent + " · Outreach";
      $("confirmEmail").textContent = info.email;
      $("confirmForm").hidden = false;
      $("newPasswordFields").hidden = kind === "attach";
      for (const input of $("newPasswordFields").querySelectorAll("input"))
        input.required = kind !== "attach";
      $("confirmSubmit").textContent =
        kind === "attach" ? "Подтвердить почту" : "Сохранить пароль";
      return;
    }
    const status = await request("/api/auth/status");
    if (status.authenticated && (!location.hash || location.hash === "#login"))
      location.href = status.redirect || "/";
  } catch (error) {
    if (confirmation && location.hash === "#confirm") {
      $("confirmTitle").textContent = "Не удалось открыть ссылку";
      $("confirmForm").hidden = true;
      document.title = "Проверка ссылки · Outreach";
    }
    message(error.message);
  }
}
boot();
