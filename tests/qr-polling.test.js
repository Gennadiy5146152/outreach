import test from "node:test";
import assert from "node:assert/strict";
import { createQrPoller } from "../public/qr-polling.js";

function fixture(fetchState) {
  let time = 0;
  const timers = new Map(), states = [], errors = [];
  const poller = createQrPoller({ fetchState, now: () => time,
    onState: (s, id) => states.push([s.status, id]), onError: (e, info) => errors.push([e.message, info.retrying]),
    schedule(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, unschedule(id) { timers.delete(id); } });
  return { poller, states, errors, timers,
    async tick() { const [id, t] = [...timers][0]; timers.delete(id); time += t.ms; await t.fn(); },
    advance(ms) { time += ms; } };
}
test("QR login recovers automatically from a non-JSON 503 during deployment", async () => {
  let n = 0;
  const f = fixture(async () => {
    if (++n === 1) throw Object.assign(new Error("Temporary non-JSON response"), { retryable: true });
    return { status: n === 2 ? "qr_ready" : "connected" };
  });
  await f.poller.start("login-a");
  assert.deepEqual(f.errors, [["Temporary non-JSON response", true]]);
  await f.tick(); await f.tick();
  assert.deepEqual(f.states, [["qr_ready", "login-a"], ["connected", "login-a"]]);
  assert.equal(f.timers.size, 0);
});
test("QR polling stops on auth failure, expiry and repeated outage; retry is bounded", async () => {
  for (const retryable of [false, true]) {
    const f = fixture(async () => { throw Object.assign(new Error("unavailable"), { retryable }); });
    await f.poller.start("a");
    while (f.timers.size) await f.tick();
    assert.equal(f.errors.length, retryable ? 6 : 1);
    assert.equal(f.errors.at(-1)[1], false);
  }
  const expired = fixture(async () => ({ status: "expired" }));
  await expired.poller.start("a"); assert.equal(expired.timers.size, 0);
});
test("Switching profiles ignores a late response for the previous QR and cancels its timer", async () => {
  let resolve;
  const f = fixture(id => id === "old" ? new Promise(r => { resolve = r; }) : Promise.resolve({ status: "qr_ready" }));
  const old = f.poller.start("old");
  await f.poller.start("new");
  resolve({ status: "connected" }); await old;
  assert.deepEqual(f.states, [["qr_ready", "new"]]);
  assert.equal(f.timers.size, 1);
  f.poller.stop(); assert.equal(f.timers.size, 0);
});
test("A missing QR worker stops indefinite loading, while cloud-password entry keeps polling", async () => {
  let status = "pending_qr";
  const f = fixture(async () => ({ status }));
  await f.poller.start("a"); f.advance(60000); await f.tick();
  assert.deepEqual(f.errors, [["telegram_qr_preparation_timeout", false]]);
  assert.equal(f.timers.size, 0);
  status = "password_required";
  await f.poller.start("a"); f.advance(60000); await f.tick();
  assert.equal(f.timers.size, 1); f.poller.stop();
});
