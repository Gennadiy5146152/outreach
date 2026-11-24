import { timingSafeEqualText } from "./auth.js";
import { fail } from "../cabinet/security.js";

export function authPageRedirect(env) {
  return (req, res, next) => {
    if (
      env.nodeEnv === "production" &&
      String(env.cabinetPublicUrl || "").startsWith("https://") &&
      !req.secure &&
      req.method === "GET" &&
      ["/", "/login.html", "/cabinet", "/cabinet-admin"].includes(req.path)
    ) {
      const destination = new URL(req.path, env.cabinetPublicUrl);
      destination.search = new URL(
        req.originalUrl,
        env.cabinetPublicUrl,
      ).search;
      return res.redirect(308, destination.href);
    }
    next();
  };
}

export function createLoginHandler({
  cabinet,
  env,
  authConfigured,
  setAuthCookie,
  clearAuthCookie,
}) {
  return async (req, res) => {
    cabinet.checkOrigin(req);
    await cabinet.loginLimit(req);
    const username = String(req.body.username || ""),
      password = String(req.body.password || "");
    const rootIdentifier =
      timingSafeEqualText(username, env.authUser) ||
      Boolean(
        env.authRecoveryEmail &&
          timingSafeEqualText(
            username.trim().toLowerCase(),
            env.authRecoveryEmail.trim().toLowerCase(),
          ),
      );
    if (!rootIdentifier) {
      try {
        return res.json(
          cabinet.establish(res, await cabinet.store.login(req.body)),
        );
      } catch (error) {
        clearAuthCookie(res);
        if (error.code === "invalid_credentials")
          return res.status(401).json({ error: "invalid_credentials" });
        throw fail("auth_temporarily_unavailable", 503);
      }
    }
    if (!authConfigured())
      return res.status(503).json({ error: "auth_not_configured" });
    const checked = await cabinet.emailAuth.checkAdminPassword(password, () =>
      timingSafeEqualText(password, env.authPassword),
    );
    if (!checked.valid) {
      clearAuthCookie(res);
      return res.status(401).json({ error: "invalid_credentials" });
    }
    // Sign the revision that was verified, never a newer revision from a concurrent password reset.
    setAuthCookie(res, { revision: checked.revision });
    res.append(
      "Set-Cookie",
      "outreach_cabinet=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    res.json({ ok: true });
  };
}
