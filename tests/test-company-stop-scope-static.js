import fs from "node:fs";

const runtime = fs.readFileSync("src/services/runtime.js", "utf8");
const stopService = fs.readFileSync("src/services/outreach-stop.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

for (const expected of [
  "OUTREACH_STOP_SCOPES",
  "contact_only",
  "same_domain",
  "same_company",
  "affectedLeadIds",
  "cancelOutreachForScope",
  "holdOutreachForScope",
  "lower(l.domain)",
  "lower(l.company)",
  "company_scope_reply_review",
]) {
  if (!stopService.includes(expected)) {
    throw new Error(`company/domain stop service should include ${expected}`);
  }
}

for (const expected of [
  "outreachStopScope",
  "settings.outreach?.stopScope",
  "normalizeOutreachStopScope",
  "timeZone: normalizeTimeZone",
  "VALUES ('tracking', $1, now()), ('attachments', $2, now()), ('outreach', $3, now())",
]) {
  if (!runtime.includes(expected)) {
    throw new Error(`runtime settings should include stop scope: ${expected}`);
  }
}

for (const expected of [
  "outreachStopScope: runtime.outreachStopScope",
  "timeZone: runtime.timeZone",
  "const outreachStopScope = cleanText(req.body.outreachStopScope)",
  "const timeZone = cleanText(req.body.timeZone)",
  "invalid_time_zone",
  "cancelOutreachForScope(client",
  "stopScope",
  "affectedLeads",
]) {
  if (!server.includes(expected)) {
    throw new Error(`server should apply stop scope: ${expected}`);
  }
}

for (const expected of [
  "cancelOutreachForScope, holdOutreachForScope",
  "const stopScope = runtime.outreachStopScope",
  "holdOutreachForScope(query",
  "cancelOutreachForScope(query",
  "heldQueue",
  "affectedLeads",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should apply stop scope: ${expected}`);
  }
}

for (const expected of [
  "После ответа остановить",
  "Часовой пояс",
  "renderTimeZoneOptions",
  "Только этот email",
  "Всех с тем же доменом",
  "Всех из той же компании",
  "function stopScopeLabel",
  "поставлено на ручное решение",
  "затронуто лидов",
]) {
  if (!app.includes(expected)) {
    throw new Error(`frontend should explain stop scope: ${expected}`);
  }
}

console.log("OK: company stop scope static test passed");
