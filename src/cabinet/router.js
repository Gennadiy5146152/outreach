import express from "express";
import { createCabinetStore } from "./store.js";
import { createEmailAuth, normalizeEmail } from "./email-auth.js";
import { createAuthMailer } from "./auth-mail.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import { createInstagramConnection } from "./instagram.js";
import {
  cookie,
  readCookie,
  CABINET_COOKIE,
  digest,
  equal,
  ownerOnly,
  encryptPassword,
  createRateLimiter,
  fail,
  uuid,
} from "./security.js";

export function createCabinet({
  query,
  withClient,
  env,
  sendAuthEmail,
  onAdminReset,
  instagramRequest,
}) {
  const store = createCabinetStore({
      query,
      withClient,
      sendEnabled: env.cabinetTelegramSendEnabled === true,
    }),
    router = express.Router(),
    admin = express.Router(),
    limit = createRateLimiter();
  const emailAuth = createEmailAuth({
    query,
    withClient,
    store,
    env,
    sendEmail: sendAuthEmail || createAuthMailer({ query, env }),
    onAdminReset,
    reportError: (code) => console.error(code),
  });
  const authLimit = createAuthRateLimiter({ query });
  const instagram = createInstagramConnection({ query, withClient, env, request: instagramRequest });
  async function loginLimit(req) {
    await authLimit("login-ip", req.ip);
    const name = String(req.body.username || "")
      .trim()
      .toLowerCase();
    let identity = name;
    if (
      name === String(env.authUser || "").toLowerCase() ||
      name === String(env.authRecoveryEmail || "").toLowerCase()
    )
      identity = "administrator";
    else {
      const found = (
        await query(
          "SELECT id FROM cabinet_accounts WHERE login=$1 OR email=$1",
          [name],
        )
      ).rows[0];
      if (found) identity = "owner:" + found.id;
    }
    await authLimit("login-identity", identity, 20);
  }
  async function emailRequest(req, kind) {
    checkOrigin(req);
    await authLimit("email-ip", req.ip);
    const email = normalizeEmail(req.body.email);
    await authLimit(kind + "-email", email, 3);
  }
  const run = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
  function transport(req, res, next) {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    const explicitHttp =
      env.cabinetAllowHttp === true &&
      String(env.cabinetPublicUrl || "").startsWith("http://") &&
      !env.authCookieSecure;
    if (
      !explicitHttp &&
      env.nodeEnv === "production" &&
      (!env.authCookieSecure ||
        !String(env.cabinetPublicUrl || "").startsWith("https://"))
    )
      return next(fail("cabinet_https_not_configured", 503));
    if (!explicitHttp && env.nodeEnv === "production" && !req.secure)
      return next(fail("https_required", 426));
    next();
  }
  function checkOrigin(req) {
    const origin = req.get("origin");
    if (!origin) return;
    const expected = env.cabinetPublicUrl
      ? new URL(env.cabinetPublicUrl).origin
      : `${req.protocol}://${req.get("host")}`;
    if (origin !== expected) throw fail("origin_denied", 403);
  }
  function establish(res, result) {
    res.append(
      "Set-Cookie",
      cookie(result.raw, { secure: env.authCookieSecure }),
    );
    res.append(
      "Set-Cookie",
      "outreach_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    return {
      ok: true,
      redirect: "/cabinet",
      account: result.account,
      csrf: result.csrf,
    };
  }
  router.use(transport);
  // Public cross-site callback: browser binding and live originating session are
  // checked by the OAuth service instead of accepting a general cabinet token.
  router.get("/instagram/oauth/callback", async (req, res) => {
    res.set("Referrer-Policy", "no-referrer");
    let result = "connected";
    try { await instagram.complete(req); }
    catch (e) {
      const safe = ["instagram_oauth_expired", "instagram_oauth_declined", "instagram_not_configured", "instagram_professional_required", "instagram_account_already_managed", "cabinet_auth_required"];
      result = safe.includes(e.code) ? e.code : "instagram_provider_error";
    }
    res.append("Set-Cookie", instagram.oauthCookie());
    res.redirect(303, "/cabinet?instagram=" + result + "#instagram");
  });
  router.get("/auth/options", (_req, res) =>
    res.json({
      registration: env.cabinetSignupEnabled === true && emailAuth.available(),
      recovery: emailAuth.available(),
    }),
  );
  router.post(
    "/auth/register",
    run(async (req, res) => {
      await emailRequest(req, "register");
      res.json(await emailAuth.register(req.body));
    }),
  );
  router.post(
    "/auth/recover",
    run(async (req, res) => {
      await emailRequest(req, "recover");
      res.json(await emailAuth.recover(req.body));
    }),
  );
  router.post(
    "/auth/email/inspect",
    run(async (req, res) => {
      checkOrigin(req);
      await authLimit("email-inspect", req.ip);
      res.json(await emailAuth.inspect(req.body.token));
    }),
  );
  router.post(
    "/auth/email/complete",
    run(async (req, res) => {
      checkOrigin(req);
      await authLimit("email-complete", req.ip);
      await authLimit("email-complete-token", digest(req.body.token));
      const result = await emailAuth.complete(req.body, () =>
        store.authenticate(req),
      );
      if (result.session)
        return res.json({
          ...establish(res, result.session),
          kind: result.kind,
        });
      if (["reset", "admin_reset"].includes(result.kind)) {
        res.append(
          "Set-Cookie",
          cookie("", { clear: true, secure: env.authCookieSecure }),
        );
        if (result.kind === "admin_reset")
          res.append(
            "Set-Cookie",
            "outreach_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
          );
      }
      res.json(result);
    }),
  );
  router.post(
    "/auth/login",
    run(async (req, res) => {
      checkOrigin(req);
      await loginLimit(req);
      res.json(establish(res, await store.login(req.body)));
    }),
  );
  router.post(
    "/auth/activate",
    run(async (req, res) => {
      checkOrigin(req);
      await authLimit("activate", req.ip);
      res.json(establish(res, await store.activate(req.body)));
    }),
  );
  router.use(
    run(async (req, res, next) => {
      req.cabinet = await store.authenticate(req);
      if (
        req.cabinet.kind === "owner" &&
        !["GET", "HEAD", "OPTIONS"].includes(req.method)
      ) {
        checkOrigin(req);
        if (!equal(req.get("x-csrf-token"), req.cabinet.csrf))
          throw fail("csrf_denied", 403);
      }
      next();
    }),
  );
  router.get("/me", (req, res) => {
    const p = req.cabinet;
    res.json({
      login: p.login,
      display_name: p.display_name,
      kind: p.kind,
      ...(p.kind === "owner"
        ? {
            csrf: p.csrf,
            send_enabled: env.cabinetTelegramSendEnabled === true,
            email: p.email || "",
            email_verified: Boolean(p.email_verified_at),
          }
        : { scopes: p.scopes, campaign_ids: p.campaign_ids, all_campaigns: p.all_campaigns === true }),
    });
  });
  router.get("/instagram", run(async (req, res) => res.json(await instagram.status(req.cabinet))));
  router.post("/instagram/oauth/start", run(async (req, res) => {
    ownerOnly(req.cabinet);
    limit("instagram:" + req.cabinet.owner_id);
    const result = await instagram.start(req.cabinet);
    res.append("Set-Cookie", result.cookie);
    res.json({ authorization_url: result.authorization_url });
  }));
  router.post("/instagram/:id/check", run(async (req, res) => {
    ownerOnly(req.cabinet);
    limit("instagram:" + req.cabinet.owner_id);
    res.json(await instagram.check(req.cabinet, req.params.id));
  }));
  router.post("/instagram/:id/disconnect", run(async (req, res) => res.json(await instagram.disconnect(req.cabinet, req.params.id))));
  router.get("/mcp/context", (req, res) =>
    res.json({
      login: req.cabinet.login,
      scopes: req.cabinet.kind === "owner" ? [] : req.cabinet.scopes,
      campaign_ids: req.cabinet.campaign_ids || [],
      all_campaigns: req.cabinet.all_campaigns === true,
    }),
  );
  router.post(
    "/auth/logout",
    run(async (req, res) => {
      ownerOnly(req.cabinet);
      await query("DELETE FROM cabinet_sessions WHERE token_hash=$1", [
        digest(readCookie(req.headers.cookie, CABINET_COOKIE)),
      ]);
      res.append(
        "Set-Cookie",
        cookie("", { clear: true, secure: env.authCookieSecure }),
      );
      res.json({ ok: true });
    }),
  );
  router.post(
    "/profile/email",
    run(async (req, res) => {
      ownerOnly(req.cabinet);
      await authLimit("email-change-password", req.cabinet.owner_id, 5);
      await emailRequest(req, "attach");
      res.json(await emailAuth.attach(req.cabinet, req.body));
    }),
  );
  router.get(
    "/tokens",
    run(async (req, res) => res.json(await store.tokenList(req.cabinet))),
  );
  router.post(
    "/tokens",
    run(async (req, res) =>
      res.status(201).json(await store.tokenCreate(req.cabinet, req.body)),
    ),
  );
  router.post(
    "/tokens/:id/revoke",
    run(async (req, res) =>
      res.json(await store.tokenRevoke(req.cabinet, req.params.id)),
    ),
  );
  router.get(
    "/connections",
    run(async (req, res) => res.json(await store.connections(req.cabinet))),
  );
  router.post(
    "/connections",
    run(async (req, res) =>
      res.status(201).json(await store.connect(req.cabinet, req.body)),
    ),
  );
  router.get(
    "/connections/:id/qr",
    run(async (req, res) =>
      res.json(await store.qr(req.cabinet, req.params.id)),
    ),
  );
  router.post(
    "/connections/:id/qr",
    run(async (req, res) =>
      res.json(await store.requestQr(req.cabinet, req.params.id)),
    ),
  );
  router.post(
    "/connections/:id/disconnect",
    run(async (req, res) =>
      res.json(await store.disconnect(req.cabinet, req.params.id)),
    ),
  );
  router.post(
    "/connections/:id/password",
    run(async (req, res) => {
      ownerOnly(req.cabinet);
      limit("2fa:" + req.cabinet.owner_id);
      const cipher = encryptPassword(req.body.password, env.cabinetSecret);
      const result = await query(
        "UPDATE cabinet_connections SET password_cipher=$3 WHERE owner_id=$1 AND id=$2 AND status='password_required' RETURNING id",
        [req.cabinet.owner_id, uuid(req.params.id), cipher],
      );
      if (!result.rowCount) throw fail("password_not_expected", 409);
      res.json({ ok: true });
    }),
  );
  router.get(
    "/campaigns",
    run(async (req, res) => res.json(await store.campaigns(req.cabinet))),
  );
  router.post(
    "/campaigns",
    run(async (req, res) =>
      res.status(201).json(await store.createCampaign(req.cabinet, req.body)),
    ),
  );
  router.get(
    "/campaigns/:id/drafts",
    run(async (req, res) =>
      res.json(await store.drafts(req.cabinet, req.params.id, req.query.page)),
    ),
  );
  router.post(
    "/campaigns/:id/drafts",
    run(async (req, res) =>
      res
        .status(201)
        .json(await store.saveDraft(req.cabinet, req.params.id, req.body)),
    ),
  );
  router.patch(
    "/campaigns/:id/drafts/:draftId",
    run(async (req, res) =>
      res.json(
        await store.editDraft(
          req.cabinet,
          req.params.id,
          req.params.draftId,
          req.body,
        ),
      ),
    ),
  );
  router.get(
    "/campaigns/:id/queue",
    run(async (req, res) =>
      res.json(await store.queue(req.cabinet, req.params.id, req.query.page)),
    ),
  );
  router.get(
    "/campaigns/:id/threads/:jobId",
    run(async (req, res) =>
      res.json(
        await store.messages(req.cabinet, req.params.id, req.params.jobId),
      ),
    ),
  );
  router.post(
    "/campaigns/:id/launch/prepare",
    run(async (req, res) =>
      res.json(
        await store.prepare(req.cabinet, req.params.id, req.body, "launch"),
      ),
    ),
  );
  router.post(
    "/campaigns/:id/stop/prepare",
    run(async (req, res) =>
      res.json(
        await store.prepare(req.cabinet, req.params.id, req.body, "stop"),
      ),
    ),
  );
  router.post(
    "/execute",
    run(async (req, res) =>
      res.json(await store.execute(req.cabinet, req.body)),
    ),
  );
  router.use((_req, res) =>
    res.status(404).json({ error: "cabinet_route_not_found" }),
  );
  const errorHandler = (error, _req, res, _next) => {
    if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    res.status(error.status || 500).json({
      error: error.status
        ? error.code || error.message
        : "cabinet_internal_error",
    });
  };
  router.use(errorHandler);
  admin.use(transport);
  admin.post(
    "/invites",
    run(async (req, res) => {
      checkOrigin(req);
      limit("invite:" + req.ip);
      if (
        String(req.body.username || "")
          .trim()
          .toLowerCase() ===
        String(env.authUser || "")
          .trim()
          .toLowerCase()
      )
        throw fail("login_reserved");
      res.status(201).json(await store.invite(req.body));
    }),
  );
  admin.post(
    "/accounts/:id/disable",
    run(async (req, res) => {
      checkOrigin(req);
      const id = uuid(req.params.id);
      await withClient(async (db) => {
        await db.query("BEGIN");
        try {
          await db.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [
            "outreach_delivery_control",
          ]);
          await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            "cabinet:" + id,
          ]);
          if (
            !(
              await db.query(
                "UPDATE cabinet_accounts SET active=false WHERE id=$1 RETURNING id",
                [id],
              )
            ).rowCount
          )
            throw fail("account_not_found", 404);
          await db.query("DELETE FROM cabinet_sessions WHERE owner_id=$1", [
            id,
          ]);
          await db.query(
            "UPDATE cabinet_api_tokens SET revoked_at=now() WHERE owner_id=$1",
            [id],
          );
          await db.query(
            "UPDATE cabinet_campaigns SET paused=true,revision=revision+1 WHERE owner_id=$1",
            [id],
          );
          await db.query(
            "UPDATE cabinet_jobs SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'cancelled' END,error_code='account_disabled' WHERE owner_id=$1 AND status IN ('queued','sending')",
            [id],
          );
          await db.query(
            "UPDATE cabinet_connections SET status='disconnected',generation=generation+1,qr_svg=NULL,qr_expires_at=NULL,password_cipher=NULL WHERE owner_id=$1",
            [id],
          );
          await db.query("COMMIT");
        } catch (e) {
          await db.query("ROLLBACK");
          throw e;
        }
      });
      res.json({ ok: true });
    }),
  );
  admin.get(
    "/accounts",
    run(async (_req, res) =>
      res.json(
        (
          await query(
            "SELECT id,login,email,display_name,active,(password_hash IS NOT NULL) activated,created_at FROM cabinet_accounts ORDER BY created_at DESC",
          )
        ).rows,
      ),
    ),
  );
  admin.use(errorHandler);
  return {
    router,
    admin,
    store,
    emailAuth,
    establish,
    checkOrigin,
    limit,
    loginLimit,
    authErrorHandler: errorHandler,
    transport,
  };
}
