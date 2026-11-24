import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import express from "express";
import { createCabinet } from "../src/cabinet/router.js";
import { createEmailAuth } from "../src/cabinet/email-auth.js";
import { createAuth } from "../src/http/auth.js";
import { digest } from "../src/cabinet/security.js";
const connectionString = process.env.CABINET_TEST_DATABASE_URL;

test(
  "email confirmation, reset, existing accounts and administrator recovery",
  { skip: !connectionString },
  async (t) => {
    const parsed = new URL(connectionString);
    assert.ok(
      ["localhost", "127.0.0.1"].includes(parsed.hostname) &&
        /^\/cabinet_test(?:_[a-z0-9]+)?$/.test(parsed.pathname),
    );
    const pool = new pg.Pool({ connectionString }),
      query = pool.query.bind(pool),
      withClient = async (fn) => {
        const db = await pool.connect();
        try {
          return await fn(db);
        } finally {
          db.release();
        }
      };
    const prefix = "email-" + crypto.randomUUID().slice(0, 8),
      root = prefix + "-root@example.invalid",
      address = prefix + "-alice@example.invalid",
      other = prefix + "-bob@example.invalid";
    const messages = [];
    let rootRevision = 0;
    const env = {
      nodeEnv: "development",
      cabinetPublicUrl: "http://127.0.0.1:3000",
      cabinetSignupEnabled: true,
      cabinetAuthMailboxEmail: "sender@example.invalid",
      authRecoveryEmail: root,
    };
    const cabinet = createCabinet({
        query,
        withClient,
        env,
        sendAuthEmail: async (message) => messages.push(message),
        onAdminReset: (r) => (rootRevision = r),
      }),
      service = cabinet.emailAuth;
    const token = (email) =>
      new URL(messages.filter((m) => m.to === email).at(-1).url).hash.slice(
        "#confirm=".length,
      );
    const initialAdmin = (await query("SELECT * FROM cabinet_admin_recovery"))
      .rows[0];
    let account, session, principal;
    try {
      await t.test(
        "registration never creates an account or sets a password before email proof",
        async () => {
          const response = await service.register({
            email: address.toUpperCase(),
            display_name: "Алиса",
          });
          await service.flushEmails();
          assert.equal(response.ok, true);
          assert.equal(
            (
              await query("SELECT 1 FROM cabinet_accounts WHERE email=$1", [
                address,
              ])
            ).rowCount,
            0,
          );
          const link = token(address);
          assert.ok(link.startsWith("email_"));
          assert.equal(new URL(messages[0].url).origin, env.cabinetPublicUrl);
          const row = (
            await query(
              "SELECT * FROM cabinet_email_challenges WHERE token_hash=$1",
              [digest(link)],
            )
          ).rows[0];
          assert.equal(row.email, address);
          assert.ok(!JSON.stringify(row).includes(link));
          assert.ok(!("password_hash" in row));
          assert.deepEqual(await service.inspect(link), {
            kind: "register",
            email: address.slice(0, 2) + "…@example.invalid",
          });
          await assert.rejects(
            cabinet.store.login({
              username: address,
              password: "some-password",
            }),
            /invalid_credentials/,
          );
        },
      );
      await t.test(
        "confirmation creates an isolated owner, is one-use, and email login works",
        async () => {
          const result = await service.complete({
            token: token(address),
            password: "alice-long-new-password",
          });
          assert.equal(result.kind, "register");
          session = result.session;
          account = session.account;
          principal = await cabinet.store.authenticate({
            headers: { cookie: "outreach_cabinet=" + session.raw },
          });
          assert.equal(principal.kind, "owner");
          assert.equal(principal.email, address);
          assert.ok(
            (
              await cabinet.store.login({
                username: address.toUpperCase(),
                password: "alice-long-new-password",
              })
            ).raw,
          );
          await assert.rejects(
            service.complete({
              token: token(address),
              password: "malicious-change-password",
            }),
            /email_link_invalid/,
          );
        },
      );
      await t.test(
        "existing and unknown recovery addresses get the same response, without leaking existence",
        async () => {
          const before = messages.length;
          const existing = await service.register({
            email: address,
            display_name: "Someone else",
          });
          await service.flushEmails();
          assert.equal(messages.length, before);
          const absent = await service.recover({
            email: prefix + "-unknown@example.invalid",
          });
          await service.flushEmails();
          assert.equal(existing.ok, true);
          const known = await service.recover({ email: address });
          await service.flushEmails();
          assert.deepEqual(known, absent);
          assert.equal(messages.length, before + 1);
        },
      );
      await t.test(
        "password reset revokes prior sessions and tokens, stops queues, and cannot replay",
        async () => {
          const connection = await cabinet.store.connect(principal, {
            username: "test_email_" + prefix.replaceAll("-", "_"),
          });
          const campaign = await cabinet.store.createCampaign(principal, {
            connection_id: connection.id,
            name: "Reset test",
          });
          const apiToken = await cabinet.store.tokenCreate(principal, {
            name: "To revoke",
            scopes: ["outreach:read"],
            campaign_ids: [campaign.id],
          });
          const draft = await cabinet.store.saveDraft(principal, campaign.id, {
            address: "https://t.me/fake_recipient",
            recipient_id: "92000011",
            body: "Never delivered test",
            permission_kind: "consent",
            permission_evidence: "Local fake test",
          });
          await query(
            "INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at) VALUES($1,$2,$3,$4,'https://t.me/fake_recipient',92000011,'Never sent', $5, now()+interval '1 day')",
            [
              account.id,
              draft.id,
              campaign.id,
              connection.id,
              String(crypto.randomInt(1, 99999999)),
            ],
          );
          const reset = token(address);
          await service.complete({
            token: reset,
            password: "alice-replaced-password",
          });
          await assert.rejects(
            cabinet.store.authenticate({
              headers: { cookie: "outreach_cabinet=" + session.raw },
            }),
            /cabinet_auth_required/,
          );
          await assert.rejects(
            cabinet.store.authenticate({
              headers: { authorization: "Bearer " + apiToken.token },
            }),
            /cabinet_auth_required/,
          );
          await assert.rejects(
            cabinet.store.login({
              username: address,
              password: "alice-long-new-password",
            }),
            /invalid_credentials/,
          );
          session = await cabinet.store.login({
            username: address,
            password: "alice-replaced-password",
          });
          principal = await cabinet.store.authenticate({
            headers: { cookie: "outreach_cabinet=" + session.raw },
          });
          assert.equal(
            (
              await query("SELECT status FROM cabinet_jobs WHERE owner_id=$1", [
                account.id,
              ])
            ).rows[0].status,
            "cancelled",
          );
          await assert.rejects(
            service.complete({
              token: reset,
              password: "replay-password-test",
            }),
            /email_link_invalid/,
          );
        },
      );
      await t.test(
        "expired links and older reset links fail after a successful reset",
        async () => {
          await service.recover({ email: address });
          await service.flushEmails();
          const first = token(address);
          await service.recover({ email: address });
          await service.flushEmails();
          const second = token(address);
          await service.complete({
            token: first,
            password: "alice-newest-password",
          });
          await assert.rejects(
            service.complete({
              token: second,
              password: "old-reset-would-overwrite",
            }),
            /email_link_invalid/,
          );
          await service.recover({ email: address });
          await service.flushEmails();
          const expired = token(address);
          await query(
            "UPDATE cabinet_email_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
            [digest(expired)],
          );
          await assert.rejects(service.inspect(expired), /email_link_invalid/);
        },
      );
      await t.test(
        "email attachment requires the same authenticated owner and preserves uniqueness",
        async () => {
          session = await cabinet.store.login({
            username: address,
            password: "alice-newest-password",
          });
          principal = await cabinet.store.authenticate({
            headers: { cookie: "outreach_cabinet=" + session.raw },
          });
          await assert.rejects(
            service.attach(principal, {
              email: other,
              current_password: "wrong-password",
            }),
            /current_password_invalid/,
          );
          await service.attach(principal, {
            email: other,
            current_password: "alice-newest-password",
          });
          await service.flushEmails();
          const attach = token(other);
          await assert.rejects(
            service.complete({ token: attach }, async () => ({
              ...principal,
              owner_id: crypto.randomUUID(),
            })),
            /email_wrong_account/,
          );
          await assert.rejects(
            service.complete({ token: attach }, async () => ({
              ...principal,
              kind: "token",
            })),
            /owner_session_required/,
          );
          await service.complete({ token: attach }, async () => principal);
          assert.equal(
            (
              await query("SELECT email FROM cabinet_accounts WHERE id=$1", [
                account.id,
              ])
            ).rows[0].email,
            other,
          );
          await assert.rejects(
            cabinet.store.login({
              username: address,
              password: "alice-newest-password",
            }),
            /invalid_credentials/,
          );
          assert.ok(
            (
              await cabinet.store.login({
                username: other,
                password: "alice-newest-password",
              })
            ).raw,
          );
        },
      );
      await t.test(
        "administrator recovery does not create an owner and invalidates old administrator cookies",
        async () => {
          const before = messages.length;
          await service.register({
            email: root,
            display_name: "Do not create a shadow admin",
          });
          await service.flushEmails();
          assert.equal(messages.length, before);
          const auth = createAuth({
            authUser: "legacy-admin",
            authPassword: "old-root-password",
            authSessionSecret: "test-only-root-key",
            getAdminRevision: () => rootRevision,
          });
          let cookie;
          auth.setAuthCookie({
            setHeader: (_key, value) => {
              cookie = value.split(";")[0];
            },
          });
          assert.equal(auth.isAuthenticated({ headers: { cookie } }), true);
          await service.recover({ email: root });
          await service.flushEmails();
          const reset = token(root);
          assert.equal(
            await service.adminPassword("old-root-password", () => true),
            true,
          );
          await service.complete({
            token: reset,
            password: "new-root-recovery-password",
          });
          assert.equal(auth.isAuthenticated({ headers: { cookie } }), false);
          assert.equal(
            await service.adminPassword(
              "new-root-recovery-password",
              () => false,
            ),
            true,
          );
          assert.equal(
            await service.adminPassword("old-root-password", () => true),
            false,
          );
          assert.equal(
            (
              await query("SELECT 1 FROM cabinet_accounts WHERE email=$1", [
                root,
              ])
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        "mail failures invalidate the link and never expose SMTP errors to the caller",
        async () => {
          const failing = createEmailAuth({
            query,
            withClient,
            store: cabinet.store,
            env,
            sendEmail: async () => {
              throw new Error("sensitive SMTP credentials must not leak");
            },
          });
          const response = await failing.register({
            email: prefix + "-failure@example.invalid",
            display_name: "Failure",
          });
          await failing.flushEmails();
          assert.ok(!JSON.stringify(response).includes("SMTP"));
          const rows = (
            await query(
              "SELECT used_at FROM cabinet_email_challenges WHERE email=$1",
              [prefix + "-failure@example.invalid"],
            )
          ).rows;
          assert.ok(rows[0].used_at);
        },
      );
      await t.test(
        "HTTP email endpoints keep tokens private, reject cross-origin requests and limit repeated emails",
        async () => {
          const app = express();
          app.use(express.json());
          app.use("/api/cabinet", cabinet.router);
          const server = app.listen(0, "127.0.0.1");
          await new Promise((resolve) => server.once("listening", resolve));
          const base = "http://127.0.0.1:" + server.address().port;
          const post = async (body, origin) => {
            const res = await fetch(base + "/api/cabinet/auth/register", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(origin ? { Origin: origin } : {}),
              },
              body: JSON.stringify(body),
            });
            return { status: res.status, body: await res.json() };
          };
          try {
            const input = {
              email: prefix + "-http@example.invalid",
              display_name: "HTTP test",
              owner_id: account.id,
            };
            assert.equal(
              (await post(input, "https://attacker.example")).status,
              403,
            );
            for (let n = 0; n < 3; n++) {
              const response = await post(input);
              assert.equal(response.status, 200);
              assert.ok(!JSON.stringify(response.body).includes("email_"));
            }
            assert.equal((await post(input)).status, 429);
            const rows = (
              await query(
                "SELECT owner_id FROM cabinet_email_challenges WHERE email=$1",
                [input.email],
              )
            ).rows;
            assert.ok(rows.every((row) => row.owner_id === null));
            await service.flushEmails();
            env.cabinetSignupEnabled = false;
            assert.equal(
              (
                await post({
                  email: prefix + "-disabled@example.invalid",
                  display_name: "Disabled",
                })
              ).status,
              503,
            );
            env.cabinetSignupEnabled = true;
          } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          }
        },
      );
    } finally {
      await service.flushEmails();
      await query("DELETE FROM cabinet_email_challenges WHERE email LIKE $1", [
        prefix + "%",
      ]);
      if (account) {
        for (const table of [
          "cabinet_audit",
          "cabinet_plans",
          "cabinet_messages",
          "cabinet_jobs",
          "cabinet_drafts",
          "cabinet_api_tokens",
          "cabinet_campaigns",
          "cabinet_connections",
          "cabinet_sessions",
          "cabinet_invites",
        ])
          await query("DELETE FROM " + table + " WHERE owner_id=$1", [
            account.id,
          ]);
        await query("DELETE FROM cabinet_accounts WHERE id=$1", [account.id]);
      }
      await query(
        "UPDATE cabinet_admin_recovery SET password_hash=$1,auth_revision=$2 WHERE singleton",
        [initialAdmin.password_hash, initialAdmin.auth_revision],
      );
      await pool.end();
    }
  },
);
