import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");

if (!app.includes("data-warmup-limit")) {
  throw new Error("warmup page should expose editable daily warmup limit form");
}

if (!app.includes("Сохранение лимита прогрева")) {
  throw new Error("warmup limit save action should show a clear result");
}

if (!app.includes("body: JSON.stringify({ daily_warmup_limit: dailyWarmupLimit })")) {
  throw new Error("warmup limit form should PATCH daily_warmup_limit");
}

if (!server.includes("optionalPositiveInteger(req.body.daily_warmup_limit")) {
  throw new Error("server should validate daily_warmup_limit as positive integer");
}

console.log("OK: warmup limit static test passed");
