import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import express from "express";
import { createCabinet } from "../src/cabinet/router.js";
import { createAuth } from "../src/http/auth.js";
import { scheduleJobs } from "../src/cabinet/store.js";
import {
  digest,
  hashPassword,
  verifyPassword,
  encryptPassword,
} from "../src/cabinet/security.js";
import {
  stopAllOutreach,
  outreachStopAllImpact,
} from "../src/services/outreach-control.js";

test("password hashing, Unicode passwords, authenticated encryption and schedule boundaries", async () => {
  const password = "  Очень длинный пароль  ";
  const hash = await hashPassword(password);
  assert.ok(!hash.includes(password));
  assert.ok(await verifyPassword(password, hash));
  assert.ok(!(await verifyPassword(password.trim(), hash)));
  assert.ok(!(await verifyPassword(password, null)));
  await assert.rejects(hashPassword("short"));
  await assert.rejects(
    hashPassword("1234567"),
    /password_requires_8_characters/,
  );
  const eight = "Abcd1234";
  assert.ok(await verifyPassword(eight, await hashPassword(eight)));
  await assert.rejects(
    hashPassword("😀😀😀😀"),
    /password_requires_8_characters/,
  );
  const maxPassword = "x".repeat(1024);
  assert.equal(
    await verifyPassword(
      maxPassword + "suffix",
      await hashPassword(maxPassword),
    ),
    false,
  );
  assert.notEqual(
    encryptPassword(password, "x".repeat(32)),
    encryptPassword(password, "x".repeat(32)),
  );
  const slots = scheduleJobs({
    now: new Date("2026-11-27T08:25:00Z"),
    window_start: "09:30",
    window_end: "11:30",
    daily_limit: 2,
    count: 4,
    random: () => 0,
    occupied: [{ slot: "2026-11-27T07:00:00Z" }],
  });
  assert.equal(slots.length, 4);
  assert.equal(slots[0].slice(0, 10), "2026-11-27");
  assert.equal(slots[1].slice(0, 10), "2026-11-30");
  assert.equal(slots[3].slice(0, 10), "2026-12-01");
});

