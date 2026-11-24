import crypto from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(crypto.scrypt);
export const CABINET_COOKIE = "outreach_cabinet";
export const SCOPES = [
  "outreach:read",
  "outreach:draft",
  "outreach:send",
  "outreach:stop",
];
export function fail(code, status = 400) {
  return Object.assign(new Error(code), { status, code });
}
export const digest = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
export const randomSecret = (prefix = "") =>
  prefix + crypto.randomBytes(32).toString("base64url");
export function equal(a, b) {
  const x = Buffer.from(String(a || "")),
    y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function uuid(value) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(value || ""),
    )
  )
    throw fail("invalid_id");
  return String(value).toLowerCase();
}
export function username(value) {
  const name = String(value || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(name))
    throw fail("invalid_telegram_username");
  return name;
}
export function loginName(value) {
  const name = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_.-]{3,64}$/.test(name)) throw fail("invalid_login");
  return name;
}
export function text(value, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw fail("invalid_text");
  return value.trim();
}
export async function hashPassword(password) {
  if (typeof password !== "string")
    throw fail("password_requires_8_characters");
  if (password.length > 1024) throw fail("password_too_long");
  if (Array.from(password).length < 8)
    throw fail("password_requires_8_characters");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$1$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  const valid =
    parts.length === 4 &&
    parts[0] === "scrypt" &&
    parts[1] === "1" &&
    /^[a-f0-9]{32}$/.test(parts[2]) &&
    /^[a-f0-9]{128}$/.test(parts[3]);
  const salt = valid ? parts[2] : "00000000000000000000000000000000";
  const hash = await scrypt(
    typeof password === "string" ? password.slice(0, 1024) : "",
    salt,
    64,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  );
  return (
    valid &&
    typeof password === "string" &&
    password.length <= 1024 &&
    equal(hash.toString("hex"), parts[3])
  );
}
export function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1));
      } catch {
        return "";
      }
    }
  }
  return "";
}
export function cookie(value, { secure = false, clear = false } = {}) {
  return `${CABINET_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 43200}${secure ? "; Secure" : ""}`;
}
export function assertScope(principal, scope, campaignId) {
  if (principal.kind === "owner") return;
  if (!principal.scopes.includes(scope)) throw fail("scope_denied", 403);
  if (campaignId && !principal.campaign_ids.includes(campaignId))
    throw fail("campaign_not_found", 404);
}
export function ownerOnly(principal) {
  if (principal.kind !== "owner") throw fail("owner_session_required", 403);
}
export function encryptPassword(password, secret) {
  if (!secret || secret.length < 32)
    throw fail("cabinet_secret_not_configured", 503);
  const nonce = crypto.randomBytes(12),
    cipher = crypto.createCipheriv(
      "aes-256-gcm",
      crypto.createHash("sha256").update(secret).digest(),
      nonce,
    );
  if (
    typeof password !== "string" ||
    !password.length ||
    password.length > 1024
  )
    throw fail("invalid_password");
  const encrypted = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString(
    "base64",
  );
}
export function createRateLimiter({
  now = Date.now,
  max = 10,
  windowMs = 900000,
} = {}) {
  const buckets = new Map();
  return (key) => {
    const at = now();
    for (const [k, v] of buckets) if (v.until <= at) buckets.delete(k);
    if (buckets.size >= 10000 && !buckets.has(key))
      throw fail("too_many_requests", 429);
    const b = buckets.get(key) || { n: 0, until: at + windowMs };
    if (++b.n > max) throw fail("too_many_requests", 429);
    buckets.set(key, b);
  };
}
