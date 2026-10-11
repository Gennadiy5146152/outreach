import { OutreachApiError } from "./errors.js";
import { safeTool, toolSuccess } from "./result.js";

const MAX_PAGE_SIZE = 100;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function pageQuery(input = {}) {
  return {
    page: Math.max(Number(input.page) || 1, 1),
    pageSize: Math.min(Math.max(Number(input.page_size) || 50, 5), MAX_PAGE_SIZE),
  };
}

function filteredQuery(input, keys) {
  const query = pageQuery(input);
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== "") query[key] = input[key];
  }
  return query;
}

function required(value, field) {
  if (!value) throw new OutreachApiError(`${field} is required`, { code: `${field}_required` });
  return value;
}

function success(summary, data, nextActions = []) {
  return toolSuccess(summary, data, nextActions);
}

function notImplemented(name) {
  return safeTool(async () => {
    throw new OutreachApiError(`${name} will be enabled with protected confirmation workflows`, { code: "protected_workflow_unavailable" });
  });
}

export function createToolHandlers({ client, confirmations }) {
  const handlers = {
    outreach_status: safeTool(async () => {
      const [health, settings] = await Promise.all([client.get("/api/health"), client.get("/api/settings")]);
      return success("Outreach Desk доступен; состояние и режим получены.", { health, settings }, ["outreach_dashboard"]);
    }),
    outreach_dashboard: safeTool(async () => success("Метрики аутрича получены.", await client.get("/api/dashboard"))),
    events_list: safeTool(async (input) => success("Журнал событий получен.", await client.get("/api/events", { query: pageQuery(input) }))),
    leads_list: safeTool(async (input) => success("Список лидов получен.", await client.get("/api/leads", { query: filteredQuery(input, ["status", "segment", "search"]) }), ["lead_upsert", "leads_import"])),
    lead_upsert: safeTool(async ({ lead_id: leadId, lead }) => success(
      leadId ? "Лид обновлён." : "Лид создан.",
      leadId ? await client.patch(`/api/leads/${leadId}`, lead) : await client.post("/api/leads", lead),
      ["leads_list"],
    )),
    leads_import: safeTool(async ({ kind = "outreach", file_path: filePath, mapping }) => success(
      kind === "outreach" ? "Файл импортирован в персональные черновики." : "Файл импортирован в базу лидов.",
      await client.upload(kind === "outreach" ? "/api/outreach/imports" : "/api/leads/import", {
        filePath,
        fields: mapping ? { mapping: JSON.stringify(mapping) } : {},
        allowedExtensions: [".csv", ".xlsx"],
        maxBytes: MAX_UPLOAD_BYTES,
      }),
      kind === "outreach" ? ["drafts_list", "drafts_preflight"] : ["leads_list"],
    )),
    drafts_list: safeTool(async (input) => success("Черновики получены.", await client.get("/api/outreach/drafts", { query: filteredQuery(input, ["status", "import_id"]) }), ["drafts_preflight"])),
    draft_update: safeTool(async ({ action, draft_id: draftId, position, values }) => {
      if (action === "step") required(position, "position");
      const data = action === "step"
        ? await client.put(`/api/outreach/drafts/${draftId}/steps/${position}`, values)
        : await client.patch(`/api/outreach/drafts/${draftId}`, values);
      return success(action === "step" ? "Follow-up шаг обновлён." : "Черновик обновлён.", data, ["drafts_preflight"]);
    }),
    drafts_preflight: safeTool(async ({ draft_ids: draftIds }) => success("Preflight черновиков выполнен.", await client.post("/api/outreach/drafts/preflight", { draft_ids: draftIds }), ["launch_prepare"])),
    attachment_upload: safeTool(async ({ target, target_id: targetId, file_path: filePath }) => success(
      "Вложение загружено.",
      await client.upload(target === "outreach_step" ? `/api/outreach/draft-steps/${targetId}/attachments` : `/api/steps/${targetId}/attachments`, {
        filePath,
        allowedExtensions: [],
        maxBytes: 200 * 1024 * 1024,
      }),
    )),
    campaigns_list: safeTool(async () => success("Кампании получены.", await client.get("/api/campaigns"), ["campaign_manage", "launch_prepare"])),
    campaign_manage: safeTool(async (input) => {
      const { action, campaign_id: campaignId, step_id: stepId, enrollment_id: enrollmentId, values } = input;
      const operations = {
        create: () => client.post("/api/campaigns", values),
        update: () => client.patch(`/api/campaigns/${required(campaignId, "campaign_id")}`, values),
        add_step: () => client.post(`/api/campaigns/${required(campaignId, "campaign_id")}/steps`, values),
        update_step: () => client.patch(`/api/steps/${required(stepId, "step_id")}`, values),
        enroll: () => client.post(`/api/campaigns/${required(campaignId, "campaign_id")}/enroll`, values),
        keep_selected: () => client.post(`/api/campaigns/${required(campaignId, "campaign_id")}/enrollments/keep-selected`, values),
        pause_enrollment: () => client.post(`/api/enrollments/${required(enrollmentId, "enrollment_id")}/pause`, values),
        resume_enrollment: () => client.post(`/api/enrollments/${required(enrollmentId, "enrollment_id")}/resume`, values),
      };
      const operation = operations[action];
      if (!operation) throw new OutreachApiError("Unknown campaign action", { code: "invalid_campaign_action" });
      return success("Операция кампании выполнена.", await operation(), ["campaigns_list"]);
    }),
    queue_list: safeTool(async (input) => success("Очередь получена.", await client.get("/api/sending", { query: filteredQuery(input, ["filter"]) }), ["queue_approval_prepare"])),
    queue_cancel: safeTool(async ({ queue_id: queueId }) => success("Элемент очереди отменён.", await client.post(`/api/sending/${queueId}/cancel`, {}), ["queue_list"])),
    runs_list: safeTool(async (input) => success("Запуски получены.", await client.get("/api/outreach/runs", { query: pageQuery(input) }), ["run_get"])),
    run_get: safeTool(async ({ run_id: runId }) => success("Запуск получен.", await client.get(`/api/outreach/runs/${runId}`), ["run_control"])),
    conversations_list: safeTool(async (input) => success("Диалоги получены.", await client.get("/api/outreach/conversations", { query: filteredQuery(input, ["status", "classification", "search"]) }), ["conversation_get"])),
    conversation_get: safeTool(async ({ conversation_id: conversationId }) => success("Диалог получен.", await client.get(`/api/outreach/conversations/${conversationId}`), ["conversation_classify", "conversation_action", "reply_prepare"])),
    conversation_classify: safeTool(async ({ conversation_id: conversationId, classification }) => success("Классификация сохранена.", await client.patch(`/api/outreach/conversations/${conversationId}/classification`, { classification }), ["conversation_get"])),
    suppressions_list: safeTool(async () => success("Stop-list получен.", await client.get("/api/suppressions"), ["suppression_prepare"])),
    mailboxes_list: safeTool(async () => success("Состояние mailbox получено.", await client.get("/api/mailboxes"), ["mailbox_check"])),
    mailbox_check: safeTool(async ({ mailbox_id: mailboxId }) => success("Проверка mailbox выполнена.", await client.post(`/api/mailboxes/${mailboxId}/check`, {}), ["mailboxes_list"])),
    inbox_sync: safeTool(async () => success("Синхронизация входящих запрошена.", await client.post("/api/inbox/sync", {}), ["conversations_list"])),
  };

  for (const name of [
    "draft_bulk_action_prepare", "draft_bulk_action_execute", "attachment_delete_prepare", "attachment_delete_execute",
    "launch_prepare", "launch_execute", "queue_approval_prepare", "queue_approval_execute", "run_control",
    "conversation_action", "reply_prepare", "reply_execute", "suppression_prepare", "suppression_execute",
    "delivery_mode_prepare", "delivery_mode_execute",
  ]) handlers[name] = notImplemented(name);

  void confirmations;
  return handlers;
}
