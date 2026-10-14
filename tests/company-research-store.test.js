import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migrationUrl = new URL("../db/migrations/016_company_research.sql", import.meta.url);

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
  assert.match(sql, /UNIQUE\s*\(research_run_id, audience_key\)/i);
  assert.doesNotMatch(sql, /REFERENCES\s+(?:sending_queue|messages|enrollments)/i);
});

test("queue insertion is idempotent and claim uses a skip-locked lease", async () => {
  const { createResearchRuns, claimResearchRun } = await import("../src/services/company-research.js");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO company_research_runs/i.test(sql)) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (/UPDATE company_research_runs AS run/i.test(sql)) return { rows: [{ id: "run-1", status: "researching", claimed_by: "agent-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const queued = await createResearchRuns(client, {
    rulesVersion: "research-v1",
    leads: [{ id: "lead-1", company: "Альфа", email: "info@alpha.ru", website: "https://alpha.ru", segment: "малый бизнес" }],
  });
  assert.equal(queued.created, 1);
  const insert = calls.find((entry) => /INSERT INTO company_research_runs/i.test(entry.sql));
  assert.match(insert.sql, /ON CONFLICT \(company_key, rules_version\) DO NOTHING/i);
  assert.equal(calls[0].sql, "BEGIN");
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
