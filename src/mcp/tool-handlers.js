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

function arrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function exactSelection(items, ids, kind) {
  const wanted = new Set(ids);
  const selected = items.filter((item) => wanted.has(item.id));
  if (selected.length !== wanted.size) {
    throw new OutreachApiError(`Some ${kind} items were not found`, { code: `${kind}_not_found` });
  }
  return selected.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function launchPreflightSnapshot(preflight, dryRun) {
  return {
    dryRun: Boolean(dryRun),
    ok: Boolean(preflight?.ok),
    errors: preflight?.errors || [],
    items: preflight?.items || [],
    stats: preflight?.stats || {},
  };
}

function ensurePreflight(preflight) {
  if (!preflight?.ok) {
    throw new OutreachApiError("Preflight failed; launch plan was not created", {
      code: "preflight_failed",
      details: { errors: preflight?.errors || [], warnings: preflight?.warnings || [] },
    });
  }
}

function prepareConfirmation(confirmations, operation, payload, snapshot, summary, nextActions) {
  return success(summary, confirmations.prepare({ operation, payload, snapshot, summary }), nextActions);
}

function findAttachment(collections, attachmentId) {
  for (const collection of collections) {
    for (const parent of arrayItems(collection)) {
      for (const step of parent.steps || []) {
        const attachment = (step.attachments || []).find((item) => item.id === attachmentId);
        if (attachment) return { ...attachment, parent_id: parent.id, step_id: step.id };
      }
    }
  }
  return null;
}

export function createToolHandlers({ client, confirmations }) {
  async function draftLaunchState(payload) {
    const [preflight, health] = await Promise.all([
      client.post("/api/outreach/drafts/preflight", { draft_ids: payload.draft_ids }),
      client.get("/api/health"),
    ]);
    return { preflight, snapshot: launchPreflightSnapshot(preflight, health?.dryRun) };
  }

  async function campaignLaunchState(payload) {
    const [preflight, campaigns, health] = await Promise.all([
      client.get(`/api/campaigns/${payload.campaign_id}/preflight`),
      client.get("/api/campaigns"),
      client.get("/api/health"),
    ]);
    const campaign = arrayItems(campaigns).find((item) => item.id === payload.campaign_id);
    if (!campaign) throw new OutreachApiError("Campaign was not found", { code: "campaign_not_found" });
    return {
      preflight,
      snapshot: { ...launchPreflightSnapshot(preflight, health?.dryRun), campaign },
    };
  }

  async function queueSelection(queueIds) {
    const result = await client.get("/api/sending", { query: { filter: "waiting", page: 1, pageSize: 100 } });
    return exactSelection(arrayItems(result), queueIds, "queue");
  }

  async function conversationState(conversationId) {
    return client.get(`/api/outreach/conversations/${conversationId}`);
  }

  async function attachmentState(attachmentId) {
    const [campaigns, drafts] = await Promise.all([
      client.get("/api/campaigns"),
      client.get("/api/outreach/drafts"),
    ]);
    const attachment = findAttachment([campaigns, drafts], attachmentId);
    if (!attachment) throw new OutreachApiError("Attachment was not found", { code: "attachment_not_found" });
    return attachment;
  }

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
    launch_prepare: safeTool(async (input) => {
      const payload = {
        source: input.source,
        mode: input.mode || "manual",
        ...(input.source === "drafts"
          ? { draft_ids: required(input.draft_ids, "draft_ids"), ...(input.daily_first_limit ? { daily_first_limit: input.daily_first_limit } : {}) }
          : { campaign_id: required(input.campaign_id, "campaign_id") }),
      };
      const state = input.source === "drafts" ? await draftLaunchState(payload) : await campaignLaunchState(payload);
      ensurePreflight(state.preflight);
      const count = state.preflight?.stats?.selected ?? state.preflight?.stats?.enrollments ?? state.preflight?.items?.length ?? 0;
      const delivery = state.snapshot.dryRun ? "dry-run" : "реальная отправка";
      return prepareConfirmation(
        confirmations,
        "launch",
        payload,
        state.snapshot,
        `Подготовлен запуск ${count} получателей, режим ${payload.mode}, ${delivery}. Требуется явное разрешение.`,
        ["launch_execute"],
      );
    }),
    launch_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const inspected = confirmations.inspect({ token, operation: "launch" });
      const state = inspected.payload.source === "drafts"
        ? await draftLaunchState(inspected.payload)
        : await campaignLaunchState(inspected.payload);
      ensurePreflight(state.preflight);
      const plan = confirmations.consume({ token, operation: "launch", currentSnapshot: state.snapshot, confirm });
      const data = plan.payload.source === "drafts"
        ? await client.post("/api/outreach/drafts/start", {
          draft_ids: plan.payload.draft_ids,
          mode: plan.payload.mode,
          ...(plan.payload.daily_first_limit ? { daily_first_limit: plan.payload.daily_first_limit } : {}),
        })
        : await client.post(`/api/campaigns/${plan.payload.campaign_id}/start`, { mode: plan.payload.mode });
      return success("Подтверждённый запуск создан.", data, ["runs_list", "queue_list"]);
    }),
    queue_approval_prepare: safeTool(async ({ queue_ids: queueIds }) => {
      const selected = await queueSelection(queueIds);
      return prepareConfirmation(confirmations, "queue_approval", { queue_ids: queueIds }, selected, `Подготовлено подтверждение ${selected.length} писем ручной очереди.`, ["queue_approval_execute"]);
    }),
    queue_approval_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const inspected = confirmations.inspect({ token, operation: "queue_approval" });
      const selected = await queueSelection(inspected.payload.queue_ids);
      const plan = confirmations.consume({ token, operation: "queue_approval", currentSnapshot: selected, confirm });
      const results = [];
      for (const queueId of plan.payload.queue_ids) results.push(await client.post(`/api/sending/${queueId}/approve`, {}));
      return success(`Подтверждено писем: ${results.length}.`, results, ["queue_list"]);
    }),
    reply_prepare: safeTool(async ({ conversation_id: conversationId, subject, body_text: bodyText, body_html: bodyHtml }) => {
      const conversation = await conversationState(conversationId);
      const payload = { conversation_id: conversationId, subject, body_text: bodyText, ...(bodyHtml ? { body_html: bodyHtml } : {}) };
      return prepareConfirmation(confirmations, "reply", payload, conversation, `Подготовлен ручной ответ для ${conversation.email || conversationId}. Требуется явное разрешение.`, ["reply_execute"]);
    }),
    reply_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const inspected = confirmations.inspect({ token, operation: "reply" });
      const conversation = await conversationState(inspected.payload.conversation_id);
      const plan = confirmations.consume({ token, operation: "reply", currentSnapshot: conversation, confirm });
      return success("Ручной ответ отправлен.", await client.post(`/api/outreach/conversations/${plan.payload.conversation_id}/reply`, {
        subject: plan.payload.subject,
        body_text: plan.payload.body_text,
        ...(plan.payload.body_html ? { body_html: plan.payload.body_html } : {}),
      }), ["conversation_get"]);
    }),
    suppression_prepare: safeTool(async ({ email, domain, reason }) => {
      if (!email && !domain) throw new OutreachApiError("email or domain is required", { code: "suppression_target_required" });
      const suppressions = await client.get("/api/suppressions");
      const payload = { email, domain, reason };
      return prepareConfirmation(confirmations, "suppression", payload, suppressions, `Подготовлено добавление ${email || domain} в stop-list.`, ["suppression_execute"]);
    }),
    suppression_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const inspected = confirmations.inspect({ token, operation: "suppression" });
      const suppressions = await client.get("/api/suppressions");
      const plan = confirmations.consume({ token, operation: "suppression", currentSnapshot: suppressions, confirm });
      return success("Stop-list обновлён.", await client.post("/api/suppressions", plan.payload), ["suppressions_list"]);
    }),
    delivery_mode_prepare: safeTool(async ({ dry_run: dryRun }) => {
      const settings = await client.get("/api/settings");
      const runtime = settings.runtime || {};
      const payload = {
        mailDryRun: dryRun,
        publicTrackingUrl: runtime.publicTrackingUrl || "",
        maxAttachmentMb: runtime.maxAttachmentMb || 50,
        outreachStopScope: runtime.outreachStopScope || "company",
        timeZone: runtime.timeZone || "Europe/Moscow",
        inboxSyncIntervalSeconds: runtime.inboxSyncIntervalSeconds || 60,
      };
      return prepareConfirmation(confirmations, "delivery_mode", payload, runtime, dryRun ? "Подготовлено включение dry-run." : "Подготовлено включение реальной отправки. Требуется явное разрешение.", ["delivery_mode_execute"]);
    }),
    delivery_mode_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const inspected = confirmations.inspect({ token, operation: "delivery_mode" });
      const settings = await client.get("/api/settings");
      const plan = confirmations.consume({ token, operation: "delivery_mode", currentSnapshot: settings.runtime || {}, confirm });
      return success(plan.payload.mailDryRun ? "Dry-run включён." : "Реальная отправка включена.", await client.put("/api/runtime-settings", plan.payload), ["outreach_status"]);
    }),
    draft_bulk_action_prepare: safeTool(async ({ action, draft_ids: draftIds }) => {
      const drafts = await client.get("/api/outreach/drafts");
      const selected = exactSelection(arrayItems(drafts), draftIds, "draft");
      return prepareConfirmation(confirmations, "draft_bulk_action", { action, draft_ids: draftIds }, selected, `Подготовлено действие ${action} для ${selected.length} черновиков.`, ["draft_bulk_action_execute"]);
    }),
    draft_bulk_action_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const inspected = confirmations.inspect({ token, operation: "draft_bulk_action" });
      const drafts = await client.get("/api/outreach/drafts");
      const selected = exactSelection(arrayItems(drafts), inspected.payload.draft_ids, "draft");
      const plan = confirmations.consume({ token, operation: "draft_bulk_action", currentSnapshot: selected, confirm });
      const body = plan.payload.action === "delete"
        ? { delete_ids: plan.payload.draft_ids, cancel_ids: [] }
        : { delete_ids: [], cancel_ids: plan.payload.draft_ids };
      return success("Массовое действие с черновиками выполнено.", await client.post("/api/outreach/drafts/bulk-delete", body), ["drafts_list"]);
    }),
    attachment_delete_prepare: safeTool(async ({ attachment_id: attachmentId }) => {
      const attachment = await attachmentState(attachmentId);
      return prepareConfirmation(confirmations, "attachment_delete", { attachment_id: attachmentId }, attachment, `Подготовлено удаление вложения ${attachment.file_name || attachmentId}.`, ["attachment_delete_execute"]);
    }),
    attachment_delete_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const inspected = confirmations.inspect({ token, operation: "attachment_delete" });
      const attachment = await attachmentState(inspected.payload.attachment_id);
      const plan = confirmations.consume({ token, operation: "attachment_delete", currentSnapshot: attachment, confirm });
      return success("Вложение удалено.", await client.delete(`/api/attachments/${plan.payload.attachment_id}`, undefined));
    }),
    run_control: safeTool(async (input) => {
      if (input.phase === "prepare") {
        const runId = required(input.run_id, "run_id");
        const action = required(input.action, "action");
        const run = await client.get(`/api/outreach/runs/${runId}`);
        return prepareConfirmation(confirmations, "run_control", { run_id: runId, action }, run, `Подготовлено действие ${action} для запуска ${runId}.`, ["run_control"]);
      }
      const token = required(input.confirmation_token, "confirmation_token");
      const inspected = confirmations.inspect({ token, operation: "run_control" });
      const run = await client.get(`/api/outreach/runs/${inspected.payload.run_id}`);
      const plan = confirmations.consume({ token, operation: "run_control", currentSnapshot: run, confirm: input.confirm });
      const suffix = { stop: "stop", stop_followups: "stop-followups", continue_followups: "continue-followups" }[plan.payload.action];
      return success("Действие запуска выполнено.", await client.post(`/api/outreach/runs/${plan.payload.run_id}/${suffix}`, {}), ["run_get"]);
    }),
    conversation_action: safeTool(async (input) => {
      if (input.phase === "prepare") {
        const conversationId = required(input.conversation_id, "conversation_id");
        const conversation = await conversationState(conversationId);
        return prepareConfirmation(confirmations, "conversation_action", { conversation_id: conversationId, action: input.action, values: input.values || {} }, conversation, `Подготовлено действие ${input.action} для диалога ${conversationId}.`, ["conversation_action"]);
      }
      const token = required(input.confirmation_token, "confirmation_token");
      const inspected = confirmations.inspect({ token, operation: "conversation_action" });
      const conversation = await conversationState(inspected.payload.conversation_id);
      const plan = confirmations.consume({ token, operation: "conversation_action", currentSnapshot: conversation, confirm: input.confirm });
      const suffix = { stop: "stop", continue: "continue", delay: "delay", close: "close", assign_thread: "assign-thread", suppress: "suppress" }[plan.payload.action];
      return success("Действие диалога выполнено.", await client.post(`/api/outreach/conversations/${plan.payload.conversation_id}/${suffix}`, plan.payload.values || {}), ["conversation_get"]);
    }),
  };
  return handlers;
}
