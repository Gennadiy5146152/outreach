import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../db/migrations/015_lead_personalization.sql", import.meta.url);

test("personalization migration defines pilots, items, evidence, and protected draft links", async () => {
  const sql = await fs.readFile(migrationPath, "utf8");
  for (const table of ["personalization_pilots", "personalization_pilot_items", "lead_enrichments"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /UNIQUE\s*\(lead_id, rules_version\)/i);
  assert.match(sql, /UNIQUE\s*\(pilot_id, lead_id\)/i);
  assert.match(sql, /lead_enrichment_id uuid UNIQUE REFERENCES lead_enrichments/i);
  assert.match(sql, /manually_edited_at timestamptz/i);
  assert.match(sql, /manual_override_by text/i);
  for (const status of ["draft", "running", "completed", "completed_with_errors", "cancelled"]) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
  for (const status of ["pending", "enriching", "qualified", "review", "excluded", "generating", "ready", "failed"]) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
});

test("createPilot writes one import, one pilot, and conflict-safe items in a transaction", async () => {
  const { createPilot } = await import("../src/services/personalization-store.js");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (String(sql).includes("INSERT INTO outreach_imports")) return { rows: [{ id: "import-1" }], rowCount: 1 };
      if (String(sql).includes("INSERT INTO personalization_pilots")) {
        return { rows: [{ id: "pilot-1", outreach_import_id: "import-1", status: "running" }], rowCount: 1 };
      }
      if (String(sql).includes("INSERT INTO personalization_pilot_items")) return { rows: [], rowCount: 2 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const pilot = await createPilot(client, {
    limit: 2,
    rulesVersion: "backup-v1",
    leadIds: ["lead-1", "lead-2", "lead-2"],
    selectionToken: "snapshot-1",
  });

  assert.equal(pilot.id, "pilot-1");
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
  const itemInsert = calls.find((call) => call.sql.includes("INSERT INTO personalization_pilot_items"));
  assert.deepEqual(itemInsert.params[1], ["lead-1", "lead-2"]);
  assert.match(itemInsert.sql, /ON CONFLICT \(pilot_id, lead_id\) DO NOTHING/);
});

test("enrichment upsert and pilot detail use stable conflict keys", async () => {
  const { upsertEnrichment, getPilot } = await import("../src/services/personalization-store.js");
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes("INSERT INTO lead_enrichments")) return { rows: [{ id: "enrichment-1", status: "qualified" }], rowCount: 1 };
      if (String(sql).includes("FROM personalization_pilots") && !String(sql).includes("JOIN")) return { rows: [{ id: "pilot-1" }], rowCount: 1 };
      if (String(sql).includes("FROM personalization_pilot_items")) return { rows: [{ id: "item-1", lead_id: "lead-1" }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const enrichment = await upsertEnrichment(client, {
    leadId: "lead-1",
    rulesVersion: "backup-v1",
    status: "qualified",
    fitScore: 85,
    fitReason: "Есть онлайн-запись",
    canonicalCompany: "Компания",
    sourcePages: [],
    alternativeContacts: [],
  });
  assert.equal(enrichment.id, "enrichment-1");
  assert.match(calls[0].sql, /ON CONFLICT \(lead_id, rules_version\) DO UPDATE/);

  const detail = await getPilot(client, "pilot-1");
  assert.equal(detail.pilot.id, "pilot-1");
  assert.equal(detail.items.length, 1);
});

test("createDraftFromPersonalization is transactional and idempotent", async () => {
  const { createDraftFromPersonalization } = await import("../src/services/personalization-store.js");
  const calls = [];
  let existing = false;
  let itemStatus = "generating";
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (String(sql).includes("FROM personalization_pilot_items") && String(sql).includes("FOR UPDATE")) {
        return { rows: [{ status: itemStatus, draft_id: existing ? "draft-1" : null }], rowCount: 1 };
      }
      if (String(sql).includes("SELECT id, manually_edited_at") && String(sql).includes("FROM outreach_drafts")) {
        return existing ? { rows: [{ id: "draft-1", manually_edited_at: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (String(sql).includes("SELECT outreach_import_id") && String(sql).includes("FROM personalization_pilots")) {
        return { rows: [{ outreach_import_id: "import-1" }], rowCount: 1 };
      }
      if (String(sql).includes("INSERT INTO outreach_drafts")) {
        existing = true;
        return { rows: [{ id: "draft-1" }], rowCount: 1 };
      }
      if (String(sql).includes("INSERT INTO outreach_draft_steps")) return { rows: [], rowCount: 2 };
      if (String(sql).includes("UPDATE personalization_pilot_items")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const input = {
    pilotId: "pilot-1",
    lead: { id: "lead-1", email: "hello@example.com", company: "Компания", contact_name: "" },
    enrichment: { id: "enrichment-1", rules_version: "backup-v1" },
    copy: {
      subject: "Резервные копии для сайта «Компания»",
      bodyText: "Первое письмо",
      followupSubject: "Re: Резервные копии для сайта «Компания»",
      followupBodyText: "Короткий follow-up.",
      usedEvidence: ["fact-1"],
    },
    sourceRowNumber: 1,
  };

  assert.deepEqual(await createDraftFromPersonalization(client, input), { draftId: "draft-1", created: true });
  assert.deepEqual(await createDraftFromPersonalization(client, input), { draftId: "draft-1", created: false });
  itemStatus = "excluded";
  assert.deepEqual(await createDraftFromPersonalization(client, input), { draftId: "draft-1", created: false, skipped: true });
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO outreach_drafts")).length, 1);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO outreach_draft_steps")).length, 1);
  assert.equal(calls.filter((call) => call.sql === "BEGIN").length, 3);
  assert.equal(calls.filter((call) => call.sql === "COMMIT").length, 3);
});
