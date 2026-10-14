import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/016_company_research.sql", import.meta.url);
const recipientsMigrationUrl = new URL("../db/migrations/017_company_research_recipients.sql", import.meta.url);

test("company research migration defines runs, evidence, contacts, and non-sendable candidates", () => {
  const sql = fs.readFileSync(migrationUrl, "utf8");
  for (const table of [
    "company_research_runs",
    "company_research_sources",
    "company_research_facts",
    "company_contacts",
    "company_research_drafts",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /UNIQUE\s*\(company_key, rules_version\)/i);
  assert.match(sql, /UNIQUE\s*\(research_run_id, canonical_url\)/i);
  assert.match(sql, /CHECK\s*\(char_length\(excerpt\) <= 500\)/i);
  assert.match(sql, /UNIQUE\s*\(research_run_id, contact_key\)/i);
  const factsTable = sql.match(/CREATE TABLE IF NOT EXISTS company_research_facts \(([\s\S]*?)\n\);/i)?.[1] || "";
  const contactsTable = sql.match(/CREATE TABLE IF NOT EXISTS company_contacts \(([\s\S]*?)\n\);/i)?.[1] || "";
  assert.doesNotMatch(factsTable, /\bcontact_key\b/i);
  assert.match(contactsTable, /\bcontact_key text NOT NULL\b/i);
  assert.match(sql, /UNIQUE\s*\(research_run_id, audience_key\)/i);
  assert.doesNotMatch(sql, /REFERENCES\s+(?:sending_queue|messages|enrollments)/i);
});

test("company research recipients migration keeps every unsent address on its company run", () => {
  const sql = fs.existsSync(recipientsMigrationUrl) ? fs.readFileSync(recipientsMigrationUrl, "utf8") : "";
  assert.match(sql, /CREATE TABLE IF NOT EXISTS company_research_recipients/i);
  assert.match(sql, /UNIQUE\s*\(research_run_id, normalized_email\)/i);
  assert.match(sql, /ALTER TABLE company_research_drafts[\s\S]*recipient_id/i);
  assert.doesNotMatch(sql, /REFERENCES\s+(?:sending_queue|messages|enrollments)/i);
});

test("queue insertion is idempotent and claim uses a skip-locked lease", async () => {
  const { createResearchRuns, claimResearchRun } = await import("../src/services/company-research.js");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO company_research_runs/i.test(sql)) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (/INSERT INTO company_research_recipients/i.test(sql)) return { rows: [{ id: `recipient-${calls.length}` }], rowCount: 1 };
      if (/UPDATE company_research_runs AS run/i.test(sql)) return { rows: [{ id: "run-1", status: "researching", claimed_by: "agent-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const queued = await createResearchRuns(client, {
    rulesVersion: "research-v1",
    leads: [{
      id: "lead-1",
      company: "Альфа",
      email: "info@alpha.ru",
      website: "https://alpha.ru",
      segment: "малый бизнес",
      recipients: [
        { id: "lead-1", email: "info@alpha.ru" },
        { id: "lead-2", email: "cto@alpha.ru" },
      ],
    }],
  });
  assert.equal(queued.created, 1);
  const insert = calls.find((entry) => /INSERT INTO company_research_runs/i.test(entry.sql));
  assert.match(insert.sql, /ON CONFLICT \(company_key, rules_version\) DO NOTHING/i);
  assert.equal(calls[0].sql, "BEGIN");
  const recipientInserts = calls.filter((entry) => /INSERT INTO company_research_recipients/i.test(entry.sql));
  assert.equal(recipientInserts.length, 2);
  assert.deepEqual(recipientInserts.map((entry) => entry.params.slice(1, 4)), [
    ["lead-1", "info@alpha.ru", "info@alpha.ru"],
    ["lead-2", "cto@alpha.ru", "cto@alpha.ru"],
  ]);
  assert.equal(calls.findLast((entry) => entry.sql === "COMMIT")?.sql, "COMMIT");

  const claimed = await claimResearchRun(client, { workerId: "agent-1", leaseMinutes: 15 });
  assert.equal(claimed.claimed_by, "agent-1");
  const claim = calls.find((entry) => /UPDATE company_research_runs AS run/i.test(entry.sql));
  assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(claim.sql, /lease_expires_at/i);
});

test("evidence write checks lease ownership and caps source count before inserts", async () => {
  const { saveResearchBundle } = await import("../src/services/company-research.js");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT run\.id/i.test(sql)) return { rows: [{ id: "run-1", source_urls: Array.from({ length: 10 }, (_, index) => `https://source-${index}.example/`) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(saveResearchBundle(client, {
    runId: "run-1",
    workerId: "agent-1",
    sources: [{ url: "https://example.com", excerpt: "x", sourceType: "official", trustTier: 1 }],
    facts: [],
    contacts: [],
    validateUrl: async (source) => ({ ...source, url: source.url }),
  }), /research_source_limit_exceeded/);
  assert.equal(calls.some((entry) => /INSERT INTO company_research_sources/i.test(entry.sql)), false);
  const leaseCheck = calls.find((entry) => /SELECT run\.id/i.test(entry.sql));
  assert.match(leaseCheck.sql, /claimed_by = \$2/);
  assert.match(leaseCheck.sql, /lease_expires_at > now\(\)/);
  assert.match(leaseCheck.sql, /array_agg\(canonical_url/i);
  assert.doesNotMatch(leaseCheck.sql, /GROUP BY/i);
});

test("duplicate source inputs consume one slot and name-only contacts use a stable conflict key", async () => {
  const { saveResearchBundle } = await import("../src/services/company-research.js");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT run\.id/i.test(sql)) return { rows: [{ id: "run-1", source_urls: Array.from({ length: 9 }, (_, index) => `https://old-${index}.example/`) }], rowCount: 1 };
      if (/INSERT INTO company_research_sources/i.test(sql)) return { rows: [{ id: "source-1" }], rowCount: 1 };
      if (/INSERT INTO company_contacts/i.test(sql)) return { rows: [{ id: "contact-1" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await saveResearchBundle(client, {
    runId: "run-1",
    workerId: "agent-1",
    sources: [
      { sourceKey: "official", url: "https://new.example", excerpt: "x", sourceType: "official", trustTier: 1 },
      { sourceKey: "duplicate", url: "https://new.example", excerpt: "x", sourceType: "official", trustTier: 1 },
    ],
    facts: [],
    contacts: [{ sourceId: "official", name: "Иван Петров", role: "Технический директор", emailStatus: "needs_review", evidence: "Иван Петров — технический директор" }],
    validateUrl: async (source) => ({ ...source, url: "https://new.example/" }),
  });
  assert.deepEqual(result, { sources: 1, facts: 0, contacts: 1 });
  assert.equal(calls.filter((entry) => /INSERT INTO company_research_sources/i.test(entry.sql)).length, 1);
  const contactInsert = calls.find((entry) => /INSERT INTO company_contacts/i.test(entry.sql));
  assert.match(contactInsert.sql, /contact_key/i);
  assert.match(contactInsert.sql, /ON CONFLICT \(research_run_id, contact_key\)/i);
  assert.match(String(contactInsert.params[2]), /^person:/);
});

test("research completion creates one draft per stored recipient", async () => {
  const { completeResearchRun } = await import("../src/services/company-research.js");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/SELECT run\.\*, lead\.company/i.test(text)) {
        return { rows: [{ id: "run-1", company: "Альфа", general_email: "old@alpha.ru" }], rowCount: 1 };
      }
      if (/FROM company_research_recipients/i.test(text) && /SELECT id, lead_id/i.test(text)) {
        return { rows: [
          { id: "recipient-1", leadId: "lead-1", email: "info@alpha.ru" },
          { id: "recipient-2", leadId: "lead-2", email: "cto@alpha.ru" },
        ], rowCount: 2 };
      }
      if (/FROM company_research_facts/i.test(text)) return { rows: [{ id: "fact-1", text: "Факт", selected_for_copy: true }], rowCount: 1 };
      if (/FROM company_contacts/i.test(text)) return { rows: [], rowCount: 0 };
      if (/UPDATE company_research_runs/i.test(text)) return { rows: [{ id: "run-1", status: "ready" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await completeResearchRun(client, { runId: "run-1", workerId: "agent-1", status: "ready" });
  assert.equal(result.status, "ready");
  const inserts = calls.filter((entry) => /INSERT INTO company_research_drafts/i.test(entry.sql));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((entry) => entry.params.slice(1, 6)), [
    ["recipient-1", null, "general:recipient-1", "general", "info@alpha.ru"],
    ["recipient-2", null, "general:recipient-2", "general", "cto@alpha.ru"],
  ]);
});
