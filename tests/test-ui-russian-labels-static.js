import fs from "node:fs";

const publicFiles = [
  fs.readFileSync("public/index.html", "utf8"),
  fs.readFileSync("public/app.js", "utf8"),
].join("\n");

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

console.log("OK: public UI Russian labels static test passed");
