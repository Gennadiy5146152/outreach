import assert from "node:assert/strict";
import test from "node:test";
import {
  isImmediateDraftQueueItem,
  normalizeCampaignLaunchMode,
  normalizeDraftLaunchMode,
} from "../src/services/outreach-delivery-mode.js";

test("draft launch accepts immediate while campaign launch rejects it", () => {
  assert.equal(normalizeDraftLaunchMode("immediate"), "immediate");
  assert.equal(normalizeDraftLaunchMode("unknown"), "auto");
  assert.equal(normalizeCampaignLaunchMode("manual"), "manual");
  assert.equal(normalizeCampaignLaunchMode("auto"), "auto");
  assert.equal(normalizeCampaignLaunchMode("test"), "test");
  assert.equal(normalizeCampaignLaunchMode("immediate"), null);
  assert.equal(normalizeCampaignLaunchMode("unknown"), null);
});

test("immediate bypass is limited to a first-step personal draft", () => {
  const eligible = {
    mode: "immediate",
    outreach_draft_id: "draft-1",
    campaign_id: null,
    outreach_step_position: 1,
  };
  assert.equal(isImmediateDraftQueueItem(eligible), true);
  assert.equal(isImmediateDraftQueueItem({ ...eligible, campaign_id: "campaign-1" }), false);
  assert.equal(isImmediateDraftQueueItem({ ...eligible, outreach_draft_id: null }), false);
  assert.equal(isImmediateDraftQueueItem({ ...eligible, outreach_step_position: 2 }), false);
  assert.equal(isImmediateDraftQueueItem({ ...eligible, outreach_step_position: null }), false);
  assert.equal(isImmediateDraftQueueItem({ ...eligible, outreach_step_position: undefined }), false);
  assert.equal(isImmediateDraftQueueItem({ ...eligible, mode: "auto" }), false);
});
