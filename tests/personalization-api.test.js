import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function candidates(count = 36) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    company: `Компания ${index + 1}`,
    email: `lead${index + 1}@example${index + 1}.ru`,
    website: `https://example${index + 1}.ru`,
    segment: index < 20 ? "clinic" : `segment-${index % 5}`,
    city: index % 2 ? "Москва" : "Санкт-Петербург",
    validation_status: index % 3 ? "valid" : "risky",
    updated_at: "2026-10-13T10:00:00.000Z",
  }));
}

test("preview selects at most 30 diverse eligible leads and performs no writes", async () => {
  const { createPersonalizationApi } = await import("../src/services/personalization-api.js");
  const statements = [];
  const rows = candidates();
  const api = createPersonalizationApi({
    query: async (sql, params) => {
      statements.push({ sql: String(sql), params });
      return { rows, rowCount: rows.length };
    },
  });
  const preview = await api.previewPilot({ limit: 30, rulesVersion: "backup-v1" });
  assert.equal(preview.leads.length, 30);
  assert.equal(new Set(preview.leads.map((lead) => lead.id)).size, 30);
  assert.ok(new Set(preview.leads.slice(0, 10).map((lead) => lead.segment)).size > 1, "selection should be interleaved by segment");
  assert.match(preview.selectionToken, /^[a-f0-9]{64}$/);
  const sql = statements[0].sql;
  assert.match(sql, /validation_status IN \('valid', 'risky'\)/);
  assert.match(sql, /NOT EXISTS[\s\S]*suppressions/i);
  assert.match(sql, /NOT EXISTS[\s\S]*outreach_conversations/i);
  assert.match(sql, /NOT EXISTS[\s\S]*outreach_drafts/i);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
});

test("pilot start rejects a stale preview and atomically requests one enrichment job per selected lead", async () => {
  const { createPersonalizationApi } = await import("../src/services/personalization-api.js");
  const rows = candidates(4);
  const created = [];
  const client = { query: async () => ({ rows: [], rowCount: 0 }) };
  const api = createPersonalizationApi({
    query: async () => ({ rows, rowCount: rows.length }),
    withClient: async (operation) => operation(client),
    createPilotFn: async (_client, input) => {
      created.push(input);
      return { id: "pilot-1", status: "running" };
    },
  });
  const preview = await api.previewPilot({ limit: 4, rulesVersion: "backup-v1" });
  const started = await api.startPilot({
    limit: 4,
    rulesVersion: "backup-v1",
    leadIds: preview.leads.map((lead) => lead.id),
    selectionToken: preview.selectionToken,
  });
  assert.equal(started.pilot.id, "pilot-1");
  assert.equal(started.queued, 4);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].leadIds, preview.leads.map((lead) => lead.id));
  assert.equal(created[0].enqueueJobType, "enrich_lead");

  rows[0].updated_at = "2026-10-13T11:00:00.000Z";
  await assert.rejects(api.startPilot({
    limit: 4,
    rulesVersion: "backup-v1",
    leadIds: preview.leads.map((lead) => lead.id),
    selectionToken: preview.selectionToken,
  }), /personalization_preview_stale/);
});

test("review overrides record the actor and draft edits set manual protection", async () => {
  const { createPersonalizationApi } = await import("../src/services/personalization-api.js");
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql: String(sql), params });
      if (/SELECT item\./.test(sql)) {
        return { rows: [{ id: "item-1", pilot_id: "pilot-1", draft_id: "draft-1", status: "review" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const api = createPersonalizationApi({ withClient: async (operation) => operation(client) });
  await api.updateItem("item-1", {
    status: "excluded",
    reason: "Не целевая компания",
    actor: "Геннадий",
    draft: {
      subject: "Новая тема",
      bodyText: "Исправленный текст",
      followupSubject: "Re: Новая тема",
      followupBodyText: "Исправленный follow-up.",
    },
  });
  assert.ok(statements.some((entry) => /manual_override_by[\s\S]*manually_overridden_at/i.test(entry.sql)));
  assert.ok(statements.some((entry) => /UPDATE outreach_drafts[\s\S]*manually_edited_at = now\(\)/i.test(entry.sql)));
  assert.ok(statements.some((entry) => /UPDATE outreach_draft_steps/i.test(entry.sql)));
  assert.ok(statements.some((entry) => /UPDATE job_queue[\s\S]*cancelled_by_manual_override/i.test(entry.sql)));
  assert.equal(statements.at(0).sql, "BEGIN");
  assert.equal(statements.at(-1).sql, "COMMIT");
});

test("manual qualification waits until website enrichment exists", async () => {
  const { createPersonalizationApi } = await import("../src/services/personalization-api.js");
  const client = {
    async query(sql) {
      if (/SELECT item\./.test(sql)) {
        return { rows: [{ id: "item-1", pilot_id: "pilot-1", draft_id: null, lead_enrichment_id: null, status: "enriching" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const api = createPersonalizationApi({ withClient: async (operation) => operation(client) });
  await assert.rejects(
    api.updateItem("item-1", { status: "qualified", reason: "Подтверждено вручную", actor: "Геннадий" }),
    /personalization_enrichment_pending/,
  );
});

test("retry queues only failed items and HTTP routes expose list, detail, preview, start, retry, and edit", async () => {
  const { createPersonalizationApi } = await import("../src/services/personalization-api.js");
  const statements = [];
  const api = createPersonalizationApi({
    query: async (sql, params = []) => {
      statements.push({ sql: String(sql), params });
      if (/UPDATE personalization_pilot_items/i.test(sql)) return { rows: [{ id: "failed-1" }, { id: "failed-2" }], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    },
  });
  assert.deepEqual(await api.retryPilot("pilot-1"), { retried: 2 });
  const enqueue = statements.find((entry) => /INSERT INTO job_queue/i.test(entry.sql));
  assert.match(enqueue.sql, /'enrich_lead'/);
  assert.match(enqueue.sql, /NOT EXISTS/);

  const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
  for (const route of [
    'app.get("/api/personalization/pilots"',
    'app.get("/api/personalization/pilots/:id"',
    'app.post("/api/personalization/pilots/preview"',
    'app.post("/api/personalization/pilots"',
    'app.post("/api/personalization/pilots/:id/retry"',
    'app.patch("/api/personalization/items/:id"',
  ]) {
    assert.ok(server.includes(route), route);
  }
});
