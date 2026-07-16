import fs from "node:fs";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const csv = fs.readFileSync("src/services/csv.js", "utf8");
const migration = fs.readFileSync("db/migrations/003_outreach_imports.sql", "utf8");
const sequenceMigration = fs.readFileSync("db/migrations/004_outreach_draft_sequences.sql", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
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

for (const expected of [
  "outreach_draft_steps",
  "outreach_draft_id uuid REFERENCES outreach_drafts",
  "subject_override text",
  "body_text_override text",
  "messages_outreach_draft_idx",
]) {
  if (!sequenceMigration.includes(expected)) {
    throw new Error(`outreach sequence migration should include ${expected}`);
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
  "parseOutreachRawFile",
  "inferOutreachMapping",
  "app.get(\"/api/outreach/imports\"",
  "app.get(\"/api/outreach/drafts\"",
  "app.post(\"/api/outreach/imports/preview\"",
  "app.patch(\"/api/outreach/drafts/:id\"",
  "app.put(\"/api/outreach/drafts/:id/steps/:position\"",
  "app.post(\"/api/outreach/drafts/:id/cancel\"",
  "app.post(\"/api/outreach/drafts/preflight\"",
  "app.post(\"/api/outreach/drafts/start\"",
  "first_step_body_text",
  "items: rows.map",
  "app.post(\"/api/outreach/imports\"",
  "INSERT INTO outreach_drafts",
  "INSERT INTO outreach_conversations",
  "INSERT INTO outreach_draft_steps",
  "outreachStepsFromRow",
  "outreachDraftStatus",
  "unresolvedPersonalizationMarkers",
  "personalizationGuardErrors",
  "незаполненные переменные",
  "sent_step_cannot_be_edited",
  "outreach_draft_cancelled",
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
  "outreachImportPreview",
  "outreachColumnMapping",
  "previewOutreachImportBtn",
  "createOutreachDraftsBtn",
  "outreachImportsTable",
  "outreachDraftStatus",
  "startSelectedDraftsBtn",
  "preflightSelectedDraftsBtn",
  "outreachDraftLaunchReview",
  "outreachDraftLaunchTable",
  "outreachDraftsTable",
  "Создать черновики",
  "Черновики персональных писем",
  "Запустить выбранные",
  "В очереди",
]) {
  if (!index.includes(expected)) {
    throw new Error(`outreach import UI should include ${expected}`);
  }
}

for (const expected of [
  "outreachImports: []",
  "outreachImportPreview: null",
  "outreachDrafts: []",
  "async function loadOutreachImports()",
  "function renderOutreachImportPreview()",
  "function currentOutreachMapping()",
  "async function loadOutreachDrafts()",
  "startOutreachDrafts",
  "preflightOutreachDrafts",
  "reviewOutreachDrafts",
  "renderOutreachDraftLaunchReview",
  "selectedOutreachDraftSignature",
  "$(\"#outreachImportForm\").addEventListener",
  "$(\"#previewOutreachImportBtn\").addEventListener",
  "$(\"#outreachDraftStatus\").addEventListener",
  "$(\"#preflightSelectedDraftsBtn\").addEventListener",
  "$(\"#startSelectedDraftsBtn\").addEventListener",
  "data-outreach-draft-form",
  "data-outreach-step-form",
  "data-start-draft",
  "data-cancel-draft",
  "Follow-up",
  "Сохранение follow-up",
  "Follow-up сохранен как “нужно исправить”",
  "Отмена черновика",
  "switchView(\"outreachDrafts\")",
  "нужно исправить",
]) {
  if (!app.includes(expected)) {
    throw new Error(`outreach import frontend should include ${expected}`);
  }
}

for (const expected of [
  "subject_override || item.subject_template",
  "body_text_override || item.body_template_text",
  "outreach_draft_id, outreach_step_id",
  "UPDATE outreach_draft_steps",
  "UPDATE outreach_drafts SET status = 'active_sequence'",
  "requires_approval = true",
  "approve_or_pause_followup",
  "AND status <> 'blocked'",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should support outreach draft sequences: ${expected}`);
  }
}

console.log("OK: outreach import drafts static test passed");
