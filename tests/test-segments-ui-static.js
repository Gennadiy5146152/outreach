import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

for (const expected of [
  "class=\"segment-picker\"",
  "class=\"segment-input\" name=\"segment\"",
  "class=\"segment-menu\" hidden",
  "Выбери сохраненный или введи новый",
]) {
  if (!index.includes(expected)) {
    throw new Error(`segment inputs should include ${expected}`);
  }
}

if (index.includes("list=\"segmentOptions\"") || index.includes("<datalist")) {
  throw new Error("segment inputs should use the full-width custom picker, not native datalist");
}

for (const expected of [
  "segments: []",
  "async function loadSegments()",
  "await api(\"/api/segments\")",
  "function renderSegmentPicker(input)",
  "function closeSegmentPickers()",
  "data-segment-value",
  "console.warn(\"Не удалось загрузить сегменты\"",
  "loadSegments()",
]) {
  if (!app.includes(expected)) {
    throw new Error(`segment frontend should include ${expected}`);
  }
}

for (const expected of [
  ".segment-picker",
  ".segment-menu",
  "width: 100%",
  "top: calc(100% + 4px)",
]) {
  if (!css.includes(expected)) {
    throw new Error(`segment picker CSS should include ${expected}`);
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
