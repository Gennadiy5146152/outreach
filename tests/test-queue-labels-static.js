import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

for (const expected of [
  "Очередь отправки",
  "какие письма ждут отправки",
  "Подтвердить все ожидающие",
]) {
  if (!index.includes(expected)) {
    throw new Error(`queue page should include Russian text: ${expected}`);
  }
}

for (const expected of [
  "function queueModeLabel",
  "function queueStatusHint",
  "Когда отправлять",
  "Почта отправителя",
  "Что сделать",
  "Подтвердить</button>",
  "Очередь пуста",
  "тест на свои почты",
  "ручная проверка перед отправкой",
  "обычная отправка",
  "ждет подтверждения",
]) {
  if (!app.includes(expected)) {
    throw new Error(`queue UI should include ${expected}`);
  }
}

const queueStart = app.indexOf("async function loadQueue()");
const queueEnd = app.indexOf("async function loadInbox()", queueStart);
const queueCode = app.slice(queueStart, queueEnd);

for (const forbidden of ["<th>Mailbox</th>", "<th>Ошибка</th>", ">OK</button>", "ETA:", "Progress:"]) {
  if (queueCode.includes(forbidden)) {
    throw new Error(`queue UI should not expose technical label: ${forbidden}`);
  }
}

console.log("OK: queue labels static test passed");
