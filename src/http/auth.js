import crypto from "node:crypto";

export const AUTH_COOKIE = "outreach_session";
const AUTH_TTL_MS = 1000 * 60 * 60 * 12;

export function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function wantsHtml(req) {
  return String(req.headers.accept || "").includes("text/html");
}

function publicPath(req) {
  return req.path === "/login.html"
    || req.path === "/styles.css"
    || req.path === "/api/auth/status"
    || req.path === "/api/auth/login"
    || req.path === "/api/auth/logout"
    || req.path === "/api/health"
    || req.path.startsWith("/t/open/");
}

export function createAuth({
  authUser,
  authPassword,
  authSessionSecret,
  authCookieSecure = false,
  mcpApiToken = "",
  now = () => Date.now(),
}) {
  function authConfigured() {
    return Boolean(authUser && authPassword && authSessionSecret);
  }

  function signPayload(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", authSessionSecret)
      .update(body)
      .digest("base64url");
    return `${body}.${signature}`;
  }

  function verifyAuthToken(token) {
    if (!authConfigured() || !token || !token.includes(".")) return false;
    const [body, signature] = String(token).split(".");
    const expected = crypto
      .createHmac("sha256", authSessionSecret)
      .update(body)
      .digest("base64url");
    if (!timingSafeEqualText(signature, expected)) return false;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return payload.user === authUser && Number(payload.exp) > now();
    } catch {
      return false;
    }
  }

  function isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie);
    return verifyAuthToken(cookies[AUTH_COOKIE]);
  }

  function isMcpAuthenticated(req) {
    if (!mcpApiToken || !String(req.path || "").startsWith("/api/") || String(req.path || "").startsWith("/api/auth/")) {
      return false;
    }
    const authorization = String(req.headers.authorization || "");
    if (!authorization.startsWith("Bearer ")) return false;
    return timingSafeEqualText(authorization.slice("Bearer ".length), mcpApiToken);
  }

  function setAuthCookie(res) {
    const secure = authCookieSecure ? "; Secure" : "";
    const token = signPayload({ user: authUser, exp: now() + AUTH_TTL_MS });
    res.setHeader(
      "Set-Cookie",
      `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}${secure}`,
    );
  }

  function clearAuthCookie(res) {
    res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  function requireAuth(req, res, next) {
    if (publicPath(req)) return next();
    if (isMcpAuthenticated(req)) return next();
    if (!authConfigured()) {
      return wantsHtml(req)
        ? res.redirect("/login.html")
        : res.status(503).json({ error: "auth_not_configured" });
    }
    if (isAuthenticated(req)) return next();
    return wantsHtml(req)
      ? res.redirect("/login.html")
      : res.status(401).json({ error: "auth_required" });
  }

  return {
    authConfigured,
    isAuthenticated,
    isMcpAuthenticated,
    setAuthCookie,
    clearAuthCookie,
    requireAuth,
  };
}
