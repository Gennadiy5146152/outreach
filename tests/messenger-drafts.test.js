import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const originalBody = "Оксана, добрый день!\nИзвиняюсь за беспокойство.\n\nПредлагаю обсудить сотрудничество.";
const input = {
  collection: "Ноябрь",
  rows: [{
    telegram: "https://t.me/work_contact",
    source: "https://example.com/team",
    name: "Оксана",
    company: "Пример",
    draft: originalBody,
    status: "review",
    review_reason: "Проверить должность",
  }],
};

test("an invalid profile rejects the whole batch before writing", async () => {
  const { createMessengerDrafts } = await import("../src/services/messenger-drafts.js");
  const drafts = createMessengerDrafts({ query: () => assert.fail("Invalid input reached PostgreSQL") });
  await assert.rejects(
    drafts.importBatch({ ...input, rows: [...input.rows, { ...input.rows[0], telegram: "https://t.me/share/url" }] }),
    /channel_address_invalid/,
  );
});

test("a sent snapshot preserves the exact text and time through edits and reimports", {
  skip: !process.env.MESSENGER_TEST_DATABASE_URL,
}, async () => {
  const client = new pg.Client({ connectionString: process.env.MESSENGER_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA messenger_test; SET LOCAL search_path TO messenger_test, public");
    await client.query(await readFile(new URL("../db/migrations/021_messenger_drafts.sql", import.meta.url), "utf8"));
    const { createMessengerDrafts } = await import("../src/services/messenger-drafts.js");
    const drafts = createMessengerDrafts({ query: client.query.bind(client) });
    assert.deepEqual(await drafts.importBatch(input), { inserted: 1, existing: 0 });
    const review = await drafts.list({ status: "review", search: "окс" });
    assert.equal(review.total, 1);
    const { id } = review.items[0];
    assert.equal((await drafts.get(id)).body, originalBody);
    await drafts.update(id, { body: originalBody, reviewed: true });
    assert.equal((await drafts.list({ status: "ready" })).total, 1);
    const sentBody = "Оксана, добрый день!\n\nФактически отправленный текст. ";
    const sent = await drafts.recordSent(id, { body: sentBody });
    assert.equal(sent.sent_body, sentBody);
    assert.equal((await drafts.recordSent(id, { body: sentBody })).sent_at.getTime(), sent.sent_at.getTime());
    await assert.rejects(drafts.recordSent(id, { body: "Другой текст" }), /messenger_draft_sent/);
    await assert.rejects(drafts.update(id, { body: "Другой текст" }), /messenger_draft_sent/);
    assert.deepEqual(await drafts.importBatch(input), { inserted: 0, existing: 1 });
    assert.equal((await drafts.list({ status: "sent" })).total, 1);
    const final = await drafts.get(id);
    assert.equal(final.body, originalBody);
    assert.equal(final.sent_body, sentBody);
    assert.equal(final.sent_at.getTime(), sent.sent_at.getTime());
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
