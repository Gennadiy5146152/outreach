import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "inbox-card",
  "inbox-card-head",
  "inbox-message",
  "inbox-classify",
  "Без темы",
  "Класс ответа",
  "statusLabel(value)",
]) {
  if (!app.includes(expected)) {
    throw new Error(`inbox rendering should include ${expected}`);
  }
}

for (const expected of [
  ".inbox-card",
  ".inbox-card-head",
  ".inbox-message",
  "overflow-wrap: anywhere",
  "word-break: break-word",
  "min-width: 0",
]) {
  if (!css.includes(expected)) {
    throw new Error(`inbox layout CSS should include ${expected}`);
  }
}

console.log("OK: inbox layout static test passed");
