import fs from "node:fs";
import { rowsToOutreachRows } from "../src/services/csv.js";

const index = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const styles = fs.readFileSync("public/styles.css", "utf8");
const server = fs.readFileSync("src/server.js", "utf8");
const csv = fs.readFileSync("src/services/csv.js", "utf8");
const migration = fs.readFileSync("db/migrations/003_outreach_imports.sql", "utf8");
const sequenceMigration = fs.readFileSync("db/migrations/004_outreach_draft_sequences.sql", "utf8");
const htmlMigration = fs.readFileSync("db/migrations/011_outreach_draft_html.sql", "utf8");
const attachmentMigration = fs.readFileSync("db/migrations/012_outreach_step_attachments.sql", "utf8");
const contentIdMigration = fs.readFileSync("db/migrations/013_attachment_content_ids.sql", "utf8");
const worker = fs.readFileSync("src/worker/index.js", "utf8");
const mail = fs.readFileSync("src/services/mail.js", "utf8");
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

for (const expected of [
  "ALTER TABLE outreach_drafts",
  "ADD COLUMN IF NOT EXISTS body_html text",
  "ALTER TABLE outreach_draft_steps",
]) {
  if (!htmlMigration.includes(expected)) {
    throw new Error(`outreach HTML migration should include ${expected}`);
  }
}

for (const expected of [
  "ALTER TABLE attachments",
  "outreach_step_id uuid REFERENCES outreach_draft_steps",
  "attachments_outreach_step_idx",
]) {
  if (!attachmentMigration.includes(expected)) {
    throw new Error(`outreach attachment migration should include ${expected}`);
  }
}

