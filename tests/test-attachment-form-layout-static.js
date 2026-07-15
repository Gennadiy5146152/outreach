import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "id=\"attachmentForm\" class=\"attachment-form\"",
  "<span>Шаг письма</span>",
  "<span>Файл</span>",
  "Загрузить вложение",
]) {
  if (!index.includes(expected)) {
    throw new Error(`attachment form markup should include ${expected}`);
  }
}

for (const expected of [
  ".attachment-form",
  "grid-template-columns: minmax(180px, 0.9fr) minmax(220px, 1.1fr)",
  ".attachment-form input[type=\"file\"]",
  ".attachment-form button",
]) {
  if (!css.includes(expected)) {
    throw new Error(`attachment form CSS should include ${expected}`);
  }
}

console.log("OK: attachment form layout static test passed");
