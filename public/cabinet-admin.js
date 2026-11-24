const $ = (id) => document.getElementById(id);
async function admin(path, body) {
  const res = await fetch("/api/cabinet-admin" + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      {
        login_reserved:
          "Этот логин используется администратором. Выберите другой.",
        invalid_login:
          "Логин должен состоять из 3–64 латинских букв, цифр, точки, дефиса или подчёркивания.",
        too_many_requests: "Слишком много попыток. Попробуйте через 15 минут.",
      }[data.error] ||
        "Не удалось выполнить действие. Обновите страницу и попробуйте ещё раз.",
    );
  return data;
}
async function run(fn) {
  $("notice").textContent = "";
  try {
    await fn();
  } catch (e) {
    $("notice").textContent = e.message;
  }
}
async function load() {
  const list = await admin("/accounts");
  $("accounts").replaceChildren();
  for (const a of list) {
    const box = document.createElement("div");
    box.className = "card";
    const title = document.createElement("h3");
    title.textContent = a.display_name + " · " + (a.email || a.login);
    const p = document.createElement("p");
    p.textContent = !a.active
      ? "Отключён"
      : a.activated
        ? "Активирован"
        : "Ожидает активации";
    box.append(title, p);
    if (a.active) {
      const button = document.createElement("button");
      button.textContent = "Отключить кабинет";
      button.className = "danger";
      button.onclick = () =>
        run(async () => {
          if (
            !confirm(
              "Отключить " +
                a.login +
                ", отозвать доступ и остановить очередь?",
            )
          )
            return;
          await admin("/accounts/" + a.id + "/disable", {});
          await load();
        });
      box.append(button);
    }
    $("accounts").append(box);
  }
}
$("inviteForm").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const button = event.submitter;
    button.disabled = true;
    try {
      const result = await admin(
        "/invites",
        Object.fromEntries(new FormData(event.target)),
      );
      $("inviteLink").textContent =
        location.origin +
        "/cabinet#invite=" +
        encodeURIComponent(result.invite_token);
      $("inviteResult").hidden = false;
      event.target.reset();
      await load();
    } finally {
      button.disabled = false;
    }
  });
};
$("hideInvite").onclick = () => {
  $("inviteLink").textContent = "";
  $("inviteResult").hidden = true;
};
run(load);
