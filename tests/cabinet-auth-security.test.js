import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import pg from "pg";
import { createCabinet } from "../src/cabinet/router.js";
import { createAuth } from "../src/http/auth.js";
import { createLoginHandler, authPageRedirect } from "../src/http/login.js";
import { createAuthRateLimiter } from "../src/cabinet/auth-rate-limit.js";
import { digest } from "../src/cabinet/security.js";

test("malformed administrator cookies fail closed", () => {
  const auth = createAuth({
    authUser: "test",
    authPassword: "test-password",
    authSessionSecret: "test-key",
  });
  assert.equal(
    auth.isAuthenticated({ headers: { cookie: "outreach_session=%E0%A4%A" } }),
    false,
  );
  let cookie;
  auth.setAuthCookie({
    setHeader: (_k, v) => {
      cookie = v.split(";")[0];
    },
  });
  assert.equal(
    auth.isAuthenticated({ headers: { cookie: cookie + ".extra" } }),
    false,
  );
});

test("HTTPS login redirects never trust an absolute request target", () => {
  let destination;
  authPageRedirect({
    nodeEnv: "production",
    cabinetPublicUrl: "https://outreach.example.invalid",
  })(
    {
      secure: false,
      method: "GET",
      path: "/login.html",
      originalUrl: "https://untrusted.example.invalid/login.html?next=test",
    },
    { redirect: (_status, url) => (destination = url) },
    () => assert.fail("Expected canonical redirect"),
  );
  assert.equal(
    destination,
    "https://outreach.example.invalid/login.html?next=test",
  );
});

