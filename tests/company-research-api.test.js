import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function lead(id, values = {}) {
  return {
    id,
    company: `Компания ${id}`,
    email: `${id}@example.ru`,
    website: `https://${id}.example.ru`,
    segment: "малый бизнес",
    validation_status: "valid",
    updated_at: "2026-10-14T00:00:00.000Z",
    ...values,
  };
}

test("queue preview researches every eligible company, deduplicates domains, and only prioritizes banks", async () => {
  const { createCompanyResearchApi } = await import("../src/services/company-research-api.js");
  const rows = [
    lead("a", { website: "https://alpha.ru", company: "Альфа" }),
    lead("a2", { website: "https://www.alpha.ru/contacts", company: "Альфа филиал" }),
    lead("bank", { website: "https://bank.ru", company: "Пример Банк", segment: "банк" }),
  ];
  const statements = [];
  const api = createCompanyResearchApi({
    query: async (sql) => {
      statements.push(String(sql));
      return { rows, rowCount: rows.length };
    },
  });
  const preview = await api.previewQueue();
  assert.equal(preview.companies.length, 2);
  assert.equal(preview.companies.some((item) => item.company === "Пример Банк"), true);
  assert.equal(preview.companies.find((item) => item.company === "Пример Банк").priority_tier, 4);
  assert.equal(preview.counts.by_priority[4], 1);
  assert.match(preview.selectionToken, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(statements[0], /\b(?:INSERT|UPDATE|DELETE)\b/i);
});

test("queue execution rejects a changed snapshot and creates idempotent research runs", async () => {
  const { createCompanyResearchApi } = await import("../src/services/company-research-api.js");
  const rows = [lead("a")];
  const created = [];
  const client = { query: async () => ({ rows: [], rowCount: 0 }) };
  const api = createCompanyResearchApi({
    query: async () => ({ rows, rowCount: rows.length }),
    withClient: async (operation) => operation(client),
    createResearchRunsFn: async (_client, input) => {
      created.push(input);
      return { created: 1, existing: 0, selected: 1, ids: ["run-1"] };
    },
  });
  const preview = await api.previewQueue();
  const result = await api.createQueue({
    rulesVersion: preview.rulesVersion,
    leadIds: preview.companies.map((item) => item.id),
    selectionToken: preview.selectionToken,
  });
  assert.equal(result.created, 1);
  assert.equal(created.length, 1);
  rows[0].updated_at = "2026-10-14T01:00:00.000Z";
  await assert.rejects(api.createQueue({
    rulesVersion: preview.rulesVersion,
    leadIds: preview.companies.map((item) => item.id),
    selectionToken: preview.selectionToken,
  }), /company_research_preview_stale/);
});

test("draft materialization writes drafts only and does not enqueue delivery", async () => {
  const { createCompanyResearchApi } = await import("../src/services/company-research-api.js");
  const statements = [];
  const candidate = {
    id: "11111111-1111-4111-8111-111111111111",
    research_run_id: "22222222-2222-4222-8222-222222222222",
    lead_id: "33333333-3333-4333-8333-333333333333",
    audience_key: "general",
    to_email: "info@example.ru",
    company: "Альфа",
    contact_name: "",
    segment: "малый бизнес",
    subject: "Тема",
    body_text: "Текст",
    followup_subject: "Re: Тема",
    followup_body_text: "Follow-up",
    updated_at: "2026-10-14T00:00:00.000Z",
  };
  const client = {
    async query(sql) {
      statements.push(String(sql));
      if (/SELECT draft\./i.test(sql)) return { rows: [candidate], rowCount: 1 };
      if (/INSERT INTO outreach_imports/i.test(sql)) return { rows: [{ id: "import-1" }], rowCount: 1 };
      if (/INSERT INTO outreach_drafts/i.test(sql)) return { rows: [{ id: "draft-1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const api = createCompanyResearchApi({
    query: async (sql) => {
      if (/SELECT draft\./i.test(sql)) return { rows: [candidate], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    withClient: async (operation) => operation(client),
  });
  const preview = await api.previewDrafts({ draftIds: [candidate.id] });
  const result = await api.materializeDrafts({ draftIds: [candidate.id], selectionToken: preview.selectionToken });
  assert.equal(result.materialized, 1);
  const sql = statements.join("\n");
  assert.match(sql, /INSERT INTO outreach_drafts/i);
  assert.match(sql, /INSERT INTO outreach_draft_steps/i);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE)\s+(?:sending_queue|messages|enrollments)/i);
});

test("server exposes research routes and never wires research to mail", () => {
  const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
  for (const route of [
    'app.get("/api/company-research/runs"',
    'app.get("/api/company-research/runs/:id"',
    'app.post("/api/company-research/queue/preview"',
    'app.post("/api/company-research/queue"',
    'app.post("/api/company-research/jobs/claim"',
    'app.post("/api/company-research/runs/:id/evidence"',
    'app.post("/api/company-research/runs/:id/complete"',
    'app.post("/api/company-research/runs/:id/retry"',
    'app.post("/api/company-research/drafts/preview"',
    'app.post("/api/company-research/drafts/materialize"',
  ]) assert.ok(server.includes(route), route);
  const source = fs.readFileSync(path.join(root, "src/services/company-research-api.js"), "utf8");
  assert.doesNotMatch(source, /sendMail|services\/mail\.js/);
  assert.doesNotMatch(source, /(?:INSERT|UPDATE)\s+(?:sending_queue|messages|enrollments)/i);
});

