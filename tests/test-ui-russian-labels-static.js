import fs from "node:fs";

const publicFiles = [
  fs.readFileSync("public/index.html", "utf8"),
  fs.readFileSync("public/app.js", "utf8"),
].join("\n");
const index = fs.readFileSync("public/index.html", "utf8");
const styles = fs.readFileSync("public/styles.css", "utf8");

for (const forbidden of [
  "dry-run:",
  "tracking:",
  "Open tracking",
  "Runtime настройки",
  "Подключить mailbox",
  "Mailbox для прогрева",
  "Сохранение mailbox",
  "Mailbox ${result.email}",
  "нет готового mailbox",
  "mailbox: ${mailboxCount}",
  "SMTP: ok",
  "IMAP: ok",
]) {
  if (publicFiles.includes(forbidden)) {
    throw new Error(`public UI should not expose technical English label: ${forbidden}`);
  }
}

for (const expected of [
  "class=\"nav-group\"",
  "class=\"nav-group nav-group-secondary\"",
  "<span>Аутрич</span>",
  "<span>Ответы</span>",
  "<span>Данные</span>",
  "<span>Почта</span>",
  "Почтовые ящики",
]) {
  if (!index.includes(expected)) {
    throw new Error(`left navigation should include grouped Russian item: ${expected}`);
  }
}

for (const expected of [
  "const ACTIVE_VIEW_STORAGE_KEY",
  "const VIEW_TITLES",
  "function viewFromLocation()",
  "window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, view)",
  "window.history.replaceState",
  "window.addEventListener(\"hashchange\"",
  "switchView(viewFromLocation())",
]) {
  if (!publicFiles.includes(expected)) {
    throw new Error(`active page should be restored after reload: ${expected}`);
  }
}

for (const expected of [
  ".nav-group",
  ".nav-group-secondary",
  "overflow-y: auto",
]) {
  if (!styles.includes(expected)) {
    throw new Error(`left navigation styles should include ${expected}`);
  }
}

console.log("OK: public UI Russian labels static test passed");
