import fs from "node:fs";
import { rowsToOutreachRows } from "../src/services/csv.js";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const styles = fs.readFileSync("public/styles.css", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const csv = fs.readFileSync("src/services/csv.js", "utf8");
const migration = fs.readFileSync("db/migrations/003_outreach_imports.sql", "utf8");
const sequenceMigration = fs.readFileSync("db/migrations/004_outreach_draft_sequences.sql", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const stopService = fs.readFileSync("src/services/outreach-stop.js", "utf8");
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
  "app.get(\"/api/outreach/imports/template.csv\"",
  "app.get(\"/api/outreach/imports/:id/errors.csv\"",
  "error_report",
  "app.get(\"/api/outreach/drafts\"",
  "app.post(\"/api/outreach/imports/preview\"",
  "app.patch(\"/api/outreach/drafts/:id\"",
  "app.put(\"/api/outreach/drafts/:id/steps/:position\"",
  "app.post(\"/api/outreach/drafts/:id/cancel\"",
  "app.delete(\"/api/outreach/drafts/:id\"",
  "outreach_draft_deleted",
  "DELETE FROM outreach_drafts",
  "Черновик уже был запущен или имеет историю",
  "app.post(\"/api/outreach/drafts/preflight\"",
  "app.post(\"/api/outreach/drafts/start\"",
  "first_step_body_text",
  "items: rows.map",
  "app.post(\"/api/outreach/imports\"",
  "INSERT INTO outreach_drafts",
  "INSERT INTO outreach_conversations",
  "INSERT INTO outreach_draft_steps",
  "outreachStepsFromRow",
  "outreachDelayDays",
  "outreachDelayDays(row.followup_1_delay_days, 3)",
  "outreachDelayDays(row.followup_2_delay_days, 4)",
  "outreachDelayDays(row.followup_3_delay_days, 5)",
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
  "String(value ?? \"\").trim()",
  "followup_1_subject",
  "followup_2_body",
  "фоллоуап 3 задержка",
  "фоллоуап 1: тема",
  "текст письма",
  "почта получателя",
  "тема письма",
  "тело письма",
]) {
  if (!csv.includes(expected)) {
    throw new Error(`outreach row parser should include ${expected}`);
  }
}

const parsedZeroDelays = rowsToOutreachRows([
  [
    "Почта получателя",
    "Тема письма",
    "Текст письма",
    "Фоллоуап 1: текст",
    "Фоллоуап 1: задержка дней",
    "Фоллоуап 2: текст",
    "Фоллоуап 2: задержка дней",
  ],
  [
    "client@example.com",
    "Тема",
    "Первое письмо",
    "Первый follow-up",
    0,
    "Второй follow-up",
    0,
  ],
]);

if (parsedZeroDelays[0]?.followup_1_delay_days !== "0" || parsedZeroDelays[0]?.followup_2_delay_days !== "0") {
  throw new Error("outreach Excel parser should preserve numeric zero follow-up delays");
}

for (const expected of [
  "Почта получателя",
  "Почта отправителя",
  "Тема письма",
  "Текст письма",
  "Фоллоуап 1: задержка дней",
]) {
  if (!server.includes(expected)) {
    throw new Error(`outreach template should use Russian column title: ${expected}`);
  }
}

