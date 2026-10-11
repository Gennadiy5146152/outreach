import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfirmationStore,
  fingerprint,
  stableStringify,
} from "../../src/mcp/confirmation-store.js";

test("stable serialization ignores object key order but preserves semantic differences", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1, b: 2 }), fingerprint({ a: 1, b: 3 }));
  assert.notEqual(fingerprint([1, 2]), fingerprint([2, 1]));
});

test("a prepared plan can be consumed once with exact operation and snapshot", () => {
  let tokenIndex = 0;
  const store = createConfirmationStore({
    now: () => 1_000,
    randomUUID: () => `token-${++tokenIndex}`,
  });
  const prepared = store.prepare({
    operation: "launch",
    payload: { ids: ["draft-1"], mode: "auto" },
    snapshot: { updatedAt: "2026-10-11T10:00:00Z", items: [{ id: "draft-1" }] },
    summary: "Send one draft",
  });

  assert.deepEqual(prepared, {
    confirmation_token: "token-1",
    operation: "launch",
    summary: "Send one draft",
    expires_at: "1970-01-01T00:10:01.000Z",
    requires_confirmation: true,
  });
  const plan = store.consume({
    token: prepared.confirmation_token,
    operation: "launch",
    currentSnapshot: { items: [{ id: "draft-1" }], updatedAt: "2026-10-11T10:00:00Z" },
    confirm: true,
  });
  assert.deepEqual(plan.payload, { ids: ["draft-1"], mode: "auto" });
  assert.throws(() => store.consume({
    token: prepared.confirmation_token,
    operation: "launch",
    currentSnapshot: {},
    confirm: true,
  }), (error) => error.code === "confirmation_not_found");
});

test("stored payload and snapshot are isolated from caller mutation", () => {
  const payload = { ids: ["draft-1"] };
  const snapshot = { status: "ready" };
  const store = createConfirmationStore({ now: () => 0, randomUUID: () => "isolated" });
  const prepared = store.prepare({ operation: "launch", payload, snapshot, summary: "Launch" });
  payload.ids.push("draft-2");
  snapshot.status = "blocked";

  const plan = store.consume({
    token: prepared.confirmation_token,
    operation: "launch",
    currentSnapshot: { status: "ready" },
    confirm: true,
  });
  assert.deepEqual(plan.payload, { ids: ["draft-1"] });
});

test("confirm false invalidates the token before rejecting", () => {
  const store = createConfirmationStore({ now: () => 0, randomUUID: () => "confirm-token" });
  store.prepare({ operation: "reply", payload: {}, snapshot: {}, summary: "Reply" });
  assert.throws(() => store.consume({ token: "confirm-token", operation: "reply", currentSnapshot: {}, confirm: false }),
    (error) => error.code === "confirmation_required");
  assert.throws(() => store.consume({ token: "confirm-token", operation: "reply", currentSnapshot: {}, confirm: true }),
    (error) => error.code === "confirmation_not_found");
});

test("expired, wrong-operation, and changed-state attempts each consume their token", () => {
  let now = 0;
  let index = 0;
  const store = createConfirmationStore({ now: () => now, randomUUID: () => `token-${++index}`, ttlSeconds: 60 });

  const expired = store.prepare({ operation: "launch", payload: {}, snapshot: { status: "ready" }, summary: "Launch" });
  now = 60_001;
  assert.throws(() => store.consume({ token: expired.confirmation_token, operation: "launch", currentSnapshot: { status: "ready" }, confirm: true }),
    (error) => error.code === "confirmation_expired");
  assert.throws(() => store.consume({ token: expired.confirmation_token, operation: "launch", currentSnapshot: { status: "ready" }, confirm: true }),
    (error) => error.code === "confirmation_not_found");

  now = 0;
  const wrongOperation = store.prepare({ operation: "reply", payload: {}, snapshot: {}, summary: "Reply" });
  assert.throws(() => store.consume({ token: wrongOperation.confirmation_token, operation: "launch", currentSnapshot: {}, confirm: true }),
    (error) => error.code === "confirmation_operation_mismatch");
  assert.throws(() => store.consume({ token: wrongOperation.confirmation_token, operation: "reply", currentSnapshot: {}, confirm: true }),
    (error) => error.code === "confirmation_not_found");

  const changed = store.prepare({ operation: "launch", payload: {}, snapshot: { status: "ready" }, summary: "Launch" });
  assert.throws(() => store.consume({ token: changed.confirmation_token, operation: "launch", currentSnapshot: { status: "blocked" }, confirm: true }),
    (error) => error.code === "confirmation_state_changed");
  assert.throws(() => store.consume({ token: changed.confirmation_token, operation: "launch", currentSnapshot: { status: "ready" }, confirm: true }),
    (error) => error.code === "confirmation_not_found");
});

test("unknown tokens are rejected", () => {
  const store = createConfirmationStore();
  assert.throws(() => store.consume({ token: "missing", operation: "launch", currentSnapshot: {}, confirm: true }),
    (error) => error.code === "confirmation_not_found");
});

test("inspect reveals a cloned payload for authoritative re-read without consuming the plan", () => {
  const store = createConfirmationStore({ now: () => 0, randomUUID: () => "inspect-token" });
  store.prepare({ operation: "launch", payload: { ids: ["draft-1"] }, snapshot: { status: "ready" }, summary: "Launch" });
  const inspected = store.inspect({ token: "inspect-token", operation: "launch" });
  assert.deepEqual(inspected.payload, { ids: ["draft-1"] });
  inspected.payload.ids.push("draft-2");
  const consumed = store.consume({ token: "inspect-token", operation: "launch", currentSnapshot: { status: "ready" }, confirm: true });
  assert.deepEqual(consumed.payload, { ids: ["draft-1"] });
});
