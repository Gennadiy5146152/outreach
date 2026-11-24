import crypto from "node:crypto";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { assertScope, digest, equal, fail, ownerOnly, randomSecret, readCookie, uuid } from "./security.js";

const COOKIE = "outreach_instagram_oauth";
// Connection only: request no access to Direct until the inbox feature is implemented.
const SCOPES = ["instagram_business_basic"];
const FIELDS = "id,user_id,username,name,account_type";
const PUBLIC_FIELDS = "id,instagram_user_id,username,name,account_type,token_expires_at,connected_at,checked_at";

export function createInstagramConnection({ query, withClient, env, request = axios, now = () => Date.now() }) {
  const secret = env.cabinetSecret || env.authSessionSecret;
  let proxy;
  function configured() {
    return Boolean(env.instagramAppId && env.instagramAppSecret && secret?.length >= 32 && /^https:\/\//.test(env.cabinetPublicUrl || ""));
  }
  function redirectUri() {
    if (!configured()) throw fail("instagram_not_configured", 503);
    return new URL("/api/cabinet/instagram/oauth/callback", env.cabinetPublicUrl).href;
  }
  function options() {
    if (env.instagramProxyUrl && !proxy) {
      const url = new URL(env.instagramProxyUrl);
      if (!["http:", "https:"].includes(url.protocol)) throw fail("instagram_not_configured", 503);
      proxy = new HttpsProxyAgent(url);
    }
    return { timeout: 20000, maxRedirects: 0, ...(proxy ? { httpsAgent: proxy, proxy: false } : {}) };
  }
  async function call(method, url, { token, data, params } = {}) {
    try {
      const result = await request({ ...options(), method, url, params, data,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data instanceof URLSearchParams ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } });
      return result.data;
    } catch (error) {
      // Provider errors can contain tokens, request URLs or secrets; never expose/log them.
      throw fail(error.response?.data?.error?.code === 190 ? "instagram_authorization_expired" : "instagram_provider_error", 502);
    }
  }
  const graph = () => {
    const version = env.instagramApiVersion || "v25.0";
    if (!/^v\d{1,2}\.\d$/.test(version)) throw fail("instagram_not_configured", 503);
    return `https://graph.instagram.com/${version}`;
  };
  function encrypt(token, owner, account) {
    if (typeof token !== "string" || !token || token.length > 16384) throw fail("instagram_provider_error", 502);
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), iv);
    cipher.setAAD(Buffer.from(`${owner}:${account}`));
    return Buffer.concat([iv, cipher.update(token), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  function decrypt(connection) {
    const b = Buffer.from(connection.token_cipher, "base64"), decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(secret).digest(), b.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${connection.owner_id}:${connection.instagram_user_id}`));
    decipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]).toString();
  }
  function oauthCookie(nonce = "") {
    return `${COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/api/cabinet/instagram/oauth; Max-Age=${nonce ? 600 : 0}`;
  }
  async function status(p) {
    assertScope(p, "instagram:read");
    const { rows } = await query(`SELECT ${PUBLIC_FIELDS} FROM cabinet_instagram_connections WHERE owner_id=$1 ORDER BY connected_at DESC`, [p.owner_id]);
    return { configured: configured(), authorization: "instagram_login", accounts: rows.map(r => ({ ...r, status: new Date(r.token_expires_at).getTime() > now() ? "connected" : "expired" })), capabilities: { cold_messages: false, messaging: false } };
  }
  async function start(p) {
    ownerOnly(p);
    const uri = redirectUri(), state = randomSecret(), nonce = randomSecret();
    // A separate Lax cookie binds the cross-site callback to this browser. The cabinet
    // cookie remains Strict; the originating session must still be live at completion.
    await query("DELETE FROM cabinet_instagram_oauth WHERE expires_at<=now() OR session_hash=$1", [p.actor_key.slice(8)]);
    const result = await query(`INSERT INTO cabinet_instagram_oauth(state_hash,nonce_hash,owner_id,session_hash,expires_at)
      SELECT $1,$2,a.id,s.token_hash,now()+interval '10 minutes' FROM cabinet_accounts a JOIN cabinet_sessions s ON s.owner_id=a.id
      WHERE a.id=$3 AND a.active AND s.token_hash=$4 AND s.expires_at>now() RETURNING state_hash`, [digest(state), digest(nonce), p.owner_id, p.actor_key.slice(8)]);
    if (!result.rowCount) throw fail("cabinet_auth_required", 401);
    const url = new URL("https://www.instagram.com/oauth/authorize");
    for (const [k, v] of Object.entries({ client_id: env.instagramAppId, redirect_uri: uri, response_type: "code", scope: SCOPES.join(","), state, force_reauth: "true" })) url.searchParams.set(k, v);
    return { authorization_url: url.href, cookie: oauthCookie(nonce) };
  }
  async function complete(req) {
    const state = req.query.state, nonce = readCookie(req.headers.cookie, COOKIE);
    if (typeof state !== "string" || state.length > 100 || !nonce || nonce.length > 100) throw fail("instagram_oauth_expired");
    const { rows: [pending] } = await query("SELECT * FROM cabinet_instagram_oauth WHERE state_hash=$1 AND expires_at>now()", [digest(state)]);
    if (!pending || !equal(pending.nonce_hash, digest(nonce))) throw fail("instagram_oauth_expired");
    // Single-use, even when the provider declines consent or code exchange fails.
    if (!(await query("DELETE FROM cabinet_instagram_oauth WHERE state_hash=$1 RETURNING owner_id", [digest(state)])).rowCount) throw fail("instagram_oauth_expired");
    if (!(await query(`SELECT 1 FROM cabinet_accounts a JOIN cabinet_sessions s ON s.owner_id=a.id
      WHERE a.id=$1 AND a.active AND s.token_hash=$2 AND s.expires_at>now()`, [pending.owner_id, pending.session_hash])).rowCount) throw fail("cabinet_auth_required", 401);
    if (req.query.error) throw fail("instagram_oauth_declined");
    if (typeof req.query.code !== "string" || !req.query.code || req.query.code.length > 4096) throw fail("instagram_oauth_expired");
    const short = await call("post", "https://api.instagram.com/oauth/access_token", { data: new URLSearchParams({ client_id: env.instagramAppId, client_secret: env.instagramAppSecret, grant_type: "authorization_code", redirect_uri: redirectUri(), code: req.query.code.replace(/#_$/, "") }) });
    if (!short.access_token) throw fail("instagram_provider_error", 502);
    const long = await call("get", "https://graph.instagram.com/access_token", { params: { grant_type: "ig_exchange_token", client_secret: env.instagramAppSecret, access_token: short.access_token } });
    const expires = Number(long.expires_in);
    if (!long.access_token || !Number.isFinite(expires) || expires <= 0) throw fail("instagram_provider_error", 502);
    const profile = await call("get", `${graph()}/me`, { token: long.access_token, params: { fields: FIELDS } });
    const account = String(profile.id || profile.user_id || ""), type = String(profile.account_type || "").toUpperCase();
    if (!/^\d{1,30}$/.test(account) || !/^[\w.]{1,30}$/.test(profile.username || "") || !["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(type)) throw fail("instagram_professional_required");
    await withClient(async db => {
      await db.query("BEGIN");
      try {
        // Same lock as password resets / account disable: an old OAuth flow cannot
        // install credentials after its authorizing session was revoked.
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["cabinet:" + pending.owner_id]);
        const live = await db.query(`SELECT 1 FROM cabinet_accounts a JOIN cabinet_sessions s ON s.owner_id=a.id
          WHERE a.id=$1 AND a.active AND s.token_hash=$2 AND s.expires_at>now()`, [pending.owner_id, pending.session_hash]);
        if (!live.rowCount) throw fail("cabinet_auth_required", 401);
        const saved = await db.query(`INSERT INTO cabinet_instagram_connections(owner_id,instagram_user_id,username,name,account_type,token_cipher,token_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(instagram_user_id) DO UPDATE SET username=excluded.username,name=excluded.name,account_type=excluded.account_type,
          token_cipher=excluded.token_cipher,token_expires_at=excluded.token_expires_at,connected_at=now(),checked_at=now()
          WHERE cabinet_instagram_connections.owner_id=excluded.owner_id RETURNING id`, [pending.owner_id, account, profile.username, String(profile.name || "").slice(0, 200), type, encrypt(long.access_token, pending.owner_id, account), new Date(now() + expires * 1000)]);
        if (!saved.rowCount) throw fail("instagram_account_already_managed", 409);
        await db.query("COMMIT");
      } catch (e) { await db.query("ROLLBACK"); throw e; }
    });
  }
  async function check(p, id) {
    ownerOnly(p); id = uuid(id);
    const { rows: [c] } = await query("SELECT * FROM cabinet_instagram_connections WHERE owner_id=$1 AND id=$2", [p.owner_id, id]);
    if (!c) throw fail("instagram_connection_not_found", 404);
    if (!configured()) throw fail("instagram_not_configured", 503);
    const profile = await call("get", `${graph()}/me`, { token: decrypt(c), params: { fields: FIELDS } });
    if (String(profile.id || profile.user_id) !== c.instagram_user_id) throw fail("instagram_provider_error", 502);
    await query("UPDATE cabinet_instagram_connections SET checked_at=now(),username=$3 WHERE owner_id=$1 AND id=$2 AND token_cipher=$4", [p.owner_id, id, profile.username, c.token_cipher]);
    return { ok: true };
  }
  async function disconnect(p, id) {
    ownerOnly(p);
    const result = await query("DELETE FROM cabinet_instagram_connections WHERE owner_id=$1 AND id=$2", [p.owner_id, uuid(id)]);
    if (!result.rowCount) throw fail("instagram_connection_not_found", 404);
    // Do not revoke Meta-app-wide permissions: the same app may also serve Krasotula.
    return { disconnected: true };
  }
  return { status, start, complete, check, disconnect, oauthCookie };
}
