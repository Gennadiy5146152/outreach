import assert from "node:assert/strict";
import test from "node:test";
import { outreachStopAllImpact, stopAllOutreach, withOutreachDeliveryLock } from "../src/services/outreach-control.js";

function stopClient({ failOnCancel = false } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (String(sql).includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (String(sql).includes("SELECT") && String(sql).includes("first_touches")) {
        assert.match(sql, /run\.mode <> 'test'/);
        assert.match(sql, /campaign\.test_mode = false/);
        return {
          rows: [{
            active_queue: 5,
            first_touches: 3,
            followups: 2,
            active_runs: 2,
            active_enrollments: 4,
            active_drafts: 5,
            snapshot_token: "snapshot-1",
          }],
          rowCount: 1,
        };
      }
      if (String(sql).includes("UPDATE sending_queue")) {
        if (failOnCancel) throw new Error("database unavailable");
        assert.match(sql, /status IN \('pending','retrying','running'\)/);
        assert.match(sql, /mode <> 'test'/);
        assert.match(sql, /quota_reservation_active = false/);
        return { rows: [{ outreach_step_id: "step-1" }, { outreach_step_id: "step-2" }, { outreach_step_id: null }], rowCount: 3 };
      }
      if (String(sql).includes("UPDATE enrollments")) {
        assert.match(sql, /campaign\.test_mode = false/);
        return { rows: [], rowCount: 2 };
      }
      if (String(sql).includes("UPDATE outreach_drafts")) {
        return { rows: [{ id: "draft-1" }, { id: "draft-2" }], rowCount: 2 };
      }
      if (String(sql).includes("UPDATE outreach_draft_steps")) return { rows: [], rowCount: 2 };
      if (String(sql).includes("UPDATE outreach_runs")) {
        assert.match(sql, /mode <> 'test'/);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { client, calls };
}

test("global stop impact separates first touches from follow-ups", async () => {
  const { client } = stopClient();
  assert.deepEqual(await outreachStopAllImpact(client), {
    active_queue: 5,
    first_touches: 3,
    followups: 2,
    active_runs: 2,
    active_enrollments: 4,
    active_drafts: 5,
    snapshot_token: "snapshot-1",
  });
});

test("global stop cancels every real outreach queue and pauses future chains", async () => {
  const { client, calls } = stopClient();
  assert.deepEqual(await stopAllOutreach(client, "snapshot-1"), {
    stopped: true,
    cancelled_queue: 3,
    cancelled_steps: 2,
    paused_enrollments: 2,
    cancelled_drafts: 2,
    stopped_runs: 1,
  });
  assert.equal(calls[0], "BEGIN");
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.equal(calls.at(-1), "COMMIT");
});

test("global stop rolls back atomically when cancellation fails", async () => {
  const { client, calls } = stopClient({ failOnCancel: true });
  await assert.rejects(stopAllOutreach(client, "snapshot-1"), /database unavailable/);
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("global stop rejects a changed affected set inside the stop transaction", async () => {
  const { client, calls } = stopClient();
  await assert.rejects(
    stopAllOutreach(client, "stale-snapshot"),
    (error) => error.status === 409 && error.message === "outreach_stop_snapshot_changed",
  );
  assert.equal(calls[0], "BEGIN");
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.some((sql) => String(sql).includes("UPDATE sending_queue")), false);
});

test("real delivery holds a shared stop lock and always releases it", async () => {
  const calls = [];
  const client = { query: async (sql) => { calls.push(sql); return { rows: [], rowCount: 0 }; } };
  const value = await withOutreachDeliveryLock(client, async () => {
    calls.push("send");
    return "sent";
  });
  assert.equal(value, "sent");
  assert.match(calls[0], /pg_advisory_lock_shared/);
  assert.equal(calls[1], "send");
  assert.match(calls[2], /pg_advisory_unlock_shared/);

  calls.length = 0;
  await assert.rejects(withOutreachDeliveryLock(client, async () => {
    calls.push("send");
    throw new Error("smtp failed");
  }), /smtp failed/);
  assert.match(calls.at(-1), /pg_advisory_unlock_shared/);
});
