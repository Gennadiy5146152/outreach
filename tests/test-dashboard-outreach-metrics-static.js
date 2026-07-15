import fs from "node:fs";

const server = fs.readFileSync("src/server.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

const dashboardStart = server.indexOf("app.get(\"/api/dashboard\"");
const dashboardEnd = server.indexOf("app.get(\"/api/leads\"", dashboardStart);
const dashboardCode = server.slice(dashboardStart, dashboardEnd);

for (const expected of [
  "direction = 'outbound' AND type = 'outreach' AND status = 'sent'",
  "JOIN messages msg ON msg.id = o.message_id",
  "WHERE msg.type = 'outreach'",
  "direction = 'inbound'",
  "AND type = 'reply'",
  "AND campaign_id IS NOT NULL",
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
  "рассылки, без прогрева",
  "без прогрева",
  "по рассылкам, без прогрева",
]) {
  if (!app.includes(expected)) {
    throw new Error(`dashboard UI should explain filtered metrics: ${expected}`);
  }
}

console.log("OK: dashboard outreach metrics static test passed");
