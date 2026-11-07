import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("../src/services/outreach-channel-tasks.js", import.meta.url).href;

test("channels accept direct profiles for the right service and reject misleading URLs", async () => {
  const { channelContactInput } = await import(moduleUrl);
  assert.deepEqual(channelContactInput({ channel: "telegram", address: "@work_contact", source_url: "https://company.example/team" }).address, "https://t.me/work_contact");
  assert.equal(channelContactInput({ channel: "max", address: "https://max.ru/u/fX1_2", source_url: "https://company.example/team" }).address, "https://max.ru/u/fX1_2");
  assert.throws(() => channelContactInput({ channel: "vk", address: "https://vk.com.evil.example/id123", source_url: "https://company.example/team" }), /channel_address_invalid/);
  assert.throws(() => channelContactInput({ channel: "telegram", address: "https://t.me/share/url", source_url: "https://company.example/team" }), /channel_address_invalid/);
});

test("scheduled tasks require an explicit time zone and reject past dates", async () => {
  const { channelTaskInput } = await import(moduleUrl);
  const now = new Date("2026-11-07T09:00:00Z");
  assert.equal(channelTaskInput({ body: "Добрый день!", scheduled_at: "2026-11-09T12:00:00+03:00" }, now).scheduledAt, "2026-11-09T09:00:00.000Z");
  assert.throws(() => channelTaskInput({ body: "Добрый день!", scheduled_at: "2026-11-09T12:00" }, now), /channel_schedule_invalid/);
  assert.throws(() => channelTaskInput({ body: "Добрый день!", scheduled_at: "2026-11-07T11:59:00+03:00" }, now), /channel_schedule_invalid/);
});

test("a delivery failure or automatic email reply does not stop a messenger task", async () => {
  const { cancelScheduledChannelTasksForEmailReply } = await import(moduleUrl);
  const query = () => assert.fail("automatic mail should not change the schedule");
  assert.equal(await cancelScheduledChannelTasksForEmailReply(query, "lead", "auto_reply"), 0);
  assert.equal(await cancelScheduledChannelTasksForEmailReply(query, "lead", "bounce"), 0);
});
