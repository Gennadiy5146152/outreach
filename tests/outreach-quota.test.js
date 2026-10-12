import assert from "node:assert/strict";
import test from "node:test";
import { quotaRemaining } from "../src/services/outreach-quota.js";

test("global quota counts every outreach reservation", () => {
  assert.equal(quotaRemaining({ globalLimit: 100, globalUsed: 70 }), 30);
  assert.equal(quotaRemaining({ globalLimit: 100, globalUsed: 100 }), 0);
});

test("mailbox and campaign limits can only reduce remaining capacity", () => {
  assert.equal(quotaRemaining({
    globalLimit: 100,
    globalUsed: 40,
    mailboxLimit: 20,
    mailboxUsed: 15,
    campaignLimit: 10,
    campaignUsed: 9,
  }), 1);
});

test("null local limits leave the global quota authoritative", () => {
  assert.equal(quotaRemaining({
    globalLimit: 100,
    globalUsed: 40,
    mailboxLimit: null,
    mailboxUsed: 500,
    campaignLimit: null,
    campaignUsed: 500,
  }), 60);
});

test("released running reservation restores one slot", () => {
  assert.equal(quotaRemaining({ globalLimit: 100, globalUsed: 100 }), 0);
  assert.equal(quotaRemaining({ globalLimit: 100, globalUsed: 99 }), 1);
});