for (const expected of [
  "ADD COLUMN IF NOT EXISTS content_id text",
  "attachments_content_id_unique",
]) {
  if (!contentIdMigration.includes(expected)) {
    throw new Error(`attachment content-id migration should include ${expected}`);
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
  "importFileReadError",
  "nonEmptySheetRow",
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
  "mailbox_sent.last_sent_at",
  "m.last_inbox_sync_at",
  "draft.smtp_verified_at || draft.last_sent_at",
  "draft.imap_verified_at || draft.last_inbox_sync_at",
  "imapUncheckedMailboxes",
  "imapUncheckedMailboxIds",
  "imapSyncQueued",
  "INSERT INTO job_queue(job_type, payload, run_at)",
  "j.payload->>'mailboxId' = mailbox_id::text",
  "проверенным SMTP или успешной историей отправки",
  "const requestedDate = draft.send_after ? new Date(draft.send_after) : null",
  "const scheduledAt = requestedDate && requestedDate > batchDate ? requestedDate : batchDate",
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

const draftsListRoute = server.slice(
  server.indexOf("app.get(\"/api/outreach/drafts\""),
  server.indexOf("app.post(\"/api/outreach/imports/preview\""),
);
if (draftsListRoute.includes("LIMIT 500")) {
  throw new Error("outreach drafts list should not hide imported rows behind LIMIT 500");
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

const parsedHtmlBodies = rowsToOutreachRows([
  [
    "Почта получателя",
    "Тема письма",
    "HTML письма",
    "Фоллоуап 1: HTML",
  ],
  [
    "client@example.com",
    "HTML тема",
    "<p><strong>Первое письмо</strong></p>",
    "<p>HTML follow-up</p>",
  ],
]);

if (
  parsedHtmlBodies[0]?.body_html !== "<p><strong>Первое письмо</strong></p>" ||
  parsedHtmlBodies[0]?.followup_1_body_html !== "<p>HTML follow-up</p>"
) {
  throw new Error("outreach parser should preserve HTML body columns");
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
  "outreachImportStatus",
  "outreachImportProgress",
  "outreachImportProgressBar",
  "outreachImportProgressReport",
  "createOutreachDraftsBtn",
  "Строки из файла",
  "Скачать шаблон",
  "/api/outreach/imports/template.csv",
  "outreachImportsTable",
  "data-outreach-draft-filter=\"ready\"",
  "Готовы к старту",
  "startSelectedDraftsBtn",
  "draftDailyFirstLimit",
  "Первых писем в день",
  "preflightSelectedDraftsBtn",
  "deleteSelectedDraftsBtn",
  "outreachDraftLaunchReview",
  "outreachDraftLaunchTable",
  "bulkHtmlAssetsForm",
  "bulkHtmlAssetsPreview",
  "html_start",
  "html_followup_1",
  "html_followup_2",
  "html_followup_3",
  "asset-upload-card",
  "data-file-label",
  "outreachDraftsTable",
  "outreachDraftDrawer",
  "outreachDraftDrawerBody",
  "closeOutreachDraftDrawer",
  "Создать черновики",
  "Черновики персональных писем",
  "Запустить выбранные",
  "Нужно исправить",
]) {
  if (!index.includes(expected)) {
    throw new Error(`outreach import UI should include ${expected}`);
  }
}

for (const expected of [
  "outreachImports: []",
  "outreachImportPreview: null",
  "outreachDrafts: []",
  "allOutreachDrafts: []",
  "outreachDraftFilter: \"ready\"",
  "async function loadOutreachImports()",
  "function renderOutreachImportPreview()",
  "Файл читается по шаблону автоматически",
  "async function loadOutreachDrafts()",
  "startOutreachDrafts",
  "preflightOutreachDrafts",
  "reviewOutreachDrafts",
  "renderOutreachDraftLaunchReview",
  "IMAP-проверка запущена автоматически",
  "function actionDetailsBody",
  "function actionItemsList",
  "action-progress",
  "role=\"progressbar\"",
  "Что исправить",
  "Письма",
  "async function startOutreachDrafts(draftIds)",
  "selectedOutreachDraftSignature",
  "canDeleteOutreachDraft",
  "canCancelOutreachDraft",
  "canSelectOutreachDraft",
  "syncSelectedOutreachDraftIdsFromDom",
  "outreachDraftSelectionStats",
  "function outreachDraftFilterLabel",
  "function visibleOutreachDrafts",
  "selectedReadyOutreachDraftIds",
  "function draftDailyFirstLimit",
  "daily_first_limit",
  "dailyFirstLimit",
  "selectedReadyWarningMessage",
  "CSV ошибок",
  "$(\"#outreachImportForm\").addEventListener",
  "Читаю файл и готовлю список строк",
  "Создаю черновики из файла",
  "автоматически открою раздел «Черновики»",
  "function setOutreachImportStatus",
  "function apiWithUploadProgress",
  "function startOutreachImportProgress",
  "function finishOutreachImportProgress",
  "осталось примерно:",
  "Время выполнения:",
  "Время чтения:",
  "После выбора список строк появится автоматически",
  "draftFilter = event.target.closest(\"[data-outreach-draft-filter]\")",
  "state.outreachDraftFilter = draftFilter.dataset.outreachDraftFilter",
  "Показано:",
  "В отправке",
  "$(\"#preflightSelectedDraftsBtn\").addEventListener",
  "$(\"#startSelectedDraftsBtn\").addEventListener",
  "$(\"#deleteSelectedDraftsBtn\").addEventListener",
  "data-outreach-draft-form",
  "data-outreach-step-form",
  "data-outreach-attachment-form",
  "data-outreach-html-chain-form",
  "data-inline-image-cid",
  "bulk-html-assets",
  "function insertInlineImage",
  "function renderBulkHtmlAssetsPreview",
  "function updateBulkHtmlAssetFileLabels",
  "HTML_CHAIN_FILE_LABELS",
  "data-edit-outreach-draft",
  "data-start-draft",
  "data-cancel-draft",
  "data-delete-draft",
  "openOutreachDraftDrawer",
  "refreshOpenOutreachDraftDrawer",
  "renderOutreachDraftFollowups",
  "renderOutreachStepAttachments",
  "renderHtmlChainUpload",
  "/api/outreach/drafts/bulk-html-assets",
  "/api/outreach/drafts/${draftId}/html-files",
  "inlineImageButton",
  "/api/outreach/draft-steps/${stepId}/attachments",
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
  "Удаление или остановка выбранных черновиков",
  "Готовых к запуску",
  "Запускать можно только черновики со статусом “готово”",
  "Среди выбранных нет черновиков, которые можно безопасно удалить или остановить",
  "Удалить черновик",
  "Остановить",
  "compact-check",
  "draft-mailbox",
  "draft-col-actions",
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
  "function attachmentContentId",
  "function uploadOriginalName",
  "function sortedUploadFiles",
  "Buffer.from(name, \"latin1\").toString(\"utf8\")",
  "htmlUpload.array(\"files\", 4)",
  "html_start_required",
  "html_followup_1",
  "function htmlUploadBody",
  "app.post(\"/api/outreach/drafts/:id/html-files\"",
  "bulkHtmlAssetsUpload.fields",
  "app.post(\"/api/outreach/drafts/bulk-html-assets\"",
  "function rewriteHtmlImageSources",
  "missing_image_sources",
  "decodeURIComponent(clean)",
  "([^\\s>]+)",
  "content_id",
  "String(file?.mimetype || \"\").startsWith(\"image/\")",
]) {
  if (!server.includes(expected)) {
    throw new Error(`outreach attachment API should include inline image support: ${expected}`);
  }
}

for (const expected of [
  "cid: inline ? contentId : undefined",
  "contentDisposition: inline ? \"inline\" : \"attachment\"",
]) {
  if (!mail.includes(expected)) {
    throw new Error(`mail sender should support cid inline images: ${expected}`);
  }
}

for (const expected of [
  ".drawer-dialog",
  ".drawer-card",
  ".drawer-section",
  ".field-help",
  ".inline-status",
  ".action-progress",
  ".action-progress-bar",
  "@keyframes actionProgress",
  ".row-actions",
  ".danger-button",
  ".add-followup-card",
  ".bulk-html-assets-preview",
  ".asset-upload-card",
  ".asset-upload-card.selected",
  ".draft-toolbar",
  ".draft-daily-limit",
  ".draft-recipient",
  ".draft-message",
  ".draft-status",
  ".draft-mailbox",
  ".compact-check",
  ".draft-col-actions",
  "#outreachDraftsTable",
  "#outreachDraftsTable .pill",
  ".row-actions .small-button",
  ".action-detail-body",
  ".action-detail-section",
  ".action-detail-stats",
]) {
  if (!styles.includes(expected)) {
    throw new Error(`outreach drafts drawer styles should include ${expected}`);
  }
}

if (app.includes("const body = typeof details === \"string\" ? details : JSON.stringify(details, null, 2);")) {
  throw new Error("action result details should be human-readable instead of raw JSON by default");
}

for (const forbidden of [
  "requireReview",
  "Нажми “Запустить выбранные” еще раз",
]) {
  if (app.includes(forbidden)) {
    throw new Error(`start should preflight and launch in one action, remove: ${forbidden}`);
  }
}

for (const forbidden of [
  "outreachColumnMapping",
  "Какие колонки нужны",
  "Скачать шаблон для Excel",
  "Обязательные колонки: email, subject, body",
  "outreachDraftStatus",
  "$(\"#outreachDraftStatus\").addEventListener",
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

const templateLinkCount = (index.match(/\/api\/outreach\/imports\/template\.csv/g) || []).length;
if (templateLinkCount !== 1) {
  throw new Error(`outreach import UI should show one template download link, got ${templateLinkCount}`);
}

for (const expected of [
  "subject_override || item.subject_template",
  "body_text_override || item.body_template_text",
  "outreach_step_id = $2",
  "outreach_draft_id, outreach_step_id",
  "UPDATE outreach_draft_steps",
  "UPDATE outreach_drafts SET status = 'active_sequence'",
  "approve_or_pause_followup",
  "AND status <> 'blocked'",
  "nextSendWindowAt",
  "sendWindowBlockReason",
  "Вне окна отправки",
]) {
  if (!worker.includes(expected)) {
    throw new Error(`worker should support outreach draft sequences: ${expected}`);
  }
}

for (const expected of [
  "optionalPositiveInteger(req.body.daily_first_limit",
  "Math.floor(queued.length / dailyFirstLimit)",
  "dailyFirstLimit",
]) {
  if (!server.includes(expected)) {
    throw new Error(`server should schedule first emails by daily limit: ${expected}`);
  }
}

if (!worker.includes("holdOutreachForScope") || !stopService.includes("requires_approval = true")) {
  throw new Error("worker should hold outreach follow-up through the shared stop-scope service");
}

console.log("OK: outreach import drafts static test passed");
