import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");

for (const expected of [
  "name=\"segment\" list=\"segmentOptions\"",
  "<datalist id=\"segmentOptions\"></datalist>",
  "Выбери сохраненный или введи новый",
]) {
  if (!index.includes(expected)) {
    throw new Error(`segment inputs should include ${expected}`);
  }
}

for (const expected of [
  "segments: []",
  "async function loadSegments()",
  "await api(\"/api/segments\")",
  "$(\"#segmentOptions\").innerHTML",
  "console.warn(\"Не удалось загрузить сегменты\"",
  "loadSegments()",
]) {
  if (!app.includes(expected)) {
    throw new Error(`segment frontend should include ${expected}`);
  }
}

for (const expected of [
  "app.get(\"/api/segments\"",
  "FROM leads",
  "FROM campaigns",
  "cleanText(req.body.segment)",
  "cleanText(row.segment)",
]) {
  if (!server.includes(expected)) {
    throw new Error(`segment API should include ${expected}`);
  }
}

console.log("OK: segments UI static test passed");
