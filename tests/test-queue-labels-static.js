import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

for (const expected of [
  "Очередь отправки",
  "какие письма ждут отправки",
  "Подтвердить все ожидающие",
  "queueSummary",
]) {
  if (!index.includes(expected)) {
    throw new Error(`queue page should include Russian text: ${expected}`);
  }
}

for (const expected of [
  "function queueModeLabel",
  "function queueStatusHint",
  "function queueScheduleLabel",
  "function queueStateLabel",
  "function queueNextAction",
  "function queueReasonText",
  "Когда</th>",
  "Кому и что",
  "Отправитель",
  "Действие",
  "Подтвердить</button>",
  "Очередь пуста",
  "ручная проверка перед отправкой",
  "обычная отправка",
  "ждет подтверждения",
  "сразу",
  "сейчас",
  "через ${fmtCountdown(value)}",
  "Вне окна отправки",
  "Ждут окна",
  "Ждут подтверждения",
  "Ничего нажимать не нужно",
]) {
  if (!app.includes(expected)) {
    throw new Error(`queue UI should include ${expected}`);
  }
}

const queueStart = app.indexOf("async function loadQueue()");
const queueEnd = app.indexOf("async function loadInbox()", queueStart);
const queueCode = app.slice(queueStart, queueEnd);

for (const forbidden of ["<th>Mailbox</th>", "<th>Ошибка</th>", ">OK</button>", "ETA:", "Progress:", "<th>Режим</th>"]) {
  if (queueCode.includes(forbidden)) {
    throw new Error(`queue UI should not expose technical label: ${forbidden}`);
  }
}

for (const expected of [
  "#queueTable",
  ".queue-recipient",
  ".queue-state",
  ".queue-action",
]) {
  if (!fs.readFileSync("public/styles.css", "utf8").includes(expected)) {
    throw new Error(`queue UI styles should include ${expected}`);
  }
}

console.log("OK: queue labels static test passed");
