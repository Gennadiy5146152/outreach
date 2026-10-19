import assert from "node:assert/strict";
import test from "node:test";
import { effectiveOutreachDryRun, quotaRemaining, shouldReserveOutreachQuota } from "../src/services/outreach-quota.js";

test("each mailbox receives its own default daily quota", () => {
  assert.equal(quotaRemaining({ mailboxDefaultLimit: 100, mailboxUsed: 100 }), 0);
  assert.equal(quotaRemaining({ mailboxDefaultLimit: 100, mailboxUsed: 0 }), 100);
});

test("an explicit mailbox limit overrides the default and campaign limits can only reduce it", () => {
  assert.equal(quotaRemaining({
    mailboxDefaultLimit: 100,
    mailboxLimit: 20,
    mailboxUsed: 15,
    campaignLimit: 10,
    campaignUsed: 9,
  }), 1);
});

test("a missing explicit mailbox limit falls back to the per-mailbox default", () => {
  assert.equal(quotaRemaining({
    mailboxDefaultLimit: 100,
    mailboxLimit: null,
    mailboxUsed: 40,
    campaignLimit: null,
    campaignUsed: 500,
  }), 60);
});

test("released running reservation restores one slot", () => {
  assert.equal(quotaRemaining({ mailboxDefaultLimit: 100, mailboxUsed: 100 }), 0);
  assert.equal(quotaRemaining({ mailboxDefaultLimit: 100, mailboxUsed: 99 }), 1);
});

test("dry-run and test sends never reserve real outreach quota", () => {
  assert.equal(shouldReserveOutreachQuota({ dryRun: false, mode: "auto" }), true);
  assert.equal(shouldReserveOutreachQuota({ dryRun: false, mode: "immediate" }), true);
  assert.equal(shouldReserveOutreachQuota({ dryRun: true, mode: "auto" }), false);
  assert.equal(shouldReserveOutreachQuota({ dryRun: false, mode: "test" }), false);
});

test("a send selected during dry-run can never escalate to real SMTP", () => {
  assert.equal(effectiveOutreachDryRun({ selectedDryRun: true, currentDryRun: false }), true);
  assert.equal(effectiveOutreachDryRun({ selectedDryRun: false, currentDryRun: true }), true);
  assert.equal(effectiveOutreachDryRun({ selectedDryRun: false, currentDryRun: false }), false);
});
