import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createCabinet } from "../src/cabinet/router.js";
import { digest } from "../src/cabinet/security.js";

const url = process.env.CABINET_TEST_DATABASE_URL;
test("Instagram OAuth binds browser + owner session, isolates accounts and secrets, and denies MCP mutation", { skip: !url }, async () => {
  const u = new URL(url);
  assert.ok(["localhost", "127.0.0.1"].includes(u.hostname) && /^\/cabinet_test(?:_[a-z0-9]+)?$/.test(u.pathname));
  const pool = new pg.Pool({ connectionString: url }), query = pool.query.bind(pool);
  const withClient = async fn => { const db = await pool.connect(); try { return await fn(db); } finally { db.release(); } };
  const calls = [], appSecret = "provider-secret-not-for-client", token = "access-token-not-for-client";
  let providerDown = false;
  const cabinet = createCabinet({ query, withClient, env: { cabinetPublicUrl: "https://outreach.example.com", cabinetSecret: "a".repeat(64), instagramAppId: "1234", instagramAppSecret: appSecret },
    instagramRequest: async options => {
      calls.push(options);
      if (providerDown) throw { response: { data: { error: { message: token + appSecret, code: 190 } } } };
      if (options.url.includes("/oauth/access_token")) return { data: { access_token: "short" } };
      if (options.url.endsWith("/access_token")) return { data: { access_token: token, expires_in: 5184000 } };
      return { data: { id: "987654321", user_id: "222222", username: "business_test", name: "Test", account_type: "BUSINESS" } };
    } });
  const app = express(); app.use(express.json()); app.use("/api/cabinet", cabinet.router);
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/cabinet`;
  const owners = [];
  async function owner() {
    const a = (await query("INSERT INTO cabinet_accounts(login,display_name) VALUES($1,'IG Test') RETURNING *", ["ig_" + crypto.randomUUID()])).rows[0];
    owners.push(a.id);
    const s = await cabinet.store.newSession(a);
    return { a, headers: { Cookie: "outreach_cabinet=" + s.raw, "X-CSRF-Token": s.csrf, "Content-Type": "application/json" }, s };
  }
  const get = (path, o) => fetch(base + path, { headers: o.headers, redirect: "manual" });
  const post = (path, o, body = {}) => fetch(base + path, { method: "POST", headers: o.headers, body: JSON.stringify(body), redirect: "manual" });
  async function start(o) {
    const r = await post("/instagram/oauth/start", o); assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
    const data = await r.json(), auth = new URL(data.authorization_url);
    assert.equal(auth.origin, "https://www.instagram.com");
    assert.equal(auth.searchParams.get("scope"), "instagram_business_basic");
    return { state: auth.searchParams.get("state"), cookie: cookie.split(";")[0] };
  }
  const callback = (s, extra = "&code=code-value", cookie = s.cookie) => fetch(base + "/instagram/oauth/callback?state=" + s.state + extra, { headers: { Cookie: cookie }, redirect: "manual" });
  try {
    const a = await owner(), b = await owner();
    assert.equal((await post("/instagram/oauth/start", { headers: { ...a.headers, "X-CSRF-Token": "wrong" } })).status, 403);
    const s = await start(a);
    assert.match((await callback(s, "&code=x", "")).headers.get("location"), /instagram_oauth_expired/);
    assert.equal(calls.length, 0);
    assert.equal((await callback(s)).headers.get("location"), "/cabinet?instagram=connected#instagram");
    assert.match((await callback(s)).headers.get("location"), /instagram_oauth_expired/);
    let r = await get("/instagram", a), body = await r.text();
    assert.ok(!body.includes(token) && !body.includes(appSecret) && !body.includes("token_cipher"));
    const account = JSON.parse(body).accounts[0];
    assert.equal(account.username, "business_test");
    const stored = (await query("SELECT token_cipher FROM cabinet_instagram_connections WHERE owner_id=$1", [a.a.id])).rows[0];
    assert.ok(!stored.token_cipher.includes(token));
    assert.equal((await (await get("/instagram", b)).json()).accounts.length, 0);
    assert.equal((await post(`/instagram/${account.id}/check`, b)).status, 404);
    assert.equal((await post(`/instagram/${account.id}/disconnect`, b)).status, 404);
    const duplicate = await start(b);
    assert.match((await callback(duplicate)).headers.get("location"), /instagram_account_already_managed/);
    assert.equal((await post(`/instagram/${account.id}/check`, a)).status, 200);
    assert.equal(calls.at(-1).headers.Authorization, "Bearer " + token);
    providerDown = true;
    r = await post(`/instagram/${account.id}/check`, a);
    assert.equal(r.status, 502); assert.deepEqual(await r.json(), { error: "instagram_authorization_expired" });
    providerDown = false;
    const apiToken = await cabinet.store.tokenCreate({ kind: "owner", owner_id: a.a.id, actor_key: "session:" + digest(a.s.raw) }, { name: "IG status", scopes: ["instagram:read"], campaign_ids: [] });
    const t = { headers: { Authorization: "Bearer " + apiToken.token, "Content-Type": "application/json" } };
    assert.equal((await get("/instagram", t)).status, 200);
    assert.equal((await get("/campaigns", t)).status, 403);
    assert.equal((await post("/instagram/oauth/start", t)).status, 403);
    assert.equal((await post(`/instagram/${account.id}/disconnect`, t)).status, 403);
    await query("UPDATE cabinet_api_tokens SET scopes=ARRAY['outreach:read']::text[],campaign_ids=ARRAY[gen_random_uuid()] WHERE token_hash=$1", [digest(apiToken.token)]);
    assert.equal((await get("/instagram", t)).status, 403);
    const denied = await start(a);
    assert.match((await callback(denied, "&error=access_denied&error_description=secret")).headers.get("location"), /instagram_oauth_declined/);
    const reset = await start(b), n = calls.length;
    await query("DELETE FROM cabinet_sessions WHERE owner_id=$1", [b.a.id]);
    assert.match((await callback(reset)).headers.get("location"), /cabinet_auth_required/);
    assert.equal(calls.length, n);
    assert.equal((await (await get("/instagram", a)).json()).accounts.length, 1);
    assert.equal((await post(`/instagram/${account.id}/disconnect`, a)).status, 200);
    assert.equal((await (await get("/instagram", a)).json()).accounts.length, 0);
  } finally {
    await new Promise(r => server.close(r));
    for (const id of owners) {
      await query("DELETE FROM cabinet_instagram_oauth WHERE owner_id=$1", [id]);
      await query("DELETE FROM cabinet_instagram_connections WHERE owner_id=$1", [id]);
      await query("DELETE FROM cabinet_api_tokens WHERE owner_id=$1", [id]);
      await query("DELETE FROM cabinet_sessions WHERE owner_id=$1", [id]);
      await query("DELETE FROM cabinet_audit WHERE owner_id=$1", [id]);
      await query("DELETE FROM cabinet_accounts WHERE id=$1", [id]);
    }
    await pool.end();
  }
});
