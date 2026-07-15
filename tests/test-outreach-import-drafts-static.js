import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const csv = fs.readFileSync("src/services/csv.js", "utf8");
const migration = fs.readFileSync("db/migrations/003_outreach_imports.sql", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

for (const expected of [
  "outreach_imports",
  "outreach_conversations",
  "outreach_drafts",
  "error_report jsonb",
]) {
  if (!migration.includes(expected)) {
    throw new Error(`outreach migration should include ${expected}`);
  }
}

if (!packageJson.dependencies["read-excel-file"]) {
  throw new Error("Excel import should use read-excel-file dependency");
}

if (packageJson.dependencies.xlsx) {
  throw new Error("xlsx dependency should not be used because it brings audit issues");
}

for (const expected of [
  "readSheet",
  "parseOutreachImportFile",
  "app.get(\"/api/outreach/imports\"",
  "app.get(\"/api/outreach/drafts\"",
  "app.post(\"/api/outreach/imports\"",
  "INSERT INTO outreach_drafts",
  "INSERT INTO outreach_conversations",
]) {
  if (!server.includes(expected)) {
    throw new Error(`outreach import API should include ${expected}`);
  }
}

for (const expected of [
  "rowsToOutreachRows",
  "followup_1_subject",
  "followup_2_body",
  "фоллоуап 3 задержка",
  "тема письма",
  "тело письма",
]) {
  if (!csv.includes(expected)) {
    throw new Error(`outreach row parser should include ${expected}`);
  }
}

for (const expected of [
  "data-view=\"outreachImport\"",
  "data-view=\"outreachDrafts\"",
  "outreachImportForm",
  "outreachImportsTable",
  "outreachDraftStatus",
  "outreachDraftsTable",
  "Импортировать письма",
  "Черновики персональных писем",
]) {
  if (!index.includes(expected)) {
    throw new Error(`outreach import UI should include ${expected}`);
  }
}

for (const expected of [
  "outreachImports: []",
  "outreachDrafts: []",
  "async function loadOutreachImports()",
  "async function loadOutreachDrafts()",
  "$(\"#outreachImportForm\").addEventListener",
  "$(\"#outreachDraftStatus\").addEventListener",
  "switchView(\"outreachDrafts\")",
  "нужно исправить",
]) {
  if (!app.includes(expected)) {
    throw new Error(`outreach import frontend should include ${expected}`);
  }
}

console.log("OK: outreach import drafts static test passed");
