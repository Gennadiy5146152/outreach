import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("job claiming always requires and applies an explicit job-type allowlist", async () => {
  const { claimJob } = await import("../src/services/job-queue.js");
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql: String(sql), params });
      if (/SELECT \*/.test(sql)) {
        return { rowCount: 1, rows: [{ id: "job-1", job_type: "enrich_lead", attempts: 0, max_attempts: 3 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const job = await claimJob(client, { jobTypes: ["enrich_lead", "generate_personalized_draft"] });
  assert.equal(job.id, "job-1");
  const select = statements.find((entry) => /SELECT \*/.test(entry.sql));
  assert.match(select.sql, /job_type\s*=\s*ANY\(\$1::text\[\]\)/i);
  assert.deepEqual(select.params, [["enrich_lead", "generate_personalized_draft"]]);
  await assert.rejects(claimJob(client, { jobTypes: [] }), /job_types_required/);
});

test("delivery and personalization processes have disjoint job allowlists and personalization has no mail path", async () => {
  const queue = await import("../src/services/job-queue.js");
  assert.deepEqual(queue.DELIVERY_JOB_TYPES, ["validate_lead", "sync_inbox", "warmup_send"]);
  assert.deepEqual(queue.PERSONALIZATION_JOB_TYPES, ["enrich_lead", "generate_personalized_draft"]);
  assert.deepEqual(queue.DELIVERY_JOB_TYPES.filter((type) => queue.PERSONALIZATION_JOB_TYPES.includes(type)), []);

  const workerSource = fs.readFileSync(path.join(root, "src/worker/index.js"), "utf8");
  assert.match(workerSource, /claimJob[\s\S]*DELIVERY_JOB_TYPES/);
  const personalizerSource = fs.readFileSync(path.join(root, "src/personalizer/index.js"), "utf8");
  assert.doesNotMatch(personalizerSource, /sendMail|services\/mail\.js/);
  assert.doesNotMatch(personalizerSource, /\b(?:sending_queue|enrollments|messages)\b/i);
  assert.match(personalizerSource, /PERSONALIZATION_JOB_TYPES/);
  assert.match(personalizerSource, /item\.manually_overridden_at/);
  assert.match(personalizerSource, /recordJobFailure[\s\S]*\["review", "excluded"\]/);
});

test("personalization handlers are retry-safe and skip an already materialized or manually edited draft", async () => {
  const { createPersonalizationProcessor } = await import("../src/personalizer/index.js");
  const state = {
    item: { id: "item-1", pilotId: "pilot-1", leadId: "lead-1", status: "pending", draftId: null, manuallyEditedAt: null },
    lead: { id: "lead-1", email: "info@alpha.example", company: "Альфа", website: "https://alpha.example" },
    enrichment: null,
    generationQueued: false,
    draftCreates: 0,
    progressUpdates: 0,
  };
  const repository = {
    async loadContext() {
      return { ...state.item, lead: state.lead, enrichment: state.enrichment };
    },
    async markItem(_itemId, patch) {
      Object.assign(state.item, patch);
    },
    async saveEnrichment(input) {
      state.enrichment ||= { id: "enrichment-1", rules_version: "v1", ...input };
      return state.enrichment;
    },
    async enqueueGeneration() {
      state.generationQueued = true;
    },
    async createDraft() {
      state.draftCreates += 1;
      return { draftId: "draft-1", created: state.draftCreates === 1 };
    },
    async updatePilotProgress() {
      state.progressUpdates += 1;
    },
  };
  let generated = 0;
  let excludeDuringGeneration = false;
  const processor = createPersonalizationProcessor({
    repository,
    fetchPages: async () => ({ pages: [{ url: "https://alpha.example", html: "<form>Онлайн-запись</form>" }], errors: [] }),
    extractSignals: () => ({
      canonicalCompany: "Альфа",
      businessType: "clinic",
      city: "Москва",
      namedContacts: [],
      alternativeEmails: [],
      digitalProcesses: [{ type: "form", sourceUrl: "https://alpha.example", evidence: "Онлайн-запись" }],
      pageTextLength: 700,
    }),
    qualify: () => ({
      status: "qualified",
      score: 75,
      reason: "Подтверждён цифровой процесс",
      fact: { id: "process-1", sourceUrl: "https://alpha.example", evidence: "Онлайн-запись" },
    }),
    resolveContact: () => null,
    generateCopy: async () => {
      generated += 1;
      if (excludeDuringGeneration) {
        state.item.status = "excluded";
        state.item.manuallyOverriddenAt = new Date().toISOString();
      }
      return { subject: "Тема", bodyText: "Текст", followupSubject: "Re: Тема", followupBodyText: "Фоллоу-ап", usedEvidence: ["process-1"] };
    },
  });

  const enrichmentJob = { id: "job-e", job_type: "enrich_lead", payload: { itemId: "item-1", rulesVersion: "v1" } };
  await processor.handleJob(enrichmentJob);
  await processor.handleJob(enrichmentJob);
  assert.equal(state.enrichment.id, "enrichment-1");
  assert.equal(state.generationQueued, true);

  const generationJob = { id: "job-g", job_type: "generate_personalized_draft", payload: { itemId: "item-1" } };
  await processor.handleJob(generationJob);
  await processor.handleJob(generationJob);
  assert.equal(generated, 1);
  assert.equal(state.draftCreates, 1);
  assert.equal(state.item.status, "ready");
  assert.equal(state.item.draftId, "draft-1");
  assert.ok(state.progressUpdates >= 2);

  state.item = { ...state.item, status: "generating", draftId: "draft-1", manuallyEditedAt: new Date().toISOString() };
  await processor.handleJob(generationJob);
  assert.equal(generated, 1, "manual draft must not be regenerated");
  assert.equal(state.draftCreates, 1, "manual draft must not be overwritten");

  state.item = { ...state.item, status: "excluded", draftId: null, manuallyEditedAt: null };
  await processor.handleJob(generationJob);
  assert.equal(generated, 1, "a manually excluded item must not be generated");
  assert.equal(state.item.status, "excluded", "manual exclusion must survive a queued generation job");

  state.item = { ...state.item, status: "qualified", draftId: null, manuallyEditedAt: null, manuallyOverriddenAt: null };
  excludeDuringGeneration = true;
  await processor.handleJob(generationJob);
  assert.equal(generated, 2, "generation may already be in flight when the operator excludes the lead");
  assert.equal(state.draftCreates, 1, "an in-flight generation must not create a draft after manual exclusion");
  assert.equal(state.item.status, "excluded", "an in-flight generation must not overwrite manual exclusion");

  state.item = { ...state.item, status: "qualified", draftId: null, manuallyEditedAt: null, manuallyOverriddenAt: new Date().toISOString() };
  excludeDuringGeneration = false;
  await processor.handleJob(generationJob);
  assert.equal(state.draftCreates, 2, "a deliberate manual qualification must still allow draft generation");
  assert.equal(state.item.status, "ready");
});

test("production compose auto-starts personalizer but keeps the mail worker behind its profile", () => {
  const compose = fs.readFileSync(path.join(root, "docker-compose.prod.yml"), "utf8");
  assert.match(compose, /\n  personalizer:\n[\s\S]*command:\s*\["node",\s*"src\/personalizer\/index\.js"\]/);
  assert.doesNotMatch(compose.match(/\n  personalizer:\n[\s\S]*?(?=\n  \w|\nvolumes:)/)?.[0] || "", /profiles:/);
  assert.match(compose.match(/\n  worker:\n[\s\S]*?(?=\n  \w|\nvolumes:)/)?.[0] || "", /profiles:\s*\["worker"\]/);
});