const connectionString = process.env.CABINET_TEST_DATABASE_URL;
test(
  "password security, persistent throttling, reset races and administrator ingress",
  { skip: !connectionString },
  async (t) => {
    const parsed = new URL(connectionString);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
        /^\/cabinet_test(?:_[a-z0-9]+)?$/.test(parsed.pathname),
      "Disposable local database required",
    );
    const pool = new pg.Pool({ connectionString }),
      query = pool.query.bind(pool);
    const withClient = async (fn) => {
      const db = await pool.connect();
      try {
        return await fn(db);
      } finally {
        db.release();
      }
    };
    const prefix = "security-" + crypto.randomUUID().slice(0, 8),
      email = prefix + "@example.invalid";
    const initial = (
      await query("SELECT * FROM cabinet_admin_recovery WHERE singleton")
    ).rows[0];
    let revision = initial.auth_revision,
      ownerId,
      server;
    const messages = [];
    const env = {
      nodeEnv: "production",
      authCookieSecure: true,
      cabinetPublicUrl: "https://outreach.example.invalid",
      cabinetSignupEnabled: true,
      cabinetAuthMailboxEmail: "sender@example.invalid",
      authUser: "security-root",
      authPassword: "Old12345",
      authRecoveryEmail: prefix + "-root@example.invalid",
      authSessionSecret: "local-test-signing-key-only",
    };
    const cabinet = createCabinet({
      query,
      withClient,
      env,
      sendAuthEmail: async (m) => messages.push(m),
      onAdminReset: (r) => (revision = r),
    });
    const auth = createAuth({ ...env, getAdminRevision: () => revision });
    const lastToken = (address) =>
      new URL(messages.filter((m) => m.to === address).at(-1).url).hash.slice(
        "#confirm=".length,
      );
    try {
      await t.test(
        "rate limits remain effective across instances and concurrent requests",
        async () => {
          const scope = prefix + "-persist",
            consume = createAuthRateLimiter({ query });
          await consume(scope, "private-identifier", 2);
          await consume(scope, "private-identifier", 2);
          await assert.rejects(
            createAuthRateLimiter({ query })(scope, "private-identifier", 2),
            (e) => e.code === "too_many_requests" && e.status === 429,
          );
          const row = (
            await query(
              "SELECT * FROM cabinet_auth_rate_limits WHERE bucket_hash=$1",
              [digest("auth:" + scope + ":private-identifier")],
            )
          ).rows[0];
          assert.ok(!JSON.stringify(row).includes("private-identifier"));
          await query(
            "UPDATE cabinet_auth_rate_limits SET expires_at=now()-interval '1 second' WHERE bucket_hash=$1",
            [row.bucket_hash],
          );
          await createAuthRateLimiter({ query })(
            scope,
            "private-identifier",
            2,
          );
          const results = await Promise.allSettled(
            Array.from({ length: 12 }, () =>
              consume(prefix + "-parallel", "same", 3),
            ),
          );
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            3,
          );
          assert.ok(
            results
              .filter((r) => r.status === "rejected")
              .every((r) => r.reason.status === 429),
          );
        },
      );
      await t.test(
        "eight-character passwords work and reset invalidates an in-flight old-password login",
        async () => {
          const invite = await cabinet.store.invite({
            username: prefix,
            display_name: "Security test",
          });
          ownerId = invite.account.id;
          await cabinet.store.activate({
            invite_token: invite.invite_token,
            password: "Old12345",
          });
          await query(
            "UPDATE cabinet_accounts SET email=$2,email_verified_at=now() WHERE id=$1",
            [ownerId, email],
          );
          const snapshot = (
            await query("SELECT * FROM cabinet_accounts WHERE id=$1", [ownerId])
          ).rows[0];
          const oldSession = await cabinet.store.login({
            username: email,
            password: "Old12345",
          });
          await cabinet.emailAuth.recover({ email });
          await cabinet.emailAuth.flushEmails();
          const reset = lastToken(email);
          await assert.rejects(
            cabinet.emailAuth.complete({ token: reset, password: "1234567" }),
            /password_requires_8_characters/,
          );
          assert.equal((await cabinet.emailAuth.inspect(reset)).kind, "reset");
          await cabinet.emailAuth.complete({
            token: reset,
            password: "New12345",
          });
          await assert.rejects(
            cabinet.store.newSession(snapshot),
            (e) => e.code === "invalid_credentials",
          );
          await assert.rejects(
            cabinet.store.authenticate({
              headers: { cookie: "outreach_cabinet=" + oldSession.raw },
            }),
          );
          await assert.rejects(
            cabinet.store.login({ username: email, password: "Old12345" }),
          );
          assert.ok(
            (
              await cabinet.store.login({
                username: email,
                password: "New12345",
              })
            ).raw,
          );
        },
      );
      await t.test(
        "administrator password verification cannot create a current session after a concurrent reset",
        async () => {
          const checked = await cabinet.emailAuth.checkAdminPassword(
            "Old12345",
            () => true,
          );
          assert.equal(checked.valid, true);
          await cabinet.emailAuth.recover({ email: env.authRecoveryEmail });
          await cabinet.emailAuth.flushEmails();
          await cabinet.emailAuth.complete({
            token: lastToken(env.authRecoveryEmail),
            password: "New12345",
          });
          let staleCookie;
          auth.setAuthCookie(
            { setHeader: (_k, v) => (staleCookie = v.split(";")[0]) },
            { revision: checked.revision },
          );
          assert.equal(
            auth.isAuthenticated({ headers: { cookie: staleCookie } }),
            false,
          );
        },
      );
      await t.test(
        "the real shared login handler rejects HTTP and cross-origin administrator login",
        async () => {
          const app = express();
          app.set("trust proxy", "loopback");
          app.use(express.json());
          app.use(authPageRedirect(env));
          app.post(
            "/api/auth/login",
            cabinet.transport,
            async (req, res, next) => {
              try {
                await createLoginHandler({ cabinet, env, ...auth })(req, res);
              } catch (e) {
                next(e);
              }
            },
            cabinet.authErrorHandler,
          );
          server = app.listen(0, "127.0.0.1");
          await new Promise((r) => server.once("listening", r));
          const url =
            "http://127.0.0.1:" + server.address().port + "/api/auth/login";
          const redirect = await fetch(new URL("/login.html", url), {
            redirect: "manual",
            headers: { Host: "untrusted.example.invalid" },
          });
          assert.equal(redirect.status, 308);
          assert.equal(
            redirect.headers.get("location"),
            env.cabinetPublicUrl + "/login.html",
          );
          const post = (headers) =>
            fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...headers },
              body: JSON.stringify({
                username: env.authUser,
                password: "New12345",
              }),
            });
          assert.equal((await post({})).status, 426);
          assert.equal(
            (
              await post({
                "X-Forwarded-Proto": "https",
                Origin: "https://untrusted.example.invalid",
              })
            ).status,
            403,
          );
          const good = await post({
            "X-Forwarded-Proto": "https",
            Origin: env.cabinetPublicUrl,
          });
          assert.equal(good.status, 200);
          assert.match(good.headers.getSetCookie()[0], /; Secure/);
          assert.ok(
            auth.isAuthenticated({
              headers: { cookie: good.headers.getSetCookie()[0].split(";")[0] },
            }),
          );
        },
      );
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
      if (ownerId) {
        await query("DELETE FROM cabinet_email_challenges WHERE owner_id=$1", [
          ownerId,
        ]);
        await query("DELETE FROM cabinet_sessions WHERE owner_id=$1", [
          ownerId,
        ]);
        await query("DELETE FROM cabinet_invites WHERE owner_id=$1", [ownerId]);
        await query("DELETE FROM cabinet_accounts WHERE id=$1", [ownerId]);
      }
      await query("DELETE FROM cabinet_email_challenges WHERE email=$1", [
        env.authRecoveryEmail,
      ]);
      await query(
        "UPDATE cabinet_admin_recovery SET password_hash=$1,auth_revision=$2 WHERE singleton",
        [initial.password_hash, initial.auth_revision],
      );
      await query("TRUNCATE cabinet_auth_rate_limits");
      await pool.end();
    }
  },
);
