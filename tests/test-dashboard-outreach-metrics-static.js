import fs from "node:fs";

const server = fs.readFileSync("src/server.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const index = fs.readFileSync("public/index.html", "utf8");

const dashboardStart = server.indexOf("app.get(\"/api/dashboard\"");
const dashboardEnd = server.indexOf("app.get(\"/api/leads\"", dashboardStart);
const dashboardCode = server.slice(dashboardStart, dashboardEnd);

for (const expected of [
  "direction = 'outbound' AND type = 'outreach' AND status = 'sent'",
  "outreach_imports",
  "outreach_drafts",
  "outreach_conversations",
  "classification = 'positive_reply'",
  "classification = 'negative_reply'",
  "classification = 'auto_reply'",
  "outreachReplyRate",
  "positiveReplyRate",
  "avg_hours_to_reply",
  "outreach_step_id IS NOT NULL",
  "JOIN messages msg ON msg.id = o.message_id",
  "WHERE msg.type = 'outreach'",
  "direction = 'inbound'",
  "AND type = 'reply'",
  "AND campaign_id IS NOT NULL",
  "stepPerformance",
  "step_sends",
  "step_opens",
  "step_replies",
  "reply_times",
  "stopped_after_step",
  "avg_hours_to_reply",
  "open_rate",
  "positive_rate",
]) {
  if (!dashboardCode.includes(expected)) {
    throw new Error(`dashboard outreach metrics should include ${expected}`);
  }
}

for (const forbidden of [
  "FROM open_events\n    `)",
  "WHERE direction = 'inbound'\n    `)",
]) {
  if (dashboardCode.includes(forbidden)) {
    throw new Error(`dashboard should not count all events/messages without outreach filters: ${forbidden}`);
  }
}

for (const expected of [
  "Импортировано строк",
  "Готово черновиков",
  "Требуют решения",
  "function stepName",
  "stepPerformanceTable",
  "Первое письмо",
  "Follow-up",
  "Доля ответивших",
  "Доля позитивных ответов",
  "Среднее время до ответа",
  "Метрики считаются по outreach, без прогрева и тестовых писем.",
]) {
  if (!app.includes(expected)) {
    throw new Error(`dashboard UI should explain filtered metrics: ${expected}`);
  }
}

for (const expected of [
  "stepPerformanceTable",
  "Эффективность шагов цепочки",
  "какие письма в цепочке реально дают открытия",
]) {
  if (!index.includes(expected)) {
    throw new Error(`dashboard step performance UI should include ${expected}`);
  }
}

console.log("OK: dashboard outreach metrics static test passed");
