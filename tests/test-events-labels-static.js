import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

for (const expected of [
  "Журнал событий",
  "что сервис сделал",
]) {
  if (!index.includes(expected)) {
    throw new Error(`events page should include Russian text: ${expected}`);
  }
}

if (index.includes("Event log")) {
  throw new Error("events page should not show English Event log title");
}

for (const expected of [
  "const EVENT_LABELS",
  "function eventSummary(event)",
  "Что произошло",
  "Кратко",
  "Показать",
  "Лид добавлен",
  "Email проверен",
  "Входящие поставлены на проверку",
  "Входящие проверены",
  "Проверка входящих пропущена",
  "Ошибка проверки входящих",
  "Входящие перепривязаны к цепочкам",
  "Входящее письмо привязано к цепочке",
  "Входящее письмо не привязано",
  "проверено писем",
  "поставлено задач",
  "проверено непривязанных входящих",
  "привязано к цепочкам",
  "Прогрев: синхронизация входящих поставлена в очередь",
]) {
  if (!app.includes(expected)) {
    throw new Error(`events UI should include ${expected}`);
  }
}

const loadEventsStart = app.indexOf("async function loadEvents()");
const loadEventsEnd = app.indexOf("async function refresh()", loadEventsStart);
const loadEventsCode = app.slice(loadEventsStart, loadEventsEnd);

for (const forbidden of ["<th>Тип</th>", "<th>Payload</th>"]) {
  if (loadEventsCode.includes(forbidden)) {
    throw new Error(`events table should not expose technical column: ${forbidden}`);
  }
}

console.log("OK: events labels static test passed");
