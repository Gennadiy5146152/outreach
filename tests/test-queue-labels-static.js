import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");

for (const expected of [
  "Очередь отправки",
  "какие письма ждут отправки",
  "Подтвердить все ожидающие",
  "queueSummary",
  "Ожидает отправки",
  "Отправлено",
  "Все",
]) {
  if (!index.includes(expected)) {
    throw new Error(`queue page should include Russian text: ${expected}`);
  }
}

for (const expected of [
  "function queueModeLabel",
  "function queueStatusHint",
  "function queueScheduleLabel",
  "function queueTimeLabel",
  "function queueStateLabel",
  "function queueNextAction",
  "function queueReasonText",
  "function queueNeedsSending",
  "function queueFilterLabel",
  "function queueSortRank",
  "function queueGroupKey",
  "function queueGroups",
  "function queueChainEvents",
  "function renderQueueGroupDetails",
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
  "Показано",
  "Цепочек на экране",
  "Цепочка писем",
  "Отправленные письма",
  "Ответ получателя",
  "visibleQueue",
  "visibleGroups",
  "data-queue-filter",
  "data-queue-group-toggle",
  "sent_at",
  "item.sent_at || item.updated_at",
  "updated_at",
  "chain_messages",
]) {
  if (!app.includes(expected)) {
    throw new Error(`queue UI should include ${expected}`);
  }
}

for (const expected of [
  "WHEN q.status = 'sent' THEN COALESCE(sent.sent_at, q.updated_at)",
  "LEFT JOIN messages sent ON sent.id = q.sent_message_id",
  "COALESCE(history.messages, '[]'::json) AS chain_messages",
  "LEFT JOIN LATERAL",
  "msg.type <> 'warmup'",
]) {
  if (!server.includes(expected)) {
    throw new Error(`queue API should expose real sent time: ${expected}`);
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
  ".queue-chain",
  ".queue-chain-event",
  ".quick-filters",
]) {
  if (!fs.readFileSync("public/styles.css", "utf8").includes(expected)) {
    throw new Error(`queue UI styles should include ${expected}`);
  }
}

console.log("OK: queue labels static test passed");
