import crypto from "node:crypto";
import {
  digest,
  randomSecret,
  hashPassword,
  verifyPassword,
  ownerOnly,
  text,
  fail,
} from "./security.js";

export function normalizeEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (
    email.length > 254 ||
    !/^[-a-z0-9.!#$%&'*+/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(
      email,
    ) ||
    email.includes("..")
  )
    throw fail("invalid_email");
  return email;
}
export function createEmailAuth({
  query,
  withClient,
  store,
  env,
  sendEmail,
  onAdminReset = () => {},
  reportError = () => {},
}) {
  const pending = new Set();
  const response = (kind) => ({
    ok: true,
    message:
      kind === "register"
        ? "Проверьте почту и папку «Спам». Если адрес ещё не используется, на него придёт ссылка для создания кабинета."
        : kind === "attach"
          ? "Проверьте почту и папку «Спам». Если адрес доступен для привязки, на него придёт ссылка для подтверждения."
          : "Если кабинет с этой почтой существует, на неё придёт ссылка для восстановления пароля. Проверьте также папку «Спам».",
  });
  const rootEmail = () =>
    env.authRecoveryEmail ? normalizeEmail(env.authRecoveryEmail) : null;
  const available = () =>
    Boolean(env.cabinetAuthMailboxEmail && env.cabinetPublicUrl);
  async function transaction(fn) {
    return withClient(async (db) => {
      await db.query("BEGIN");
      try {
        const result = await fn(db);
        await db.query("COMMIT");
        return result;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    });
  }
  async function rootState() {
    return (
      await query(
        "SELECT password_hash,auth_revision FROM cabinet_admin_recovery WHERE singleton",
      )
    ).rows[0];
  }
  async function adminPassword(password, fallback) {
    const state = await rootState();
    return state?.password_hash
      ? verifyPassword(password, state.password_hash)
      : fallback();
  }
  function deliver(challenge, token) {
    const task = Promise.resolve()
      .then(async () => {
        const url = new URL("/login.html", env.cabinetPublicUrl);
        url.hash = "confirm=" + token;
        await sendEmail({
          to: challenge.email,
          kind: challenge.kind,
          url: url.href,
        });
        await query(
          "UPDATE cabinet_email_challenges SET sent_at=now() WHERE token_hash=$1",
          [digest(token)],
        );
      })
      .catch(async () => {
        // Never put reset URLs, tokens, email addresses or SMTP exception text in logs.
        reportError("cabinet_auth_email_delivery_failed");
        await query(
          "UPDATE cabinet_email_challenges SET used_at=now() WHERE token_hash=$1",
          [digest(token)],
        ).catch(() => {});
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  }
  async function issue({
    kind,
    email,
    owner_id = null,
    display_name = "",
    auth_revision = 0,
  }) {
    if (!available()) throw fail("email_auth_not_configured", 503);
    const token = randomSecret("email_");
    const row = { kind, email, owner_id, display_name, auth_revision };
    await query(
      `INSERT INTO cabinet_email_challenges(token_hash,kind,owner_id,email,display_name,auth_revision,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,now()+CASE WHEN $2='register' THEN interval '1 hour' ELSE interval '30 minutes' END)`,
      [digest(token), kind, owner_id, email, display_name, auth_revision],
    );
    deliver(row, token);
    return response(kind);
  }
  async function register(input) {
    if (!env.cabinetSignupEnabled || !available())
      throw fail("registration_disabled", 503);
    const email = normalizeEmail(input.email),
      name = text(input.display_name, 100);
    if (
      email === rootEmail() ||
      (await query("SELECT 1 FROM cabinet_accounts WHERE email=$1", [email]))
        .rowCount
    )
      return response("register");
    return issue({ kind: "register", email, display_name: name });
  }
  async function recover(input) {
    if (!available()) throw fail("email_auth_not_configured", 503);
    const email = normalizeEmail(input.email);
    if (email === rootEmail()) {
      const state = await rootState();
      return issue({
        kind: "admin_reset",
        email,
        auth_revision: state.auth_revision,
      });
    }
    const {
      rows: [account],
    } = await query(
      "SELECT id,auth_revision FROM cabinet_accounts WHERE email=$1 AND email_verified_at IS NOT NULL AND active AND password_hash IS NOT NULL",
      [email],
    );
    return account
      ? issue({
          kind: "reset",
          email,
          owner_id: account.id,
          auth_revision: account.auth_revision,
        })
      : response("reset");
  }
  async function attach(p, input) {
    ownerOnly(p);
    const email = normalizeEmail(input.email);
    if (
      email === rootEmail() ||
      (
        await query(
          "SELECT 1 FROM cabinet_accounts WHERE email=$1 AND id<>$2",
          [email, p.owner_id],
        )
      ).rowCount
    )
      return response("attach");
    const {
      rows: [a],
    } = await query(
      "SELECT auth_revision FROM cabinet_accounts WHERE id=$1 AND active",
      [p.owner_id],
    );
    if (!a) throw fail("cabinet_auth_required", 401);
    return issue({
      kind: "attach",
      email,
      owner_id: p.owner_id,
      auth_revision: a.auth_revision,
    });
  }
  async function inspect(token) {
    const {
      rows: [c],
    } = await query(
      "SELECT kind,email FROM cabinet_email_challenges WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()",
      [digest(token)],
    );
    if (!c) throw fail("email_link_invalid", 409);
    const [user, domain] = c.email.split("@");
    return { kind: c.kind, email: user.slice(0, 2) + "…@" + domain };
  }
  async function complete({ token, password }, getPrincipal) {
    const found = (
      await query(
        "SELECT * FROM cabinet_email_challenges WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()",
        [digest(token)],
      )
    ).rows[0];
    if (!found) throw fail("email_link_invalid", 409);
    const hash = found.kind === "attach" ? null : await hashPassword(password);
    const principal = found.kind === "attach" ? await getPrincipal() : null;
    if (principal) {
      ownerOnly(principal);
      if (principal.owner_id !== found.owner_id)
        throw fail("email_wrong_account", 403);
    }
    const result = await transaction(async (db) => {
      // Shared ordering with delivery/stop: global -> owner -> challenge. No password-reset race with a send.
      await db.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [
        "outreach_delivery_control",
      ]);
      const lock =
        found.kind === "admin_reset"
          ? "cabinet-admin-auth"
          : found.owner_id
            ? "cabinet:" + found.owner_id
            : "cabinet-email:" + found.email;
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
      const c = (
        await db.query(
          "SELECT * FROM cabinet_email_challenges WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
          [digest(token)],
        )
      ).rows[0];
      if (!c) throw fail("email_link_invalid", 409);
      let account;
      if (c.kind === "register") {
        if (
          !env.cabinetSignupEnabled ||
          c.email === rootEmail() ||
          (
            await db.query("SELECT 1 FROM cabinet_accounts WHERE email=$1", [
              c.email,
            ])
          ).rowCount
        )
          throw fail("email_link_invalid", 409);
        account = (
          await db.query(
            `INSERT INTO cabinet_accounts(login,display_name,email,email_verified_at,password_hash)
     VALUES($1,$2,$3,now(),$4) RETURNING id,login,display_name,email`,
            [
              "u_" + crypto.randomUUID().replaceAll("-", ""),
              c.display_name,
              c.email,
              hash,
            ],
          )
        ).rows[0];
      } else if (c.kind === "admin_reset") {
        if (c.email !== rootEmail()) throw fail("email_link_invalid", 409);
        const changed = await db.query(
          "UPDATE cabinet_admin_recovery SET password_hash=$1,auth_revision=auth_revision+1,updated_at=now() WHERE singleton AND auth_revision=$2 RETURNING auth_revision",
          [hash, c.auth_revision],
        );
        if (!changed.rowCount) throw fail("email_link_invalid", 409);
        account = { admin_revision: changed.rows[0].auth_revision };
      } else {
        const a = (
          await db.query(
            "SELECT * FROM cabinet_accounts WHERE id=$1 AND active AND auth_revision=$2 FOR UPDATE",
            [c.owner_id, c.auth_revision],
          )
        ).rows[0];
        if (!a) throw fail("email_link_invalid", 409);
        if (c.kind === "attach") {
          if (
            c.email === rootEmail() ||
            (
              await db.query(
                "SELECT 1 FROM cabinet_accounts WHERE email=$1 AND id<>$2",
                [c.email, a.id],
              )
            ).rowCount
          )
            throw fail("email_link_invalid", 409);
          await db.query(
            "UPDATE cabinet_accounts SET email=$2,email_verified_at=now(),auth_revision=auth_revision+1 WHERE id=$1",
            [a.id, c.email],
          );
        } else {
          if (a.email !== c.email || !a.email_verified_at)
            throw fail("email_link_invalid", 409);
          await db.query(
            "UPDATE cabinet_accounts SET password_hash=$2,auth_revision=auth_revision+1 WHERE id=$1",
            [a.id, hash],
          );
          await db.query("DELETE FROM cabinet_sessions WHERE owner_id=$1", [
            a.id,
          ]);
          await db.query(
            "UPDATE cabinet_api_tokens SET revoked_at=now() WHERE owner_id=$1",
            [a.id],
          );
          await db.query(
            "UPDATE cabinet_campaigns SET paused=true,revision=revision+1 WHERE owner_id=$1",
            [a.id],
          );
          await db.query(
            "UPDATE cabinet_jobs SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'cancelled' END,error_code='password_reset' WHERE owner_id=$1 AND status IN ('queued','sending')",
            [a.id],
          );
        }
      }
      await db.query(
        "UPDATE cabinet_email_challenges SET used_at=now() WHERE token_hash=$1",
        [c.token_hash],
      );
      return { kind: c.kind, account };
    });
    if (result.kind === "register")
      return {
        kind: result.kind,
        session: await store.newSession(result.account),
      };
    if (result.kind === "admin_reset")
      onAdminReset(result.account.admin_revision);
    return { kind: result.kind, ok: true };
  }
  return {
    register,
    recover,
    attach,
    inspect,
    complete,
    adminPassword,
    rootState,
    available,
    flushEmails: () => Promise.all([...pending]),
  };
}