for (const expected of [
  "data-view=\"outreachImport\"",
  "data-view=\"outreachDrafts\"",
  "outreachImportForm",
  "outreachImportPreview",
  "createOutreachDraftsBtn",
  "Строки из файла",
  "Скачать шаблон",
  "/api/outreach/imports/template.csv",
  "outreachImportsTable",
  "outreachDraftStatus",
  "startSelectedDraftsBtn",
  "preflightSelectedDraftsBtn",
  "deleteSelectedDraftsBtn",
  "outreachDraftLaunchReview",
  "outreachDraftLaunchTable",
  "outreachDraftsTable",
  "outreachDraftDrawer",
  "outreachDraftDrawerBody",
  "closeOutreachDraftDrawer",
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
  "Файл читается по шаблону автоматически",
  "async function loadOutreachDrafts()",
  "startOutreachDrafts",
  "preflightOutreachDrafts",
  "reviewOutreachDrafts",
  "renderOutreachDraftLaunchReview",
  "selectedOutreachDraftSignature",
  "canDeleteOutreachDraft",
  "selectedReadyOutreachDraftIds",
  "selectedDeletableOutreachDraftIds",
  "CSV ошибок",
  "$(\"#outreachImportForm\").addEventListener",
  "Читаю файл и готовлю список строк",
  "После выбора список строк появится автоматически",
  "$(\"#outreachDraftStatus\").addEventListener",
  "$(\"#preflightSelectedDraftsBtn\").addEventListener",
  "$(\"#startSelectedDraftsBtn\").addEventListener",
  "$(\"#deleteSelectedDraftsBtn\").addEventListener",
  "data-outreach-draft-form",
  "data-outreach-step-form",
  "data-edit-outreach-draft",
  "data-start-draft",
  "data-cancel-draft",
  "data-delete-draft",
  "openOutreachDraftDrawer",
  "refreshOpenOutreachDraftDrawer",
  "renderOutreachDraftFollowups",
  "Добавить follow-up",
  "Здесь показаны только follow-up, которые реально есть в черновике",
  "Email получателя",
  "Почта отправителя",
  "Отправить не раньше",
  "Если лид ответит",
  "Follow-up",
  "Сохранение follow-up",
  "Follow-up сохранен как “нужно исправить”",
  "Отмена черновика",
  "Удаление черновика",
  "Удаление выбранных черновиков",
  "Среди выбранных нет готовых черновиков",
  "Среди выбранных нет черновиков, которые можно безопасно удалить",
  "Удалить черновик",
  "Остановить",
  "draft-recipient",
  "draft-message",
  "draft-status",
  "Нельзя удалять черновики, которые уже ушли в отправку",
  "switchView(\"outreachDrafts\")",
  "нужно исправить",
]) {
  if (!app.includes(expected)) {
    throw new Error(`outreach import frontend should include ${expected}`);
  }
}

for (const expected of [
  ".drawer-dialog",
  ".drawer-card",
  ".drawer-section",
  ".field-help",
  ".row-actions",
  ".danger-button",
  ".add-followup-card",
  ".draft-toolbar",
  ".draft-recipient",
  ".draft-message",
  ".draft-status",
  "#outreachDraftsTable",
  "#outreachDraftsTable .pill",
  ".row-actions .small-button",
]) {
  if (!styles.includes(expected)) {
    throw new Error(`outreach drafts drawer styles should include ${expected}`);
  }
}

for (const forbidden of [
  "outreachColumnMapping",
  "data-outreach-map-field",
  "function currentOutreachMapping()",
  "function updateOutreachMappingInput()",
  "mapping-field-required",
  "Как это читать",
  "previewOutreachImportBtn",
  "Показать предпросмотр",
  "<details class=\"inline-edit\">",
  "<summary>Редактировать</summary>",
  "row.followup_1_delay_days || 3",
  "row.followup_2_delay_days || 4",
  "row.followup_3_delay_days || 5",
  "[2, 3, 4].map((position) => outreachDraftStepForm(draft, position))",
  "value=\"${esc(step.subject || draft.subject || \"\")}\"",
]) {
  if (index.includes(forbidden) || app.includes(forbidden)) {
    throw new Error(`outreach import UI should not expose manual mapping: ${forbidden}`);
  }
}

for (const expected of [
  "subject_override || item.subject_template",
  "body_text_override || item.body_template_text",
  "outreach_draft_id, outreach_step_id",
  "UPDATE outreach_draft_steps",
  "UPDATE outreach_drafts SET status = 'active_sequence'",
  "approve_or_pause_followup",
  "AND status <> 'blocked'",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should support outreach draft sequences: ${expected}`);
  }
}

if (!worker.includes("holdOutreachForScope") || !stopService.includes("requires_approval = true")) {
  throw new Error("worker should hold outreach follow-up through the shared stop-scope service");
}

console.log("OK: outreach import drafts static test passed");
