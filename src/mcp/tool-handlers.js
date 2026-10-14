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

function pathId(value, field) {
  return encodeURIComponent(String(required(value, field)));
}

function pick(source, keys) {
  return Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));
}

function success(summary, data, nextActions = []) {
  return toolSuccess(summary, data, nextActions);
}

function arrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function evidenceExcerpt(value) {
  return String(value || "").slice(0, 500);
}

function safePersonalizationDetail(detail) {
  return {
    ...detail,
    items: arrayItems(detail).map((item) => ({
      ...item,
      fact_evidence: evidenceExcerpt(item.fact_evidence),
      source_pages: Array.isArray(item.source_pages)
        ? item.source_pages.map((page) => ({
          url: String(page?.url || ""),
          ...(page?.evidenceExcerpt ? { evidenceExcerpt: evidenceExcerpt(page.evidenceExcerpt) } : {}),
        }))
        : [],
    })),
  };
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
    warnings: preflight?.warnings || [],
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

function prepareConfirmation(confirmations, operation, payload, snapshot, summary, nextActions, preview) {
  return success(summary, confirmations.prepare({
    operation,
    payload,
    snapshot,
    summary,
    preview: preview ?? { request: payload, current_state: snapshot },
  }), nextActions);
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
  async function personalizationPreview(limit) {
    return client.post("/api/personalization/pilots/preview", { limit });
  }

  function personalizationSnapshot(preview) {
    return {
      limit: Number(preview?.limit || 0),
      rulesVersion: String(preview?.rulesVersion || ""),
      leadIds: (preview?.leads || []).map((lead) => String(lead.id)),
      selectionToken: String(preview?.selectionToken || ""),
    };
  }

  async function draftLaunchState(payload) {
    const [preflight, health, ...drafts] = await Promise.all([
      client.post("/api/outreach/drafts/preflight", { draft_ids: payload.draft_ids }),
      client.get("/api/health"),
      ...payload.draft_ids.map((draftId) => client.get(`/api/outreach/drafts/${pathId(draftId, "draft_id")}/review`)),
    ]);
    return { preflight, snapshot: { ...launchPreflightSnapshot(preflight, health?.dryRun), drafts } };
  }

  async function campaignLaunchState(payload) {
    const campaignId = pathId(payload.campaign_id, "campaign_id");
    const [preflight, review, health] = await Promise.all([
      client.get(`/api/campaigns/${campaignId}/preflight`),
      client.get(`/api/campaigns/${campaignId}/review`),
      client.get("/api/health"),
    ]);
    return {
      preflight,
      snapshot: { ...launchPreflightSnapshot(preflight, health?.dryRun), ...review },
    };
  }

  async function queueSelection(queueIds) {
    const rows = await Promise.all(queueIds.map((queueId) => client.get(`/api/sending/${pathId(queueId, "queue_id")}/review`)));
    return exactSelection(rows, queueIds, "queue");
  }

  function requireQueueState(items, predicate, code, message) {
    if (items.some((item) => !predicate(item))) throw new OutreachApiError(message, { code });
    return items;
  }

  async function conversationState(conversationId) {
    return client.get(`/api/outreach/conversations/${pathId(conversationId, "conversation_id")}`);
  }

  async function campaignReview(campaignId) {
    return client.get(`/api/campaigns/${pathId(campaignId, "campaign_id")}/review`);
  }

  async function campaignEnrollmentState(payload) {
    const review = await campaignReview(payload.campaign_id);
    if (payload.action !== "enroll") return review;
    const leads = await Promise.all((payload.lead_ids || []).map((leadId) => client.get(`/api/leads/${pathId(leadId, "lead_id")}/detail`)));
    return { ...review, requested_leads: leads };
  }

  async function runControlState(runId, leadIds = []) {
    const [run, ...leads] = await Promise.all([
      client.get(`/api/outreach/runs/${pathId(runId, "run_id")}`),
      ...leadIds.map((leadId) => client.get(`/api/leads/${pathId(leadId, "lead_id")}/detail`)),
    ]);
    return { run, leads };
  }

  function claim(token, operation, confirm) {
    return confirmations.claim({ token, operation, confirm });
  }

  function verify(plan, snapshot) {
    return confirmations.verify({ plan, currentSnapshot: snapshot });
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
    personalization_pilots_list: safeTool(async (input) => {
      const data = await client.get("/api/personalization/pilots", { query: pageQuery(input) });
      const pilots = Array.isArray(data) ? data : data?.pilots || [];
      const summary = pilots.reduce((totals, pilot) => ({
        pilots: totals.pilots + 1,
        candidates: totals.candidates + Number(pilot.total || 0),
        ready: totals.ready + Number(pilot.ready || 0),
        review: totals.review + Number(pilot.needs_review || 0),
        failed: totals.failed + Number(pilot.failed || 0),
      }), { pilots: 0, candidates: 0, ready: 0, review: 0, failed: 0 });
      return success("Пилоты персонализации получены.", { pilots, summary }, ["personalization_pilot_get", "personalization_pilot_prepare"]);
    }),
    personalization_pilot_get: safeTool(async ({ pilot_id: pilotId }) => success(
      "Пилот персонализации получен.",
      safePersonalizationDetail(await client.get(`/api/personalization/pilots/${pathId(pilotId, "pilot_id")}`)),
      ["draft_update"],
    )),
    personalization_pilot_prepare: safeTool(async ({ limit = 30 }) => {
      const preview = await personalizationPreview(limit);
      const snapshot = personalizationSnapshot(preview);
      if (!snapshot.leadIds.length) {
        throw new OutreachApiError("No eligible leads were found for personalization", { code: "personalization_no_eligible_leads" });
      }
      return prepareConfirmation(
        confirmations,
        "personalization_pilot",
        snapshot,
        snapshot,
        `Подготовлен пилот персонализации для ${snapshot.leadIds.length} лидов. Будут созданы только черновики; отправка не запускается. Требуется явное разрешение.`,
        ["personalization_pilot_execute"],
        { ...preview, leads: preview.leads.map((lead) => pick(lead, ["id", "company", "email", "website", "segment", "city", "validation_status"])) },
      );
    }),
    personalization_pilot_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "personalization_pilot", confirm);
      const preview = await personalizationPreview(plan.payload.limit);
      verify(plan, personalizationSnapshot(preview));
      const data = await client.post("/api/personalization/pilots", {
        limit: plan.payload.limit,
        rulesVersion: plan.payload.rulesVersion,
        leadIds: plan.payload.leadIds,
        selectionToken: plan.payload.selectionToken,
      });
      return success("Подтверждённый пилот персонализации создан; письма не отправлялись.", data, ["personalization_pilot_get"]);
    }),
    events_list: safeTool(async (input) => success("Журнал событий получен.", await client.get("/api/events", { query: pageQuery(input) }))),
    leads_list: safeTool(async (input) => success("Список лидов получен.", await client.get("/api/leads", { query: filteredQuery(input, ["status", "segment", "search"]) }), ["lead_upsert", "leads_import"])),
    lead_upsert: safeTool(async ({ lead_id: leadId, lead }) => success(
      leadId ? "Лид обновлён." : "Лид создан.",
      leadId ? await client.patch(`/api/leads/${pathId(leadId, "lead_id")}`, lead) : await client.post("/api/leads", lead),
      ["leads_list"],
    )),
    leads_import: safeTool(async ({ kind = "outreach", file_path: filePath, mapping }) => success(
      kind === "outreach" ? "Файл импортирован в персональные черновики." : "Файл импортирован в базу лидов.",
      await client.upload(kind === "outreach" ? "/api/outreach/imports" : "/api/leads/import", {
        filePath,
        fields: mapping ? { mapping: JSON.stringify(mapping) } : {},
        allowedExtensions: kind === "outreach" ? [".csv", ".xlsx"] : [".csv"],
        maxBytes: MAX_UPLOAD_BYTES,
      }),
      kind === "outreach" ? ["drafts_list", "drafts_preflight"] : ["leads_list"],
    )),
    drafts_list: safeTool(async (input) => success("Черновики получены.", await client.get("/api/outreach/drafts", { query: filteredQuery(input, ["status", "import_id"]) }), ["drafts_preflight"])),
    draft_update: safeTool(async ({ action, draft_id: draftId, position, values }) => {
      if (action === "step") required(position, "position");
      const encodedDraftId = pathId(draftId, "draft_id");
      const current = await client.get(`/api/outreach/drafts/${encodedDraftId}/review`);
      const draftKeys = ["to_email", "company", "contact_name", "segment", "subject", "body_text", "body_html", "mailbox_id", "send_after"];
      const stepKeys = ["subject", "body_text", "body_html", "delay_days"];
      const existing = action === "step" ? (current.steps || []).find((step) => Number(step.position) === Number(position)) : current;
      if (!existing) throw new OutreachApiError("Draft step was not found", { code: "draft_step_not_found" });
      const merged = pick({ ...existing, ...values }, action === "step" ? stepKeys : draftKeys);
      const data = action === "step"
        ? await client.put(`/api/outreach/drafts/${encodedDraftId}/steps/${position}`, merged)
        : await client.patch(`/api/outreach/drafts/${encodedDraftId}`, merged);
      return success(action === "step" ? "Follow-up шаг обновлён." : "Черновик обновлён.", data, ["drafts_preflight"]);
    }),
    drafts_preflight: safeTool(async ({ draft_ids: draftIds }) => success("Preflight черновиков выполнен.", await client.post("/api/outreach/drafts/preflight", { draft_ids: draftIds }), ["launch_prepare"])),
    attachment_upload: safeTool(async ({ target, target_id: targetId, file_path: filePath }) => success(
      "Вложение загружено.",
      await client.upload(target === "outreach_step" ? `/api/outreach/draft-steps/${pathId(targetId, "target_id")}/attachments` : `/api/steps/${pathId(targetId, "target_id")}/attachments`, {
        filePath,
        allowedExtensions: [],
        maxBytes: 200 * 1024 * 1024,
      }),
    )),
    campaigns_list: safeTool(async () => success("Кампании получены.", await client.get("/api/campaigns"), ["campaign_manage", "launch_prepare"])),
    campaign_manage: safeTool(async (input) => {
      const { action, campaign_id: campaignId, step_id: stepId, values } = input;
      const review = action === "update" || action === "update_step" ? await campaignReview(campaignId) : null;
      const campaignKeys = ["name", "description", "segment", "tracking_enabled", "manual_approval_required"];
      const stepKeys = ["name", "delay_days", "subject_template", "body_template_text", "body_template_html"];
      const operations = {
        create: () => client.post("/api/campaigns", values),
        update: () => client.patch(`/api/campaigns/${pathId(campaignId, "campaign_id")}`, pick({ ...review.campaign, ...values }, campaignKeys)),
        add_step: () => client.post(`/api/campaigns/${pathId(campaignId, "campaign_id")}/steps`, values),
        update_step: () => {
          const current = (review.campaign?.steps || []).find((step) => step.id === stepId);
          if (!current) throw new OutreachApiError("Campaign step was not found", { code: "campaign_step_not_found" });
          return client.patch(`/api/steps/${pathId(stepId, "step_id")}`, pick({ ...current, ...values }, stepKeys));
        },
      };
      const operation = operations[action];
      if (!operation) throw new OutreachApiError("Unknown campaign action", { code: "invalid_campaign_action" });
      return success("Операция кампании выполнена.", await operation(), ["campaigns_list"]);
    }),
    campaign_enrollment_prepare: safeTool(async (input) => {
      const payload = {
        action: input.action,
        campaign_id: input.campaign_id,
        ...(input.lead_ids ? { lead_ids: input.lead_ids } : {}),
        ...(input.mailbox_ids ? { mailbox_ids: input.mailbox_ids } : {}),
        ...(input.enrollment_ids ? { enrollment_ids: input.enrollment_ids } : {}),
      };
      if (input.action === "enroll" && (!input.lead_ids?.length || !input.mailbox_ids?.length)) {
        throw new OutreachApiError("lead_ids and mailbox_ids are required", { code: "enrollment_targets_required" });
      }
      if (input.action !== "enroll" && !input.enrollment_ids?.length) {
        throw new OutreachApiError("enrollment_ids are required", { code: "enrollment_ids_required" });
      }
      const review = await campaignEnrollmentState(payload);
      if (["keep_selected", "pause", "resume"].includes(input.action)) {
        const source = input.action === "resume" ? review.enrollments : review.active_enrollments;
        const selected = exactSelection((source || []).map((item) => ({ ...item, id: item.enrollment_id })), input.enrollment_ids, "enrollment");
        if (input.action === "resume" && selected.some((item) => item.enrollment_status !== "paused")) {
          throw new OutreachApiError("Only paused enrollments can be resumed", { code: "enrollment_not_paused" });
        }
      }
      return prepareConfirmation(confirmations, "campaign_enrollment", payload, review, `Подготовлено действие ${input.action} для кампании ${review.campaign?.name || input.campaign_id}.`, ["campaign_enrollment_execute"]);
    }),
    campaign_enrollment_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "campaign_enrollment", confirm);
      const review = await campaignEnrollmentState(plan.payload);
      verify(plan, review);
      const campaignId = pathId(plan.payload.campaign_id, "campaign_id");
      const results = [];
      if (plan.payload.action === "enroll") {
        results.push(await client.post(`/api/campaigns/${campaignId}/enroll`, { lead_ids: plan.payload.lead_ids, mailbox_ids: plan.payload.mailbox_ids }));
      } else if (plan.payload.action === "keep_selected") {
        results.push(await client.post(`/api/campaigns/${campaignId}/enrollments/keep-selected`, { enrollment_ids: plan.payload.enrollment_ids }));
      } else {
        const suffix = plan.payload.action === "pause" ? "pause" : "resume";
        for (const enrollmentId of plan.payload.enrollment_ids) {
          results.push(await client.post(`/api/enrollments/${pathId(enrollmentId, "enrollment_id")}/${suffix}`, {}));
        }
      }
      return success("Подтверждённое изменение участников выполнено.", results, ["campaigns_list"]);
    }),
    queue_list: safeTool(async (input) => success("Очередь получена.", await client.get("/api/sending", { query: filteredQuery(input, ["filter"]) }), ["queue_approval_prepare"])),
    runs_list: safeTool(async (input) => success("Запуски получены.", await client.get("/api/outreach/runs", { query: pageQuery(input) }), ["run_get"])),
    run_get: safeTool(async ({ run_id: runId }) => success("Запуск получен.", await client.get(`/api/outreach/runs/${pathId(runId, "run_id")}`), ["run_control"])),
    conversations_list: safeTool(async (input) => success("Диалоги получены.", await client.get("/api/outreach/conversations", { query: filteredQuery(input, ["status", "classification", "search"]) }), ["conversation_get"])),
    conversation_get: safeTool(async ({ conversation_id: conversationId }) => success("Диалог получен.", await conversationState(conversationId), ["conversation_classify", "conversation_action", "reply_prepare"])),
    conversation_classify: safeTool(async ({ conversation_id: conversationId, classification }) => {
      if (["positive_reply", "negative_reply", "unsubscribe", "not_target", "bounce"].includes(classification)) {
        throw new OutreachApiError("Stopping classifications require prepare/execute confirmation", { code: "confirmation_required_for_classification" });
      }
      return success("Классификация сохранена.", await client.patch(`/api/outreach/conversations/${pathId(conversationId, "conversation_id")}/classification`, { classification }), ["conversation_get"]);
    }),
    conversation_classify_prepare: safeTool(async ({ conversation_id: conversationId, classification }) => {
      const impact = await client.get(`/api/outreach/conversations/${pathId(conversationId, "conversation_id")}/classification-impact`, { query: { classification } });
      return prepareConfirmation(confirmations, "conversation_classify", { conversation_id: conversationId, classification }, impact, `Подготовлена классификация ${classification}; будут остановлены цепочки для ${impact.affected_count || 0} лидов.`, ["conversation_classify_execute"]);
    }),
    conversation_classify_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "conversation_classify", confirm);
      const impact = await client.get(`/api/outreach/conversations/${pathId(plan.payload.conversation_id, "conversation_id")}/classification-impact`, { query: { classification: plan.payload.classification } });
      verify(plan, impact);
      return success("Классификация сохранена.", await client.patch(`/api/outreach/conversations/${pathId(plan.payload.conversation_id, "conversation_id")}/classification`, { classification: plan.payload.classification }), ["conversation_get"]);
    }),
    suppressions_list: safeTool(async () => success("Stop-list получен.", await client.get("/api/suppressions"), ["suppression_prepare"])),
    mailboxes_list: safeTool(async () => success("Состояние mailbox получено.", await client.get("/api/mailboxes"), ["mailbox_check"])),
    mailbox_check: safeTool(async ({ mailbox_id: mailboxId }) => success("Проверка mailbox выполнена.", await client.post(`/api/mailboxes/${pathId(mailboxId, "mailbox_id")}/check`, {}), ["mailboxes_list"])),
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
      const plan = claim(token, "launch", confirm);
      const state = plan.payload.source === "drafts"
        ? await draftLaunchState(plan.payload)
        : await campaignLaunchState(plan.payload);
      verify(plan, state.snapshot);
      ensurePreflight(state.preflight);
      const data = plan.payload.source === "drafts"
        ? await client.post("/api/outreach/drafts/start", {
          draft_ids: plan.payload.draft_ids,
          mode: plan.payload.mode,
          ...(plan.payload.daily_first_limit ? { daily_first_limit: plan.payload.daily_first_limit } : {}),
        })
        : await client.post(`/api/campaigns/${pathId(plan.payload.campaign_id, "campaign_id")}/start`, { mode: plan.payload.mode });
      return success("Подтверждённый запуск создан.", data, ["runs_list", "queue_list"]);
    }),
    queue_approval_prepare: safeTool(async ({ queue_ids: queueIds }) => {
      const [selected, health] = await Promise.all([queueSelection(queueIds), client.get("/api/health")]);
      requireQueueState(selected, (item) => ["pending", "retrying", "running"].includes(item.status) && item.requires_approval === true && !item.approved_at, "queue_not_awaiting_approval", "Some queue items are not awaiting manual approval");
      const snapshot = { items: selected, dryRun: Boolean(health?.dryRun) };
      return prepareConfirmation(confirmations, "queue_approval", { queue_ids: queueIds }, snapshot, `Подготовлено подтверждение ${selected.length} писем ручной очереди.`, ["queue_approval_execute"]);
    }),
    queue_approval_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "queue_approval", confirm);
      const [selected, health] = await Promise.all([queueSelection(plan.payload.queue_ids), client.get("/api/health")]);
      requireQueueState(selected, (item) => ["pending", "retrying", "running"].includes(item.status) && item.requires_approval === true && !item.approved_at, "queue_not_awaiting_approval", "Some queue items are not awaiting manual approval");
      verify(plan, { items: selected, dryRun: Boolean(health?.dryRun) });
      const results = [];
      for (const queueId of plan.payload.queue_ids) results.push(await client.post(`/api/sending/${pathId(queueId, "queue_id")}/approve`, {}));
      return success(`Подтверждено писем: ${results.length}.`, results, ["queue_list"]);
    }),
    queue_cancel_prepare: safeTool(async ({ queue_ids: queueIds }) => {
      const selected = await queueSelection(queueIds);
      requireQueueState(selected, (item) => ["pending", "retrying", "running"].includes(item.status), "queue_not_cancellable", "Some queue items are not cancellable");
      return prepareConfirmation(confirmations, "queue_cancel", { queue_ids: queueIds }, selected, `Подготовлена отмена ${selected.length} элементов очереди и связанных цепочек.`, ["queue_cancel_execute"]);
    }),
    queue_cancel_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "queue_cancel", confirm);
      const selected = await queueSelection(plan.payload.queue_ids);
      requireQueueState(selected, (item) => ["pending", "retrying", "running"].includes(item.status), "queue_not_cancellable", "Some queue items are not cancellable");
      verify(plan, selected);
      const results = [];
      for (const queueId of plan.payload.queue_ids) results.push(await client.post(`/api/sending/${pathId(queueId, "queue_id")}/cancel`, {}));
      return success(`Отменено элементов очереди: ${results.length}.`, results, ["queue_list"]);
    }),
    reply_prepare: safeTool(async ({ conversation_id: conversationId, mailbox_id: mailboxId, subject, body_text: bodyText }) => {
      const [conversation, health, mailboxes] = await Promise.all([conversationState(conversationId), client.get("/api/health"), client.get("/api/mailboxes")]);
      const mailbox = exactSelection(arrayItems(mailboxes), [mailboxId], "mailbox")[0];
      const payload = { conversation_id: conversationId, mailbox_id: mailboxId, subject, body_text: bodyText };
      const snapshot = { conversation, mailbox, dryRun: Boolean(health?.dryRun) };
      const recipient = conversation?.conversation?.email || conversation?.email || conversationId;
      return prepareConfirmation(confirmations, "reply", payload, snapshot, `Подготовлен ручной ответ для ${recipient}. Требуется явное разрешение.`, ["reply_execute"]);
    }),
    reply_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "reply", confirm);
      const [conversation, health, mailboxes] = await Promise.all([conversationState(plan.payload.conversation_id), client.get("/api/health"), client.get("/api/mailboxes")]);
      const mailbox = exactSelection(arrayItems(mailboxes), [plan.payload.mailbox_id], "mailbox")[0];
      verify(plan, { conversation, mailbox, dryRun: Boolean(health?.dryRun) });
      return success("Ручной ответ отправлен.", await client.post(`/api/outreach/conversations/${pathId(plan.payload.conversation_id, "conversation_id")}/reply`, {
        mailbox_id: plan.payload.mailbox_id,
        subject: plan.payload.subject,
        body_text: plan.payload.body_text,
      }), ["conversation_get"]);
    }),
    suppression_prepare: safeTool(async ({ scope, target, reason }) => {
      const normalizedTarget = target.trim().toLowerCase();
      const impact = await client.get("/api/suppressions/impact", { query: { scope, target: normalizedTarget } });
      const payload = { scope, target: normalizedTarget, reason };
      return prepareConfirmation(confirmations, "suppression", payload, impact, `Подготовлено добавление ${scope === "email" ? "адреса" : "домена"} ${normalizedTarget} в stop-list; затронуто лидов: ${impact.affected_count || 0}.`, ["suppression_execute"]);
    }),
    suppression_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "suppression", confirm);
      const impact = await client.get("/api/suppressions/impact", { query: { scope: plan.payload.scope, target: plan.payload.target } });
      verify(plan, impact);
      const body = plan.payload.scope === "email"
        ? { email: plan.payload.target, reason: plan.payload.reason }
        : { domain: plan.payload.target, reason: plan.payload.reason };
      return success("Stop-list обновлён.", await client.post("/api/suppressions", body), ["suppressions_list"]);
    }),
    delivery_mode_prepare: safeTool(async ({ dry_run: dryRun }) => {
      const settings = await client.get("/api/settings");
      const runtime = settings.runtime || {};
      const payload = {
        mailDryRun: dryRun,
        publicTrackingUrl: runtime.publicTrackingUrl || "",
        maxAttachmentMb: runtime.maxAttachmentMb || 50,
        outreachStopScope: runtime.outreachStopScope || "company",
        outreachDailyLimit: runtime.outreachDailyLimit || 100,
        timeZone: runtime.timeZone || "Europe/Moscow",
        inboxSyncIntervalSeconds: runtime.inboxSyncIntervalSeconds || 60,
      };
      return prepareConfirmation(confirmations, "delivery_mode", payload, runtime, dryRun ? "Подготовлено включение dry-run." : "Подготовлено включение реальной отправки. Требуется явное разрешение.", ["delivery_mode_execute"]);
    }),
    delivery_mode_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "delivery_mode", confirm);
      const settings = await client.get("/api/settings");
      verify(plan, settings.runtime || {});
      return success(plan.payload.mailDryRun ? "Dry-run включён." : "Реальная отправка включена.", await client.put("/api/runtime-settings", plan.payload), ["outreach_status"]);
    }),
    draft_bulk_action_prepare: safeTool(async ({ action, draft_ids: draftIds }) => {
      const drafts = await Promise.all(draftIds.map((draftId) => client.get(`/api/outreach/drafts/${pathId(draftId, "draft_id")}/review`)));
      const selected = exactSelection(drafts, draftIds, "draft");
      return prepareConfirmation(confirmations, "draft_bulk_action", { action, draft_ids: draftIds }, selected, `Подготовлено действие ${action} для ${selected.length} черновиков.`, ["draft_bulk_action_execute"]);
    }),
    draft_bulk_action_execute: safeTool(async ({ confirmation_token: token, confirm }) => {
      const plan = claim(token, "draft_bulk_action", confirm);
      const drafts = await Promise.all(plan.payload.draft_ids.map((draftId) => client.get(`/api/outreach/drafts/${pathId(draftId, "draft_id")}/review`)));
      const selected = exactSelection(drafts, plan.payload.draft_ids, "draft");
      verify(plan, selected);
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
      const plan = claim(token, "attachment_delete", confirm);
      const attachment = await attachmentState(plan.payload.attachment_id);
      verify(plan, attachment);
      return success("Вложение удалено.", await client.delete(`/api/attachments/${pathId(plan.payload.attachment_id, "attachment_id")}`, undefined));
    }),
    run_control: safeTool(async (input) => {
      if (input.phase === "prepare") {
        const action = required(input.action, "action");
        if (action === "stop_all") {
          const impact = await client.get("/api/outreach/stop-all/impact");
          return prepareConfirmation(confirmations, "run_control", { action }, impact, `Подготовлена остановка всей рассылки: ${impact.active_queue || 0} писем в очереди, включая ${impact.followups || 0} follow-up.`, ["run_control"]);
        }
        const runId = required(input.run_id, "run_id");
        if (action !== "stop" && !input.lead_ids?.length) throw new OutreachApiError("lead_ids are required for follow-up control", { code: "lead_ids_required" });
        const state = await runControlState(runId, input.lead_ids || []);
        return prepareConfirmation(confirmations, "run_control", { run_id: runId, action, ...(input.lead_ids ? { lead_ids: input.lead_ids } : {}) }, state, `Подготовлено действие ${action} для запуска ${runId}.`, ["run_control"]);
      }
      const token = required(input.confirmation_token, "confirmation_token");
      const plan = claim(token, "run_control", input.confirm);
      if (plan.payload.action === "stop_all") {
        const impact = await client.get("/api/outreach/stop-all/impact");
        verify(plan, impact);
        return success("Вся рассылка остановлена.", await client.post("/api/outreach/stop-all", { snapshot_token: impact.snapshot_token }), ["runs_list", "queue_list"]);
      }
      const state = await runControlState(plan.payload.run_id, plan.payload.lead_ids || []);
      verify(plan, state);
      const suffix = { stop: "stop", stop_followups: "stop-followups", continue_followups: "continue-followups" }[plan.payload.action];
      const body = plan.payload.action === "stop" ? {} : { lead_ids: plan.payload.lead_ids };
      return success("Действие запуска выполнено.", await client.post(`/api/outreach/runs/${pathId(plan.payload.run_id, "run_id")}/${suffix}`, body), ["run_get"]);
    }),
    conversation_action: safeTool(async (input) => {
      if (input.phase === "prepare") {
        const conversationId = required(input.conversation_id, "conversation_id");
        const conversation = await conversationState(conversationId);
        let snapshot = conversation;
        if (input.action === "suppress") {
          const scope = input.values?.scope === "domain" ? "domain" : "email";
          const email = String(conversation?.conversation?.email || conversation?.email || "").toLowerCase();
          const target = scope === "domain" ? email.split("@")[1] : email;
          const impact = await client.get("/api/suppressions/impact", { query: { scope, target } });
          snapshot = { conversation, suppression_impact: impact };
        }
        return prepareConfirmation(confirmations, "conversation_action", { conversation_id: conversationId, action: input.action, values: input.values || {} }, snapshot, `Подготовлено действие ${input.action} для диалога ${conversationId}.`, ["conversation_action"]);
      }
      const token = required(input.confirmation_token, "confirmation_token");
      const plan = claim(token, "conversation_action", input.confirm);
      const conversation = await conversationState(plan.payload.conversation_id);
      let snapshot = conversation;
      if (plan.payload.action === "suppress") {
        const scope = plan.payload.values?.scope === "domain" ? "domain" : "email";
        const email = String(conversation?.conversation?.email || conversation?.email || "").toLowerCase();
        const target = scope === "domain" ? email.split("@")[1] : email;
        const impact = await client.get("/api/suppressions/impact", { query: { scope, target } });
        snapshot = { conversation, suppression_impact: impact };
      }
      verify(plan, snapshot);
      const suffix = { stop: "stop", continue: "continue", delay: "delay", close: "close", assign_thread: "assign-thread", suppress: "suppress" }[plan.payload.action];
      return success("Действие диалога выполнено.", await client.post(`/api/outreach/conversations/${pathId(plan.payload.conversation_id, "conversation_id")}/${suffix}`, plan.payload.values || {}), ["conversation_get"]);
    }),
  };
  return handlers;
}
