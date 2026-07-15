import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");
const index = fs.readFileSync("public/index.html", "utf8");

for (const expected of [
  "const STATUS_LABELS",
  "valid: \"можно отправлять\"",
  "risky: \"нужна проверка\"",
  "unknown: \"еще не проверяли\"",
  "const VALIDATION_REASON_LABELS",
  "safe_checks_passed: \"формат, домен и почтовые записи в порядке\"",
  "validationReasonText(lead.validation_reason)",
]) {
  if (!app.includes(expected)) {
    throw new Error(`lead validation UI should include ${expected}`);
  }
}

for (const expected of [
  "Проверка email",
  "можно ли отправлять письма этому лиду",
  "адрес спорный",
  "не отправлять",
]) {
  if (!index.includes(expected)) {
    throw new Error(`lead validation help should include ${expected}`);
  }
}

console.log("OK: lead validation labels static test passed");