const connectionString = process.env.CABINET_TEST_DATABASE_URL;
test(
  "private cabinets enforce ownership, scopes, approvals and isolation in PostgreSQL + HTTP",
  { skip: !connectionString },
  async (t) => {
    const parsed = new URL(connectionString);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
        /^\/cabinet_test(?:_[a-z0-9]+)?$/.test(parsed.pathname),
      "Only a disposable local cabinet_test database is allowed",
    );
    const pool = new pg.Pool({ connectionString });
    const query = pool.query.bind(pool);
    const withClient = async (fn) => {
      const db = await pool.connect();
      try {
        return await fn(db);
      } finally {
        db.release();
      }
    };
    const env = {
      nodeEnv: "development",
      authUser: "root-test",
      authPassword: "root-test-password",
      authSessionSecret: "root-session-secret-test",
      authCookieSecure: false,
      cabinetTelegramSendEnabled: true,
    };
    const cabinet = createCabinet({ query, withClient, env });
    const auth = createAuth(env);
    const app = express();
    app.use(express.json());
    app.use("/api/cabinet", cabinet.router);
    app.post("/root-login", (_req, res) => {
      auth.setAuthCookie(res);
      res.json({ ok: true });
    });
    app.use(
      "/api/cabinet-admin",
      auth.requireAuth,
      (req, res, next) =>
        auth.isAuthenticated(req)
          ? next()
          : res.status(403).json({ error: "administrator_session_required" }),
      cabinet.admin,
    );
    app.use(auth.requireAuth);
    app.get("/api/legacy-test", (_req, res) =>
      res.json({ secret: "legacy workspace" }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    async function request(
      path,
      { body, method, token, cookie, csrf, origin } = {},
    ) {
      if (path.endsWith("/launch/prepare"))
        await query(
          "UPDATE cabinet_connections SET heartbeat_at=now() WHERE status='connected'",
        );
      const res = await fetch(base + path, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: res.status,
        data: await res.json(),
        cookie: res.headers
          .getSetCookie()
          .map((x) => x.split(";")[0])
          .join("; "),
      };
    }
    const prefix = randomUUID().slice(0, 8);
    const owned = [];
    async function owner(name) {
      const invite = await cabinet.store.invite({
        username: prefix + "-" + name,
        display_name: name,
      });
      owned.push(invite.account.id);
      const session = await cabinet.store.activate({
        invite_token: invite.invite_token,
        password: "long-test-password-" + name,
      });
      const cookie = "outreach_cabinet=" + session.raw;
      const p = await cabinet.store.authenticate({ headers: { cookie } });
      return { p, cookie, csrf: session.csrf, invite };
    }
    try {
      const a = await owner("alice"),
        b = await owner("bob");
      const aa = { cookie: a.cookie, csrf: a.csrf };
      const ba = { cookie: b.cookie, csrf: b.csrf };
      const conn = await cabinet.store.connect(a.p, {
        username: "test_alice_" + prefix,
      });
      const connB = await cabinet.store.connect(b.p, {
        username: "test_bob_" + prefix,
      });
      const c = await cabinet.store.createCampaign(a.p, {
        connection_id: conn.id,
        name: "Alice campaign",
      });
      const c2 = await cabinet.store.createCampaign(a.p, {
        connection_id: conn.id,
        name: "Alice second campaign",
      });
      const cb = await cabinet.store.createCampaign(b.p, {
        connection_id: connB.id,
        name: "Bob campaign",
      });
      const draft = async (campaign, n, principal = a.p) =>
        cabinet.store.saveDraft(principal, campaign.id, {
          address: "https://t.me/recipient_" + prefix + "_" + n,
          recipient_id: String(880000000 + n),
          name: "Контакт " + n,
          body: "Добрый день!\n\nИндивидуальный текст " + n,
          permission_kind: "consent",
          permission_evidence: "Согласие на тест (реальная отправка отключена)",
        });
      const d = await draft(c, 1),
        d2 = await draft(c, 2),
        db = await draft(cb, 3, b.p);
      await query(
        "UPDATE cabinet_connections SET status='connected',telegram_user_id=8800000000+generation,username=expected_username,heartbeat_at=now() WHERE id=$1",
        [conn.id],
      );
      const mint = async (scopes, ids = [c.id]) =>
        cabinet.store.tokenCreate(a.p, {
          name: "Test",
          scopes,
          campaign_ids: ids,
          expires_in_days: 1,
        });
      const read = await mint(["outreach:read"]),
        send = await mint(["outreach:send"]),
        full = await mint([
          "outreach:read",
          "outreach:draft",
          "outreach:send",
          "outreach:stop",
        ]);
      await t.test(
        "activation is one-time, password errors and tenant cookie never unlock legacy workspace",
        async () => {
          await assert.rejects(
            cabinet.store.activate({
              invite_token: a.invite.invite_token,
              password: "another-long-password",
            }),
            /invite_invalid/,
          );
          assert.equal(
            (
              await request("/api/cabinet/auth/login", {
                body: { username: a.p.login, password: "wrong" },
              })
            ).status,
            401,
          );
          assert.equal((await request("/api/legacy-test", aa)).status, 401);
          assert.equal(
            (await request("/api/cabinet-admin/accounts", aa)).status,
            401,
          );
          assert.equal(
            (await request("/api/cabinet/connections", { token: read.token }))
              .status,
            403,
          );
          assert.equal(
            (
              await request("/api/cabinet/connections/" + conn.id + "/qr", {
                token: read.token,
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "every ID and token allowlist is enforced server-side",
        async () => {
          for (const suffix of ["drafts", "queue", "threads/" + randomUUID()])
            assert.equal(
              (
                await request(`/api/cabinet/campaigns/${cb.id}/${suffix}`, {
                  token: read.token,
                })
              ).status,
              404,
            );
          assert.equal(
            (
              await request(`/api/cabinet/campaigns/${c2.id}/drafts`, {
                token: read.token,
              })
            ).status,
            404,
          );
          assert.equal(
            (await request(`/api/cabinet/connections/${connB.id}/qr`, aa))
              .status,
            404,
          );
          assert.equal(
            (await request("/api/cabinet/tokens", { token: read.token }))
              .status,
            403,
          );
          assert.equal(
            (
              await request("/api/cabinet/tokens", {
                token: full.token,
                body: {
                  name: "escalate",
                  scopes: ["outreach:send"],
                  campaign_ids: [cb.id],
                },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/cabinet/tokens", {
                ...aa,
                body: {
                  name: "wrong owner",
                  scopes: ["outreach:read"],
                  campaign_ids: [cb.id],
                },
              })
            ).status,
            404,
          );
          const visible = (
            await request("/api/cabinet/campaigns", { token: read.token })
          ).data;
          assert.deepEqual(
            visible.map((x) => x.id),
            [c.id],
          );
          const root = await request("/root-login", { body: {} });
          assert.equal(
            (
              await request("/api/legacy-test", {
                cookie: root.cookie,
                token: full.token,
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "CSRF, origin, absent scope and arbitrary paths fail closed",
        async () => {
          assert.equal(
            (
              await request("/api/cabinet/tokens", {
                cookie: a.cookie,
                body: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request("/api/cabinet/tokens", {
                ...aa,
                origin: "https://evil.example",
                body: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(`/api/cabinet/campaigns/${c.id}/launch/prepare`, {
                token: read.token,
                body: { draft_ids: [d.id] },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(`/api/cabinet/campaigns/${c.id}/drafts`, {
                token: send.token,
              })
            ).status,
            403,
          );
          assert.equal(
            (await request("/api/cabinet/dialogs", { token: full.token }))
              .status,
            404,
          );
          assert.equal(
            (
              await request("/api/cabinet/messages/history", {
                token: full.token,
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        "provider restriction cannot be resumed through a send-scoped token",
        async () => {
          await query(
            "UPDATE cabinet_connections SET error_code='telegram_rate_limit' WHERE id=$1",
            [conn.id],
          );
          try {
            const blocked = await request(
              `/api/cabinet/campaigns/${c.id}/launch/prepare`,
              { token: full.token, body: { draft_ids: [d.id] } },
            );
            assert.equal(
              blocked.data.error,
              "telegram_connection_attention_required",
            );
          } finally {
            await query(
              "UPDATE cabinet_connections SET error_code=NULL WHERE id=$1",
              [conn.id],
            );
          }
        },
      );
      await t.test(
        "prepare is inert, plans bind to one principal, edits invalidate exact preview",
        async () => {
          let result = await request(
            `/api/cabinet/campaigns/${c.id}/launch/prepare`,
            { token: full.token, body: { draft_ids: [d.id] } },
          );
          assert.equal(result.status, 200);
          const plan = result.data;
          assert.equal(plan.preview.items[0].body, d.body);
          assert.equal(
            (
              await query("SELECT 1 FROM cabinet_jobs WHERE owner_id=$1", [
                a.p.owner_id,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await request("/api/cabinet/execute", {
                token: send.token,
                body: {
                  confirmation_token: plan.confirmation_token,
                  confirm: true,
                  kind: "launch",
                },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await request("/api/cabinet/execute", {
                token: full.token,
                body: {
                  confirmation_token: plan.confirmation_token,
                  confirm: false,
                  kind: "launch",
                },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await request(`/api/cabinet/campaigns/${c.id}/drafts/${d.id}`, {
                token: full.token,
                method: "PATCH",
                body: { body: "Исправленный текст\n\nС абзацами." },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request("/api/cabinet/execute", {
                token: full.token,
                body: {
                  confirmation_token: plan.confirmation_token,
                  confirm: true,
                  kind: "launch",
                },
              })
            ).data.error,
            "plan_changed",
          );
        },
      );
      await t.test(
        "revocation invalidates a prepared plan even if principal was authenticated earlier",
        async () => {
          const transient = await mint(["outreach:send"]);
          const p = await cabinet.store.authenticate({
            headers: { authorization: "Bearer " + transient.token },
          });
          const plan = await cabinet.store.prepare(p, c.id, {
            draft_ids: [d.id],
          });
          await cabinet.store.tokenRevoke(a.p, transient.id);
          await assert.rejects(
            cabinet.store.execute(p, {
              confirmation_token: plan.confirmation_token,
              confirm: true,
              kind: "launch",
            }),
            /cabinet_auth_required/,
          );
          assert.equal(
            (
              await request("/api/cabinet/mcp/context", {
                token: transient.token,
              })
            ).status,
            401,
          );
        },
      );
      await t.test(
        "execution is atomic, one-use and prevents duplicate recipient dispatch",
        async () => {
          const plan = (
            await request(`/api/cabinet/campaigns/${c.id}/launch/prepare`, {
              token: full.token,
              body: { draft_ids: [d.id] },
            })
          ).data;
          const wrong = await request("/api/cabinet/execute", {
            token: full.token,
            body: {
              confirmation_token: plan.confirmation_token,
              confirm: true,
              kind: "stop",
            },
          });
          assert.equal(wrong.data.error, "confirmation_wrong_action");
          const attempts = await Promise.all(
            [1, 2].map(() =>
              request("/api/cabinet/execute", {
                token: full.token,
                body: {
                  confirmation_token: plan.confirmation_token,
                  confirm: true,
                  kind: "launch",
                },
              }),
            ),
          );
          assert.deepEqual(attempts.map((x) => x.status).sort(), [200, 409]);
          assert.equal(
            (
              await request(`/api/cabinet/campaigns/${c.id}/launch/prepare`, {
                token: full.token,
                body: { draft_ids: [d.id] },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await request(`/api/cabinet/campaigns/${c.id}/drafts/${d.id}`, {
                token: full.token,
                method: "PATCH",
                body: { body: "tamper queued text" },
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "thread reads are job-bound and PostgreSQL forbids cross-owner message linkage",
        async () => {
          const job = (
            await query("SELECT * FROM cabinet_jobs WHERE owner_id=$1", [
              a.p.owner_id,
            ])
          ).rows[0];
          await query(
            "INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at) VALUES($1,$2,$3,$4,101,'outbound',$5,now())",
            [a.p.owner_id, job.id, conn.id, job.recipient_id, job.body],
          );
          const messages = await request(
            `/api/cabinet/campaigns/${c.id}/threads/${job.id}`,
            { token: read.token },
          );
          assert.equal(messages.status, 200);
          assert.equal(messages.data.length, 1);
          assert.equal(
            (
              await request(
                `/api/cabinet/campaigns/${cb.id}/threads/${job.id}`,
                ba,
              )
            ).status,
            404,
          );
          await assert.rejects(
            query(
              "INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at) VALUES($1,$2,$3,$4,102,'inbound','wrong owner',now())",
              [b.p.owner_id, job.id, connB.id, job.recipient_id],
            ),
            (e) => e.code === "23503",
          );
        },
      );
      await t.test(
        "stop and global emergency stop cancel private queues and invalidate previews",
        async () => {
          const stop = (
            await request(`/api/cabinet/campaigns/${c.id}/stop/prepare`, {
              token: full.token,
              body: { draft_ids: [d.id] },
            })
          ).data;
          assert.equal(
            (
              await request("/api/cabinet/execute", {
                token: full.token,
                body: {
                  confirmation_token: stop.confirmation_token,
                  confirm: true,
                  kind: "stop",
                },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await query("SELECT status FROM cabinet_jobs WHERE draft_id=$1", [
                d.id,
              ])
            ).rows[0].status,
            "cancelled",
          );
          const plan = (
            await request(`/api/cabinet/campaigns/${c.id}/launch/prepare`, {
              token: full.token,
              body: { draft_ids: [d2.id] },
            })
          ).data;
          const impact = await withClient(outreachStopAllImpact);
          await withClient((db) => stopAllOutreach(db, impact.snapshot_token));
          assert.equal(
            (
              await request("/api/cabinet/execute", {
                token: full.token,
                body: {
                  confirmation_token: plan.confirmation_token,
                  confirm: true,
                  kind: "launch",
                },
              })
            ).data.error,
            "plan_changed",
          );
        },
      );
      await t.test(
        "no session material or token plaintext in list APIs; logout revokes owner access",
        async () => {
          const listed = JSON.stringify(
            (await request("/api/cabinet/tokens", aa)).data,
          );
          assert.ok(!listed.includes(full.token));
          assert.ok(!listed.includes("token_hash"));
          const profile = JSON.stringify(
            (await request("/api/cabinet/connections", aa)).data,
          );
          for (const field of [
            "password_cipher",
            "qr_svg",
            "api_hash",
            "session_file",
          ])
            assert.ok(!profile.includes(field));
          await query(
            "UPDATE cabinet_api_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
            [read.id],
          );
          assert.equal(
            (await request("/api/cabinet/mcp/context", { token: read.token }))
              .status,
            401,
          );
          assert.equal(
            (await request("/api/cabinet/auth/logout", { ...aa, body: {} }))
              .status,
            200,
          );
          assert.equal((await request("/api/cabinet/me", aa)).status, 401);
        },
      );
      await t.test(
        "production cabinet login refuses unencrypted transport",
        async () => {
          env.nodeEnv = "production";
          const result = await request("/api/cabinet/auth/login", {
            body: { username: b.p.login, password: "long-test-password-bob" },
          });
          assert.equal(result.status, 503);
          env.cabinetPublicUrl = "https://outreach.example.test";
          env.authCookieSecure = true;
          assert.equal((await request("/api/cabinet/me", ba)).status, 426);
          env.authCookieSecure = false;
          env.cabinetPublicUrl = base;
          env.cabinetAllowHttp = true;
          assert.equal((await request("/api/cabinet/me", ba)).status, 200);
          assert.equal(
            (
              await request("/api/cabinet/auth/login", {
                origin: "http://another-host.test",
                body: {
                  username: b.p.login,
                  password: "long-test-password-bob",
                },
              })
            ).status,
            403,
          );
          env.cabinetAllowHttp = false;
          env.cabinetPublicUrl = "";
          env.nodeEnv = "development";
        },
      );
      await t.test(
        "legacy and private identity claims cannot race into dual ownership",
        async () => {
          const sender = "claim_" + prefix;
          await query(
            "INSERT INTO outreach_telegram_profiles(sender,connection_status) VALUES($1,'awaiting_session')",
            [sender],
          );
          const identity = String(
            900000000000 + Math.floor(Math.random() * 1000000),
          );
          try {
            const outcomes = await Promise.allSettled([
              query(
                "UPDATE cabinet_connections SET status='connected',telegram_user_id=$2 WHERE id=$1",
                [connB.id, identity],
              ),
              query(
                "UPDATE outreach_telegram_profiles SET telegram_user_id=$2 WHERE sender=$1",
                [sender, identity],
              ),
            ]);
            assert.equal(
              outcomes.filter((x) => x.status === "fulfilled").length,
              1,
            );
            assert.equal(
              outcomes.find((x) => x.status === "rejected").reason.code,
              "23514",
            );
          } finally {
            await query(
              "UPDATE cabinet_connections SET status='disconnected',telegram_user_id=NULL WHERE id=$1",
              [connB.id],
            );
            await query(
              "DELETE FROM outreach_telegram_profiles WHERE sender=$1",
              [sender],
            );
          }
        },
      );
      await t.test(
        "administrator account disable closes sessions and revokes tokens without exposing messages",
        async () => {
          const root = await request("/root-login", { body: {} });
          const reserved = await request("/api/cabinet-admin/invites", {
            cookie: root.cookie,
            body: { username: env.authUser, display_name: "Reserved login" },
          });
          assert.equal(reserved.data.error, "login_reserved");
          const accounts = await request("/api/cabinet-admin/accounts", {
            cookie: root.cookie,
          });
          assert.equal(accounts.status, 200);
          assert.ok(!JSON.stringify(accounts.data).includes("password_hash"));
          const result = await request(
            "/api/cabinet-admin/accounts/" + b.p.owner_id + "/disable",
            { cookie: root.cookie, body: {} },
          );
          assert.equal(result.status, 200);
          assert.equal((await request("/api/cabinet/me", ba)).status, 401);
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // This database is disposable and guarded above; never run this suite against production.
      await query(
        "TRUNCATE cabinet_audit,cabinet_plans,cabinet_messages,cabinet_jobs,cabinet_drafts,cabinet_api_tokens,cabinet_campaigns,cabinet_connections,cabinet_sessions,cabinet_invites,cabinet_accounts CASCADE",
      );
      await query("TRUNCATE cabinet_auth_rate_limits");
      await pool.end();
    }
  },
);
