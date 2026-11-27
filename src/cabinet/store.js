import crypto from "node:crypto";
import {
  assertScope,
  ownerOnly,
  digest,
  randomSecret,
  uuid,
  username,
  loginName,
  text,
  fail,
  hashPassword,
  verifyPassword,
  readCookie,
  CABINET_COOKIE,
  SCOPES,
} from "./security.js";

const CONNECTION_FIELDS =
  "id,label,expected_username,username,telegram_user_id,status,error_code,heartbeat_at,created_at";
const addMinutes = (date, n) => new Date(date.getTime() + n * 60000);
export function scheduleJobs({
  now = new Date(),
  window_start,
  window_end,
  daily_limit,
  occupied = [],
  count,
  random = Math.random,
}) {
  const start = String(window_start).slice(0, 5),
    end = String(window_end).slice(0, 5),
    counts = new Map();
  if (!/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end) || end <= start)
    throw fail("invalid_window");
  for (const job of occupied) {
    const at = new Date(job.slot);
    const key = new Date(at.getTime() + 10800000).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let cursor = addMinutes(now, 1);
  const latest = occupied
    .map((j) => new Date(j.slot))
    .filter((d) => d >= now)
    .sort((a, b) => b - a)[0];
  if (latest) cursor = addMinutes(latest, 3 + random() * 7);
  const slots = [];
  for (let guard = 0; slots.length < count && guard < 37000; guard++) {
    const local = new Date(cursor.getTime() + 10800000),
      day = local.toISOString().slice(0, 10),
      weekday = local.getUTCDay();
    const begin = new Date(`${day}T${start}:00+03:00`),
      finish = new Date(`${day}T${end}:00+03:00`);
    if (
      weekday === 0 ||
      weekday === 6 ||
      cursor >= finish ||
      (counts.get(day) || 0) >= daily_limit
    ) {
      cursor = new Date(begin.getTime() + 86400000);
      continue;
    }
    if (cursor < begin) cursor = begin;
    slots.push(cursor.toISOString());
    counts.set(day, (counts.get(day) || 0) + 1);
    cursor = addMinutes(cursor, 3 + random() * 7);
  }
  if (slots.length !== count) throw fail("schedule_capacity");
  return slots;
}

export function createCabinetStore({
  query,
  withClient,
  now = () => new Date(),
  sendEnabled = false,
}) {
  const q = (db, sql, args = []) =>
    db ? db.query(sql, args) : query(sql, args);
  async function transaction(fn) {
    return withClient(async (db) => {
      await db.query("BEGIN");
      try {
        const r = await fn(db);
        await db.query("COMMIT");
        return r;
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    });
  }
  async function audit(p, action, targetId, db) {
    await q(
      db,
      "INSERT INTO cabinet_audit(owner_id,actor_key,action,target_id) VALUES($1,$2,$3,$4)",
      [p.owner_id, p.actor_key, action, targetId || null],
    );
  }
  async function ownerTransaction(p, fn) {
    return transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [
        "outreach_delivery_control",
      ]);
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "cabinet:" + p.owner_id,
      ]);
      if (
        !(
          await db.query(
            "SELECT 1 FROM cabinet_accounts WHERE id=$1 AND active",
            [p.owner_id],
          )
        ).rowCount
      )
        throw fail("cabinet_auth_required", 401);
      if (
        p.kind === "token" &&
        !(
          await db.query(
            "SELECT 1 FROM cabinet_api_tokens WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
            [p.id, p.owner_id],
          )
        ).rowCount
      )
        throw fail("cabinet_auth_required", 401);
      if (
        p.kind === "owner" &&
        !(
          await db.query(
            "SELECT 1 FROM cabinet_sessions WHERE token_hash=$1 AND owner_id=$2 AND expires_at>clock_timestamp() FOR SHARE",
            [p.actor_key.slice(8), p.owner_id],
          )
        ).rowCount
      )
        throw fail("cabinet_auth_required", 401);
      return fn(db);
    });
  }
  async function authenticate(req) {
    const auth = String(req.headers.authorization || "");
    if (auth) {
      if (!auth.startsWith("Bearer ocp_"))
        throw fail("cabinet_auth_required", 401);
      const {
        rows: [r],
      } = await query(
        `SELECT t.id,t.owner_id,t.scopes,t.campaign_ids,t.all_campaigns,a.login,a.display_name FROM cabinet_api_tokens t
    JOIN cabinet_accounts a ON a.id=t.owner_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now() AND a.active`,
        [digest(auth.slice(7))],
      );
      if (!r) throw fail("cabinet_auth_required", 401);
      await query(
        "UPDATE cabinet_api_tokens SET last_used_at=now() WHERE id=$1",
        [r.id],
      );
      return { ...r, kind: "token", actor_key: "token:" + r.id };
    }
    const token = readCookie(req.headers.cookie, CABINET_COOKIE);
    if (!token) throw fail("cabinet_auth_required", 401);
    const {
      rows: [r],
    } = await query(
      `SELECT a.id owner_id,a.login,a.display_name,a.email,a.email_verified_at,s.csrf FROM cabinet_sessions s JOIN cabinet_accounts a ON a.id=s.owner_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active`,
      [digest(token)],
    );
    if (!r) throw fail("cabinet_auth_required", 401);
    return { ...r, kind: "owner", actor_key: "session:" + digest(token) };
  }
  async function newSession(account) {
    const raw = randomSecret(),
      csrf = randomSecret();
    await transaction(async (db) => {
      // A password reset/disable must not finish between password verification and session creation.
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "cabinet:" + account.id,
      ]);
      const current = (
        await db.query(
          "SELECT active,auth_revision FROM cabinet_accounts WHERE id=$1 FOR UPDATE",
          [account.id],
        )
      ).rows[0];
      if (
        !current?.active ||
        current.auth_revision !== (account.auth_revision ?? 0)
      )
        throw fail("invalid_credentials", 401);
      await db.query(
        "INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,$3,$4)",
        [digest(raw), account.id, csrf, new Date(now().getTime() + 43200000)],
      );
    });
    return {
      raw,
      csrf,
      account: {
        id: account.id,
        login: account.login,
        display_name: account.display_name,
      },
    };
  }
  async function login(input) {
    const name = String(input.username || "")
      .trim()
      .toLowerCase();
    const {
      rows: [a],
    } = await query(
      "SELECT * FROM cabinet_accounts WHERE (login=$1 OR (email=$1 AND email_verified_at IS NOT NULL)) AND active",
      [name],
    );
    const valid = await verifyPassword(input.password, a?.password_hash);
    if (!a || !valid) throw fail("invalid_credentials", 401);
    return newSession(a);
  }
  async function invite({ username: raw, display_name }) {
    const name = loginName(raw),
      token = randomSecret("invite_");
    return transaction(async (db) => {
      const {
        rows: [a],
      } = await db.query(
        "INSERT INTO cabinet_accounts(login,display_name) VALUES($1,$2) RETURNING id,login,display_name",
        [name, text(display_name || name, 100)],
      );
      await db.query(
        "INSERT INTO cabinet_invites(token_hash,owner_id,expires_at) VALUES($1,$2,$3)",
        [digest(token), a.id, new Date(now().getTime() + 86400000)],
      );
      return { account: a, invite_token: token, expires_in_hours: 24 };
    });
  }
  async function activate({ invite_token, password }) {
    const passwordHash = await hashPassword(password);
    const account = await transaction(async (db) => {
      const {
        rows: [i],
      } = await db.query(
        `SELECT i.*,a.active FROM cabinet_invites i JOIN cabinet_accounts a ON a.id=i.owner_id
    WHERE i.token_hash=$1 AND i.used_at IS NULL AND i.expires_at>now() FOR UPDATE OF i`,
        [digest(invite_token)],
      );
      if (!i || !i.active) throw fail("invite_invalid");
      const {
        rows: [a],
      } = await db.query(
        "UPDATE cabinet_accounts SET password_hash=$2 WHERE id=$1 AND password_hash IS NULL RETURNING id,login,display_name",
        [i.owner_id, passwordHash],
      );
      if (!a) throw fail("invite_invalid");
      await db.query(
        "UPDATE cabinet_invites SET used_at=now() WHERE token_hash=$1",
        [i.token_hash],
      );
      return a;
    });
    return newSession(account);
  }
  async function campaign(p, id, scope = "outreach:read", db) {
    id = uuid(id);
    assertScope(p, scope, id);
    const {
      rows: [c],
    } = await q(
      db,
      `SELECT c.*,t.status connection_status,t.username,t.expected_username,t.heartbeat_at,t.generation connection_generation,t.telegram_user_id,t.error_code connection_error FROM cabinet_campaigns c
   JOIN cabinet_connections t ON t.id=c.connection_id AND t.owner_id=c.owner_id WHERE c.owner_id=$1 AND c.id=$2`,
      [p.owner_id, id],
    );
    if (!c) throw fail("campaign_not_found", 404);
    return c;
  }
  async function campaigns(p) {
    assertScope(p, "outreach:read");
    return (
      await query(
        `SELECT c.id,c.name,c.paused,c.daily_limit,c.window_start,c.window_end,t.username,t.status connection_status
   FROM cabinet_campaigns c JOIN cabinet_connections t ON t.id=c.connection_id WHERE c.owner_id=$1 AND ($2::uuid[] IS NULL OR c.id=ANY($2)) ORDER BY c.created_at DESC`,
        [p.owner_id, p.kind === "owner" || p.all_campaigns === true ? null : p.campaign_ids],
      )
    ).rows;
  }
  function assertCampaignCreation(p) {
    assertScope(p, "outreach:draft");
    if (p.kind !== "owner" && p.all_campaigns !== true)
      throw fail("campaign_creation_requires_all_campaigns", 403);
  }
  async function campaignConnections(p) {
    assertCampaignCreation(p);
    return (
      await query(
        "SELECT id,label,username,expected_username,status FROM cabinet_connections WHERE owner_id=$1 ORDER BY created_at DESC",
        [p.owner_id],
      )
    ).rows;
  }
  async function createCampaign(p, input) {
    assertCampaignCreation(p);
    const connection = uuid(input.connection_id);
    const name = text(input.name, 200);
    const limit = Number(input.daily_limit ?? 10),
      start = input.window_start === undefined ? "09:30" : String(input.window_start),
      end = input.window_end === undefined ? "11:30" : String(input.window_end);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)
    )
      throw fail("invalid_schedule");
    if (
      end <= start ||
      Number(end.slice(0, 2)) * 60 +
        Number(end.slice(3)) -
        Number(start.slice(0, 2)) * 60 -
        Number(start.slice(3)) <
        limit * 3
    )
      throw fail("invalid_schedule");
    return ownerTransaction(p, async (db) => {
      if (
        (
          await db.query(
            "SELECT 1 FROM cabinet_campaigns WHERE owner_id=$1 AND connection_id=$2 AND (daily_limit<>$3 OR window_start<>$4::time OR window_end<>$5::time)",
            [p.owner_id, connection, limit, start, end],
          )
        ).rowCount
      )
        throw fail("connection_schedule_conflict", 409);
      const {
        rows: [c],
      } = await db.query(
        `INSERT INTO cabinet_campaigns(owner_id,connection_id,name,daily_limit,window_start,window_end)
   SELECT $1,id,$3,$4,$5,$6 FROM cabinet_connections WHERE id=$2 AND owner_id=$1 RETURNING *`,
        [p.owner_id, connection, name, limit, start, end],
      );
      if (!c) throw fail("connection_not_found", 404);
      await audit(p, "campaign_created", c.id, db);
      return c;
    });
  }
  async function editCampaignWindow(p, id, input) {
    assertCampaignCreation(p);
    if (Object.keys(input).some(k => !["window_start", "window_end"].includes(k)))
      throw fail("invalid_schedule");
    const start = input.window_start, end = input.window_end;
    if (typeof start !== "string" || typeof end !== "string" ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || end <= start)
      throw fail("invalid_schedule");
    return ownerTransaction(p, async db => {
      const c = await campaign(p, id, "outreach:draft", db);
      const minutes = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
      if (minutes(end) - minutes(start) < c.daily_limit * 3)
        throw fail("invalid_schedule");
      if (!c.paused) throw fail("campaign_must_be_paused", 409);
      if ((await db.query("SELECT 1 FROM cabinet_jobs WHERE owner_id=$1 AND connection_id=$2 AND status IN ('queued','sending','uncertain')", [p.owner_id, c.connection_id])).rowCount)
        throw fail("connection_has_outstanding_jobs", 409);
      if ((await db.query("SELECT 1 FROM cabinet_campaigns WHERE owner_id=$1 AND connection_id=$2 AND id<>$3 AND (daily_limit<>$4 OR window_start<>$5::time OR window_end<>$6::time)", [p.owner_id, c.connection_id, c.id, c.daily_limit, start, end])).rowCount)
        throw fail("connection_schedule_conflict", 409);
      const { rows: [updated] } = await db.query("UPDATE cabinet_campaigns SET window_start=$3::time,window_end=$4::time,revision=revision+1 WHERE owner_id=$1 AND id=$2 RETURNING *", [p.owner_id, c.id, start, end]);
      await audit(p, "campaign_window_edited", c.id, db);
      return updated;
    });
  }
  async function drafts(p, id, page = 1) {
    await campaign(p, id);
    const n = Math.max(1, Math.min(10000, Math.trunc(Number(page)) || 1));
    return (
      await query(
        "SELECT * FROM cabinet_drafts WHERE owner_id=$1 AND campaign_id=$2 ORDER BY id LIMIT 100 OFFSET $3",
        [p.owner_id, id, (n - 1) * 100],
      )
    ).rows;
  }
  function recipientSource(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 3 || !Object.hasOwn(value, "chat_id") ||
        !Object.hasOwn(value, "username") || !Object.hasOwn(value, "message_id") ||
        typeof value.chat_id !== "string" || !/^[1-9]\d{0,18}$/.test(value.chat_id) ||
        BigInt(value.chat_id) > 9223372036854775807n ||
        typeof value.username !== "string" || !/^[a-z][a-z0-9_]{4,31}$/.test(value.username) ||
        !Number.isInteger(value.message_id) || value.message_id < 1 || value.message_id > 2147483647)
      throw fail("recipient_source_invalid");
    return { chat_id: value.chat_id, username: value.username, message_id: value.message_id };
  }
  async function saveDraft(p, id, input) {
    await campaign(p, id, "outreach:draft");
    const body = text(input.body);
    const hasSource = Object.hasOwn(input, "recipient_source");
    if (hasSource && Object.hasOwn(input, "address")) throw fail("recipient_address_conflict");
    const sourceRecipient = hasSource ? recipientSource(input.recipient_source) : null;
    if (
      (hasSource && typeof input.recipient_id !== "string") ||
      !/^[1-9]\d{0,18}$/.test(String(input.recipient_id)) ||
      BigInt(input.recipient_id) > 9223372036854775807n
    )
      throw fail("recipient_id_required");
    const address = hasSource ? "tg://user?id=" + input.recipient_id :
      "https://t.me/" + username(String(input.address || "").replace(/^https:\/\/t\.me\//, ""));
    const kind = input.permission_kind || null;
    if (kind && !["request", "consent"].includes(kind))
      throw fail("permission_kind_invalid");
    const evidence = String(input.permission_evidence || "");
    if (evidence.length > 1000) throw fail("permission_evidence_invalid");
    const source = String(input.source_url || "");
    if (source && (!source.startsWith("https://") || source.length > 2000))
      throw fail("source_url_invalid");
    const {
      rows: [d],
    } = await query(
      `INSERT INTO cabinet_drafts(owner_id,campaign_id,address,recipient_id,name,body,source_url,permission_kind,permission_evidence,recipient_source)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        p.owner_id,
        id,
        address,
        String(input.recipient_id),
        String(input.name || "").slice(0, 200),
        body,
        source,
        kind,
        evidence,
        sourceRecipient,
      ],
    );
    await audit(p, "draft_created", d.id);
    return d;
  }
  async function editDraft(p, id, draftId, input) {
    await campaign(p, id, "outreach:draft");
    uuid(draftId);
    const allowed = ["body", "source_url", "permission_kind", "permission_evidence"];
    if (!Object.keys(input).length || Object.keys(input).some(k => !allowed.includes(k)))
      throw fail("draft_edit_invalid");
    const has = key => Object.hasOwn(input, key);
    const body = has("body") ? text(input.body) : null;
    const source = has("source_url") ? input.source_url : null;
    if (has("source_url") && (typeof source !== "string" || !source.startsWith("https://") || source.length > 2000))
      throw fail("source_url_invalid");
    if (has("permission_kind") !== has("permission_evidence"))
      throw fail("permission_pair_required");
    const kind = has("permission_kind") ? input.permission_kind : null;
    const evidence = has("permission_evidence") ? input.permission_evidence : null;
    if (has("permission_kind") && !["request", "consent"].includes(kind))
      throw fail("permission_kind_invalid");
    if (has("permission_evidence") && (typeof evidence !== "string" || evidence.trim().length < 3 || evidence.length > 1000))
      throw fail("permission_evidence_invalid");
    return ownerTransaction(p, async (db) => {
      await campaign(p, id, "outreach:draft", db);
      if ((await db.query(
        "SELECT 1 FROM cabinet_jobs WHERE owner_id=$1 AND draft_id=$2 AND campaign_id=$3 AND status IN ('queued','sending','sent','uncertain')",
        [p.owner_id, draftId, id],
      )).rowCount) throw fail("draft_already_dispatched", 409);
      const { rows: [d] } = await db.query(
        "UPDATE cabinet_drafts SET body=coalesce($4,body),source_url=coalesce($5,source_url),permission_kind=coalesce($6,permission_kind),permission_evidence=coalesce($7,permission_evidence),updated_at=now() WHERE owner_id=$1 AND campaign_id=$2 AND id=$3 RETURNING *",
        [p.owner_id, id, draftId, body, source, kind, evidence],
      );
      if (!d) throw fail("draft_not_found", 404);
      await audit(p, "draft_edited", d.id, db);
      return d;
    });
  }
  async function connections(p) {
    ownerOnly(p);
    return (
      await query(
        `SELECT ${CONNECTION_FIELDS} FROM cabinet_connections WHERE owner_id=$1 ORDER BY created_at DESC`,
        [p.owner_id],
      )
    ).rows;
  }
  async function connect(p, input) {
    ownerOnly(p);
    const sender = username(input.username);
    const {
      rows: [c],
    } = await query(
      `INSERT INTO cabinet_connections(owner_id,label,expected_username,status,generation)
  VALUES($1,$2,$3,'pending_qr',1) ON CONFLICT(owner_id,expected_username) DO NOTHING RETURNING ${CONNECTION_FIELDS}`,
      [p.owner_id, text(input.label || "@" + sender, 100), sender],
    );
    if (!c) {
      const existing = (await query(`SELECT ${CONNECTION_FIELDS},qr_expires_at FROM cabinet_connections WHERE owner_id=$1 AND expected_username=$2`, [p.owner_id, sender])).rows[0];
      if (!existing) throw fail("connection_not_found", 404);
      if (["expired", "error", "disconnected"].includes(existing.status) ||
          (existing.status === "qr_ready" && new Date(existing.qr_expires_at) <= now()))
        return requestQr(p, existing.id);
      return existing;
    }
    await audit(p, "telegram_qr_requested", c.id);
    return c;
  }
  async function qr(p, id) {
    ownerOnly(p);
    const {
      rows: [c],
    } = await query(
      `SELECT status,qr_svg,qr_expires_at,error_code FROM cabinet_connections WHERE owner_id=$1 AND id=$2`,
      [p.owner_id, uuid(id)],
    );
    if (!c) throw fail("connection_not_found", 404);
    if (
      c.status === "qr_ready" &&
      c.qr_expires_at &&
      new Date(c.qr_expires_at) <= now()
    )
      return { status: "expired" };
    return c;
  }
  async function requestQr(p, id) {
    ownerOnly(p);
    return ownerTransaction(p, async (db) => {
      const {
        rows: [c],
      } = await db.query(
        `UPDATE cabinet_connections SET status='pending_qr',generation=generation+1,qr_svg=NULL,qr_expires_at=NULL,password_cipher=NULL,error_code=NULL
   WHERE id=$2 AND owner_id=$1 RETURNING ${CONNECTION_FIELDS}`,
        [p.owner_id, uuid(id)],
      );
      if (!c) throw fail("connection_not_found", 404);
      await db.query(
        "UPDATE cabinet_campaigns SET paused=true,revision=revision+1 WHERE owner_id=$1 AND connection_id=$2",
        [p.owner_id, id],
      );
      await db.query(
        "UPDATE cabinet_jobs SET status='cancelled',error_code='connection_restarted' WHERE owner_id=$1 AND connection_id=$2 AND status='queued'",
        [p.owner_id, id],
      );
      await audit(p, "telegram_qr_requested", c.id, db);
      return c;
    });
  }
  async function disconnect(p, id) {
    ownerOnly(p);
    return ownerTransaction(p, async (db) => {
      const {
        rows: [c],
      } = await db.query(
        `UPDATE cabinet_connections SET status='disconnected',generation=generation+1,qr_svg=NULL,qr_expires_at=NULL,password_cipher=NULL
   WHERE owner_id=$1 AND id=$2 RETURNING id`,
        [p.owner_id, uuid(id)],
      );
      if (!c) throw fail("connection_not_found", 404);
      await db.query(
        "UPDATE cabinet_campaigns SET paused=true,revision=revision+1 WHERE owner_id=$1 AND connection_id=$2",
        [p.owner_id, id],
      );
      await db.query(
        "UPDATE cabinet_jobs SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'cancelled' END WHERE owner_id=$1 AND connection_id=$2 AND status IN ('queued','sending')",
        [p.owner_id, id],
      );
      await audit(p, "telegram_disconnected", id, db);
      return { ok: true };
    });
  }
  async function tokenCreate(p, input) {
    ownerOnly(p);
    const access = input.campaign_access ?? "selected";
    if (!["all", "selected"].includes(access)) throw fail("token_campaign_access_invalid");
    const allCampaigns = access === "all";
    const scopes = [...new Set(input.scopes || [])],
      ids = [...new Set(input.campaign_ids || [])].map(uuid);
    if (
      !scopes.length ||
      scopes.some((x) => !SCOPES.includes(x)) ||
      (scopes.some((s) => s.startsWith("outreach:")) && !allCampaigns && !ids.length) ||
      (allCampaigns && ids.length > 0) ||
      ids.length > 100
    )
      throw fail("token_scope_invalid");
    const owned = (
      await query(
        "SELECT id FROM cabinet_campaigns WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [p.owner_id, ids],
      )
    ).rows;
    if (owned.length !== ids.length) throw fail("campaign_not_found", 404);
    const days = Number(input.expires_in_days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 90)
      throw fail("token_expiry_invalid");
    const token = randomSecret("ocp_");
    const {
      rows: [saved],
    } = await query(
      `INSERT INTO cabinet_api_tokens(owner_id,name,token_hash,display_prefix,scopes,campaign_ids,expires_at,all_campaigns)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,display_prefix,scopes,campaign_ids,expires_at,all_campaigns`,
      [
        p.owner_id,
        text(input.name, 100),
        digest(token),
        token.slice(0, 10) + "…" + token.slice(-4),
        scopes,
        ids,
        new Date(now().getTime() + days * 86400000),
        allCampaigns,
      ],
    );
    await audit(p, "token_created", saved.id);
    return { ...saved, token };
  }
  async function tokenList(p) {
    ownerOnly(p);
    return (
      await query(
        "SELECT id,name,display_prefix,scopes,campaign_ids,all_campaigns,expires_at,revoked_at,last_used_at FROM cabinet_api_tokens WHERE owner_id=$1 ORDER BY created_at DESC",
        [p.owner_id],
      )
    ).rows;
  }
  async function tokenRevoke(p, id) {
    ownerOnly(p);
    const result = await query(
      "UPDATE cabinet_api_tokens SET revoked_at=now() WHERE owner_id=$1 AND id=$2 RETURNING id",
      [p.owner_id, uuid(id)],
    );
    if (!result.rowCount) throw fail("token_not_found", 404);
    await audit(p, "token_revoked", id);
    return { ok: true };
  }
  async function snapshot(p, id, ids, kind, db) {
    const c = await campaign(
      p,
      id,
      kind === "launch" ? "outreach:send" : "outreach:stop",
      db,
    );
    const ds = (
      await q(
        db,
        "SELECT * FROM cabinet_drafts WHERE owner_id=$1 AND campaign_id=$2 AND id=ANY($3::uuid[]) ORDER BY array_position($3::uuid[],id)",
        [p.owner_id, id, ids],
      )
    ).rows;
    const jobs = (
      await q(
        db,
        "SELECT id,draft_id,recipient_id,status,coalesce(attempted_at,scheduled_at) slot FROM cabinet_jobs WHERE owner_id=$1 AND connection_id=$2 AND (status IN ('queued','sending','uncertain') OR coalesce(attempted_at,scheduled_at)>now()-interval '30 days') ORDER BY id",
        [p.owner_id, c.connection_id],
      )
    ).rows;
    return {
      c,
      ds,
      jobs,
      hash: digest(
        JSON.stringify({
          c: {
            id: c.id,
            revision: c.revision,
            paused: c.paused,
            status: c.connection_status,
            connection_error: c.connection_error,
            connection_id: c.connection_id,
            generation: c.connection_generation,
            sender: c.telegram_user_id,
            daily_limit: c.daily_limit,
            window_start: c.window_start,
            window_end: c.window_end,
          },
          ds,
          jobs,
        }),
      ),
    };
  }
  async function prepare(p, id, input, kind = "launch") {
    const ids = [...new Set(input.draft_ids || [])].map(uuid);
    if (!ids.length || ids.length > 500) throw fail("draft_ids_required");
    return ownerTransaction(p, async (db) => {
      const s = await snapshot(p, id, ids, kind, db);
      if (s.ds.length !== ids.length) throw fail("draft_not_found", 404);
      if (kind === "launch") {
        if (!sendEnabled) throw fail("telegram_sending_disabled", 503);
        if (
          ["telegram_rate_limit", "telegram_delivery_uncertain"].includes(
            s.c.connection_error,
          )
        )
          throw fail("telegram_connection_attention_required", 409);
        if (
          s.c.connection_status !== "connected" ||
          !s.c.heartbeat_at ||
          now() - new Date(s.c.heartbeat_at) > 60000
        )
          throw fail("telegram_not_connected", 409);
        const used = new Set(
          s.jobs
            .filter((j) =>
              ["queued", "sending", "sent", "uncertain"].includes(j.status),
            )
            .map((j) => String(j.recipient_id)),
        );
        if (
          s.ds.some(
            (d) =>
              d.stopped ||
              !d.permission_kind ||
              d.permission_evidence.trim().length < 3 ||
              used.has(String(d.recipient_id)),
          )
        )
          throw fail("draft_not_eligible", 409);
      }
      const slots =
        kind === "launch"
          ? scheduleJobs({
              ...s.c,
              now: now(),
              occupied: s.jobs.filter((j) =>
                ["queued", "sending", "sent", "failed", "uncertain"].includes(
                  j.status,
                ),
              ),
              count: ids.length,
            })
          : [];
      const preview = {
        kind,
        campaign_id: id,
        campaign: s.c.name,
        sender: s.c.username,
        daily_limit: s.c.daily_limit,
        window_start: s.c.window_start,
        window_end: s.c.window_end,
        items: s.ds.map((d, i) => ({
          draft_id: d.id,
          address: d.address,
          recipient_id: String(d.recipient_id),
          recipient_source: d.recipient_source,
          body: d.body,
          scheduled_at: slots[i] || null,
        })),
      };
      const token = randomSecret("plan_");
      await db.query(
        "INSERT INTO cabinet_plans(token_hash,owner_id,actor_key,kind,campaign_id,draft_ids,snapshot,preview,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          digest(token),
          p.owner_id,
          p.actor_key,
          kind,
          id,
          ids,
          s.hash,
          preview,
          new Date(now().getTime() + 600000),
        ],
      );
      return {
        confirmation_token: token,
        requires_confirmation: true,
        expires_in_seconds: 600,
        preview,
      };
    });
  }
  async function execute(p, { confirmation_token, confirm, kind }) {
    if (confirm !== true) throw fail("confirmation_required");
    if (!["launch", "stop"].includes(kind))
      throw fail("confirmation_kind_required");
    return ownerTransaction(p, async (db) => {
      const {
        rows: [plan],
      } = await db.query(
        "SELECT * FROM cabinet_plans WHERE token_hash=$1 AND owner_id=$2 AND actor_key=$3 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",
        [digest(confirmation_token), p.owner_id, p.actor_key],
      );
      if (!plan) throw fail("confirmation_invalid", 409);
      if (plan.kind !== kind) throw fail("confirmation_wrong_action", 409);
      const s = await snapshot(
        p,
        plan.campaign_id,
        plan.draft_ids,
        plan.kind,
        db,
      );
      if (s.hash !== plan.snapshot) throw fail("plan_changed", 409);
      if (plan.kind === "launch") {
        if (!sendEnabled) throw fail("telegram_sending_disabled", 503);
        if (
          ["telegram_rate_limit", "telegram_delivery_uncertain"].includes(
            s.c.connection_error,
          )
        )
          throw fail("telegram_connection_attention_required", 409);
        if (
          s.c.connection_status !== "connected" ||
          !s.c.heartbeat_at ||
          now() - new Date(s.c.heartbeat_at) > 60000
        )
          throw fail("telegram_not_connected", 409);
        for (const item of plan.preview.items) {
          if (new Date(item.scheduled_at) < now())
            throw fail("plan_schedule_expired", 409);
          const random =
            BigInt("0x" + crypto.randomBytes(8).toString("hex")) &
            ((1n << 63n) - 1n);
          await db.query(
            `INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at,recipient_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              p.owner_id,
              item.draft_id,
              plan.campaign_id,
              s.c.connection_id,
              item.address,
              item.recipient_id,
              item.body,
              String(random || 1n),
              item.scheduled_at,
              item.recipient_source ?? null,
            ],
          );
        }
        await db.query(
          "UPDATE cabinet_campaigns SET paused=false,revision=revision+1 WHERE owner_id=$1 AND id=$2",
          [p.owner_id, plan.campaign_id],
        );
      } else {
        await db.query(
          "UPDATE cabinet_drafts SET stopped=true,updated_at=now() WHERE owner_id=$1 AND campaign_id=$2 AND id=ANY($3::uuid[])",
          [p.owner_id, plan.campaign_id, plan.draft_ids],
        );
        await db.query(
          "UPDATE cabinet_jobs SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'cancelled' END WHERE owner_id=$1 AND campaign_id=$2 AND draft_id=ANY($3::uuid[]) AND status IN ('queued','sending')",
          [p.owner_id, plan.campaign_id, plan.draft_ids],
        );
        await db.query(
          "UPDATE cabinet_campaigns SET revision=revision+1 WHERE owner_id=$1 AND id=$2",
          [p.owner_id, plan.campaign_id],
        );
      }
      await db.query(
        "UPDATE cabinet_plans SET consumed_at=now() WHERE token_hash=$1",
        [plan.token_hash],
      );
      await audit(p, plan.kind + "_executed", plan.campaign_id, db);
      return { ok: true, kind: plan.kind, count: plan.draft_ids.length };
    });
  }
  const moscowDay = date => new Date(date.getTime() + 10800000).toISOString().slice(0, 10);
  function oneOffAccess(p) {
    assertScope(p, "outreach:send");
    assertScope(p, "outreach:draft");
    if (p.kind !== "owner" && p.all_campaigns !== true)
      throw fail("one_off_requires_all_campaigns", 403);
  }
  function oneOffInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => !["draft_ids", "window_start", "window_end", "daily_limit", "campaign_window_end"].includes(k)) ||
        !Array.isArray(input.draft_ids) || !input.draft_ids.length || input.draft_ids.length > 2 ||
        typeof input.window_start !== "string" || typeof input.window_end !== "string" ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.window_start) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.window_end) || input.window_end <= input.window_start ||
        (input.daily_limit !== undefined && (!Number.isInteger(input.daily_limit) || input.daily_limit < 1 || input.daily_limit > 100)) ||
        (input.campaign_window_end !== undefined && (typeof input.campaign_window_end !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.campaign_window_end))))
      throw fail("one_off_invalid");
    const ids = input.draft_ids.map(uuid);
    if (new Set(ids).size !== ids.length) throw fail("one_off_invalid");
    return { ids, day: moscowDay(now()), start: input.window_start, end: input.window_end,
      permanent_daily_limit: input.daily_limit ?? null, permanent_window_end: input.campaign_window_end ?? null };
  }
  async function oneOffSnapshot(p, id, options, db) {
    oneOffAccess(p);
    let c = await campaign(p, id, "outreach:send", db);
    await db.query("SELECT id FROM cabinet_campaigns WHERE owner_id=$1 AND connection_id=$2 ORDER BY id FOR UPDATE", [p.owner_id, c.connection_id]);
    await db.query("SELECT id FROM cabinet_connections WHERE owner_id=$1 AND id=$2 FOR SHARE", [p.owner_id, c.connection_id]);
    // The worker updates identity and status without taking the owner lock.
    c = await campaign(p, id, "outreach:send", db);
    const ds = (await db.query(
      "SELECT to_jsonb(d) || jsonb_build_object('recipient_id',d.recipient_id::text) draft FROM cabinet_drafts d WHERE owner_id=$1 AND campaign_id=$2 AND id=ANY($3::uuid[]) ORDER BY array_position($3::uuid[],id) FOR UPDATE",
      [p.owner_id, c.id, options.ids],
    )).rows.map(r => r.draft);
    const jobs = (await db.query(
      `SELECT to_jsonb(j) || jsonb_build_object('recipient_id',j.recipient_id::text,'random_id',j.random_id::text) job FROM cabinet_jobs j
       WHERE owner_id=$1 AND connection_id=$2 AND (status IN ('queued','sending','uncertain') OR coalesce(attempted_at,scheduled_at)>$3::timestamptz-interval '30 days') ORDER BY id FOR SHARE`,
      [p.owner_id, c.connection_id, now()],
    )).rows.map(r => r.job);
    const siblings = (await db.query("SELECT id,daily_limit,window_start,window_end FROM cabinet_campaigns WHERE owner_id=$1 AND connection_id=$2 ORDER BY id", [p.owner_id, c.connection_id])).rows;
    const settings = { id: c.id, revision: c.revision, paused: c.paused, name: c.name,
      connection_id: c.connection_id, generation: c.connection_generation, sender: c.telegram_user_id,
      username: c.username, expected_username: c.expected_username,
      status: c.connection_status, error: c.connection_error,
      daily_limit: c.daily_limit, window_start: c.window_start, window_end: c.window_end };
    return { c, ds, jobs, siblings, hash: digest(stableJson({settings, ds, jobs, siblings, options})) };
  }
  function oneOffEligible(s, options) {
    if (!sendEnabled) throw fail("telegram_sending_disabled", 503);
    if (["telegram_rate_limit", "telegram_delivery_uncertain"].includes(s.c.connection_error))
      throw fail("telegram_connection_attention_required", 409);
    if (s.c.connection_status !== "connected" || !s.c.telegram_user_id || !s.c.heartbeat_at || now() - new Date(s.c.heartbeat_at) > 60000)
      throw fail("telegram_not_connected", 409);
    if (s.jobs.some(j => ["queued", "sending", "uncertain"].includes(j.status)))
      throw fail("one_off_outstanding_jobs", 409);
    if (s.ds.length !== options.ids.length) throw fail("draft_not_found", 404);
    const used = new Set(s.jobs.filter(j => ["queued", "sending", "sent", "uncertain"].includes(j.status)).map(j => j.recipient_id));
    if (s.ds.some(d => d.stopped || !d.permission_kind || d.permission_evidence.trim().length < 3 || used.has(d.recipient_id)))
      throw fail("draft_not_eligible", 409);
    const ceiling = options.permanent_daily_limit ?? Math.min(100, s.c.daily_limit + 2);
    if (options.permanent_daily_limit !== null || options.permanent_window_end !== null) {
      const minutes = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
      const limit = options.permanent_daily_limit ?? s.c.daily_limit;
      const end = options.permanent_window_end ?? s.c.window_end;
      if (minutes(end) - minutes(s.c.window_start) < limit * 3) throw fail("one_off_invalid");
      if (s.siblings.some(c => c.id !== s.c.id && (c.daily_limit !== limit ||
          c.window_start !== s.c.window_start || c.window_end.slice(0, 5) !== end.slice(0, 5))))
        throw fail("connection_schedule_conflict", 409);
    }
    return ceiling;
  }
  async function prepareOneOff(p, id, input) {
    oneOffAccess(p);
    id = uuid(id);
    const options = oneOffInput(input);
    return ownerTransaction(p, async db => {
      const s = await oneOffSnapshot(p, id, options, db);
      const ceiling = oneOffEligible(s, options);
      const current = now(), finish = new Date(`${options.day}T${options.end}:00+03:00`);
      if (moscowDay(current) !== options.day || current >= finish) throw fail("one_off_expired", 409);
      // Attempts count even when cancelled; unused cancelled reservations do not.
      const occupied = s.jobs.filter(j => j.attempted_at || ["queued", "sending", "sent", "failed", "uncertain"].includes(j.status))
        .map(j => ({slot: j.attempted_at || j.scheduled_at}));
      if (occupied.filter(j => moscowDay(new Date(j.slot)) === options.day).length + options.ids.length > ceiling)
        throw fail("one_off_capacity", 409);
      // scheduleJobs adds one minute before its first slot. Account for a past
      // attempt too, so the approved first slot itself keeps the worker's gap.
      const lastAttempt = Math.max(0, ...s.jobs.filter(j => j.attempted_at).map(j => new Date(j.attempted_at).getTime()));
      const schedulingNow = new Date(Math.max(current.getTime(), lastAttempt + 120000));
      const slots = scheduleJobs({now: schedulingNow, window_start: options.start, window_end: options.end,
        daily_limit: ceiling, occupied, count: options.ids.length});
      if (slots.some(slot => moscowDay(new Date(slot)) !== options.day || new Date(slot) >= finish))
        throw fail("one_off_capacity", 409);
      const preview = {
        kind: "one_off_launch", campaign_id: id, campaign: s.c.name,
        sender: s.c.username || s.c.expected_username, sender_id: s.c.telegram_user_id,
        connection_id: s.c.connection_id,
        daily_limit: s.c.daily_limit, window_start: s.c.window_start, window_end: s.c.window_end,
        permanent_daily_limit: options.permanent_daily_limit, permanent_window_end: options.permanent_window_end,
        one_off_day: options.day, one_off_window_start: options.start, one_off_window_end: options.end,
        one_off_daily_limit: ceiling,
        items: s.ds.map((d, i) => ({draft_id: d.id, name: d.name, address: d.address,
          recipient_id: d.recipient_id, recipient_source: d.recipient_source, body: d.body, scheduled_at: slots[i]})),
      };
      const token = randomSecret("plan_");
      await db.query(
        "INSERT INTO cabinet_plans(token_hash,owner_id,actor_key,kind,campaign_id,draft_ids,snapshot,preview,expires_at) VALUES($1,$2,$3,'one_off_launch',$4,$5,$6,$7,clock_timestamp()+interval '10 minutes')",
        [digest(token), p.owner_id, p.actor_key, id, options.ids, s.hash, preview],
      );
      return {confirmation_token: token, requires_confirmation: true, expires_in_seconds: 600, preview};
    });
  }
  async function executeOneOff(p, input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => !["confirmation_token", "confirm"].includes(k))) throw fail("one_off_invalid");
    if (input.confirm !== true) throw fail("confirmation_required");
    if (typeof input.confirmation_token !== "string" || input.confirmation_token.length < 20 || input.confirmation_token.length > 200)
      throw fail("confirmation_invalid", 409);
    oneOffAccess(p);
    return ownerTransaction(p, async db => {
      const {rows: [plan]} = await db.query(
        "SELECT * FROM cabinet_plans WHERE token_hash=$1 AND owner_id=$2 AND actor_key=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
        [digest(input.confirmation_token), p.owner_id, p.actor_key],
      );
      if (!plan) throw fail("confirmation_invalid", 409);
      if (plan.kind !== "one_off_launch") throw fail("confirmation_wrong_action", 409);
      const preview = plan.preview;
      const options = {ids: plan.draft_ids, day: preview.one_off_day, start: preview.one_off_window_start,
        end: preview.one_off_window_end, permanent_daily_limit: preview.permanent_daily_limit,
        permanent_window_end: preview.permanent_window_end ?? null};
      const current = now();
      if (moscowDay(current) !== options.day || current >= new Date(`${options.day}T${options.end}:00+03:00`))
        throw fail("one_off_expired", 409);
      const s = await oneOffSnapshot(p, plan.campaign_id, options, db);
      if (s.hash !== plan.snapshot) throw fail("plan_changed", 409);
      const ceiling = oneOffEligible(s, options);
      // Locks may have waited across expiry, a slot or Moscow midnight.
      const checked = now();
      if (moscowDay(checked) !== options.day || checked >= new Date(`${options.day}T${options.end}:00+03:00`))
        throw fail("one_off_expired", 409);
      if (!(await db.query("SELECT 1 FROM cabinet_plans WHERE token_hash=$1 AND expires_at>clock_timestamp()", [plan.token_hash])).rowCount)
        throw fail("confirmation_invalid", 409);
      for (const item of preview.items) {
        if (new Date(item.scheduled_at) < checked) throw fail("plan_schedule_expired", 409);
        const random = BigInt("0x" + crypto.randomBytes(8).toString("hex")) & ((1n << 63n) - 1n);
        await db.query(
          `INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at,
            one_off_day,one_off_window_start,one_off_window_end,one_off_daily_limit,recipient_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [p.owner_id, item.draft_id, plan.campaign_id, s.c.connection_id, item.address, item.recipient_id, item.body,
            String(random || 1n), item.scheduled_at, options.day, options.start, options.end, ceiling, item.recipient_source ?? null],
        );
      }
      await db.query("UPDATE cabinet_campaigns SET daily_limit=coalesce($3,daily_limit),window_end=coalesce($4::time,window_end),paused=false,revision=revision+1 WHERE owner_id=$1 AND id=$2",
        [p.owner_id, plan.campaign_id, options.permanent_daily_limit, options.permanent_window_end]);
      await db.query("UPDATE cabinet_plans SET consumed_at=clock_timestamp() WHERE token_hash=$1", [plan.token_hash]);
      await audit(p, "one_off_launch_executed", plan.campaign_id, db);
      return {ok: true, kind: "one_off_launch", count: plan.draft_ids.length};
    });
  }
  function queueEditItems(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => k !== "items") ||
        !Array.isArray(input.items) || !input.items.length || input.items.length > 100)
      throw fail("queue_edit_invalid");
    const items = input.items.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
          Object.keys(item).length !== 2 || !Object.hasOwn(item, "job_id") ||
          !Object.hasOwn(item, "body")) throw fail("queue_edit_invalid");
      // Validate without trimming: confirmation binds the exact replacement copy.
      text(item.body);
      return { job_id: uuid(item.job_id), body: item.body };
    });
    if (new Set(items.map(i => i.job_id)).size !== items.length)
      throw fail("queue_edit_invalid");
    return items;
  }
  function stableJson(value) {
    if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
    if (value && typeof value === "object")
      return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
    return JSON.stringify(value);
  }
  async function queueEditSnapshot(p, id, items, db) {
    assertScope(p, "outreach:draft", id);
    let c = await campaign(p, id, "outreach:send", db);
    // Hold both settings and selected rows stable through the atomic amendment.
    await db.query("SELECT id FROM cabinet_campaigns WHERE owner_id=$1 AND id=$2 FOR UPDATE", [p.owner_id, c.id]);
    await db.query("SELECT id FROM cabinet_connections WHERE owner_id=$1 AND id=$2 FOR SHARE", [p.owner_id, c.connection_id]);
    // The connection worker can update identity/status without the owner lock.
    // Refresh only after row locks have resolved any concurrent updates.
    c = await campaign(p, id, "outreach:send", db);
    const rows = (await db.query(
      `SELECT to_jsonb(j) || jsonb_build_object('recipient_id',j.recipient_id::text,'random_id',j.random_id::text) job,
              to_jsonb(d) || jsonb_build_object('recipient_id',d.recipient_id::text) draft FROM cabinet_jobs j
       JOIN cabinet_drafts d ON d.id=j.draft_id AND d.campaign_id=j.campaign_id AND d.owner_id=j.owner_id
       WHERE j.owner_id=$1 AND j.campaign_id=$2 AND j.id=ANY($3::uuid[])
       ORDER BY array_position($3::uuid[],j.id) FOR UPDATE OF j,d`,
      [p.owner_id, c.id, items.map(i => i.job_id)],
    )).rows;
    const eligible = rows.length === items.length && rows.every(({job,draft}) =>
      job.status === "queued" && job.connection_id === c.connection_id &&
      job.address === draft.address && String(job.recipient_id) === String(draft.recipient_id) &&
      stableJson(job.recipient_source) === stableJson(draft.recipient_source)) &&
      new Set(rows.map(r => r.draft.id)).size === rows.length;
    // JSONB retains PostgreSQL timestamp precision; canonical key ordering makes
    // the snapshot independent of object/property order and preview round trips.
    const settings = {
      id: c.id, owner_id: c.owner_id, name: c.name, revision: c.revision,
      paused: c.paused, connection_id: c.connection_id,
      generation: c.connection_generation, sender: c.telegram_user_id,
      username: c.username, expected_username: c.expected_username, status: c.connection_status, error: c.connection_error,
      daily_limit: c.daily_limit, window_start: c.window_start, window_end: c.window_end,
    };
    return { c, rows, eligible, hash: digest(stableJson({ settings, rows, items })) };
  }
  async function prepareQueueEdit(p, id, input) {
    id = uuid(id);
    const items = queueEditItems(input);
    return ownerTransaction(p, async db => {
      const s = await queueEditSnapshot(p, id, items, db);
      if (!s.eligible) throw fail("queue_edit_not_eligible", 409);
      const preview = {
        kind: "queue_edit", campaign_id: id, campaign: s.c.name,
        sender: s.c.username || s.c.expected_username,
        sender_id: s.c.telegram_user_id, connection_id: s.c.connection_id,
        items: s.rows.map(({job,draft}, i) => ({
          job_id: job.id, draft_id: draft.id, address: job.address,
          recipient_id: String(job.recipient_id), recipient_source: job.recipient_source, name: draft.name,
          scheduled_at: new Date(job.scheduled_at).toISOString(),
          old_body: job.body, old_draft_body: draft.body, new_body: items[i].body,
        })),
      };
      const token = randomSecret("plan_");
      await db.query(
        "INSERT INTO cabinet_plans(token_hash,owner_id,actor_key,kind,campaign_id,draft_ids,snapshot,preview,expires_at) VALUES($1,$2,$3,'queue_edit',$4,$5,$6,$7,$8)",
        [digest(token), p.owner_id, p.actor_key, id, s.rows.map(r => r.draft.id), s.hash, preview, new Date(now().getTime()+600000)],
      );
      return { confirmation_token: token, requires_confirmation: true, expires_in_seconds: 600, preview };
    });
  }
  async function executeQueueEdit(p, input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => !["confirmation_token", "confirm"].includes(k)))
      throw fail("queue_edit_invalid");
    if (input.confirm !== true) throw fail("confirmation_required");
    if (typeof input.confirmation_token !== "string" || input.confirmation_token.length < 20 || input.confirmation_token.length > 200)
      throw fail("confirmation_invalid", 409);
    assertScope(p, "outreach:send");
    assertScope(p, "outreach:draft");
    return ownerTransaction(p, async db => {
      const { rows: [plan] } = await db.query(
        "SELECT * FROM cabinet_plans WHERE token_hash=$1 AND owner_id=$2 AND actor_key=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
        [digest(input.confirmation_token), p.owner_id, p.actor_key],
      );
      if (!plan) throw fail("confirmation_invalid", 409);
      if (plan.kind !== "queue_edit") throw fail("confirmation_wrong_action", 409);
      const items = queueEditItems({items: plan.preview.items.map(i => ({job_id: i.job_id, body: i.new_body}))});
      const s = await queueEditSnapshot(p, plan.campaign_id, items, db);
      if (!s.eligible || s.hash !== plan.snapshot) throw fail("plan_changed", 409);
      for (let i=0; i<items.length; i++) {
        const {job,draft} = s.rows[i];
        const updated = await db.query(
          "UPDATE cabinet_jobs SET body=$4 WHERE owner_id=$1 AND campaign_id=$2 AND id=$3 AND status='queued' RETURNING id",
          [p.owner_id, plan.campaign_id, job.id, items[i].body],
        );
        if (updated.rowCount !== 1) throw fail("plan_changed", 409);
        const changedDraft = await db.query(
          "UPDATE cabinet_drafts SET body=$4 WHERE owner_id=$1 AND campaign_id=$2 AND id=$3 RETURNING id",
          [p.owner_id, plan.campaign_id, draft.id, items[i].body],
        );
        if (changedDraft.rowCount !== 1) throw fail("plan_changed", 409);
      }
      await db.query("UPDATE cabinet_campaigns SET revision=revision+1 WHERE owner_id=$1 AND id=$2", [p.owner_id, plan.campaign_id]);
      await db.query("UPDATE cabinet_plans SET consumed_at=now() WHERE token_hash=$1", [plan.token_hash]);
      await audit(p, "queued_copy_edited", plan.campaign_id, db);
      return { ok: true, kind: "queue_edit", count: items.length };
    });
  }
  async function queue(p, id, page = 1) {
    await campaign(p, id);
    return (
      await query(
        "SELECT id,draft_id,address,recipient_id::text recipient_id,recipient_source,body,status,scheduled_at,completed_at,error_code FROM cabinet_jobs WHERE owner_id=$1 AND campaign_id=$2 ORDER BY scheduled_at DESC,id LIMIT 100 OFFSET $3",
        [
          p.owner_id,
          id,
          (Math.max(1, Math.min(10000, Math.trunc(Number(page)) || 1)) - 1) *
            100,
        ],
      )
    ).rows;
  }
  async function messages(p, id, jobId) {
    await campaign(p, id);
    const {
      rows: [job],
    } = await query(
      "SELECT id FROM cabinet_jobs WHERE owner_id=$1 AND campaign_id=$2 AND id=$3",
      [p.owner_id, id, uuid(jobId)],
    );
    if (!job) throw fail("thread_not_found", 404);
    return (
      await query(
        `SELECT direction,body,telegram_message_id,reply_to_message_id,sent_at FROM cabinet_messages
   WHERE owner_id=$1 AND job_id=$2 ORDER BY sent_at,id LIMIT 500`,
        [p.owner_id, jobId],
      )
    ).rows;
  }
  return {
    authenticate,
    newSession,
    login,
    invite,
    activate,
    campaign,
    campaigns,
    campaignConnections,
    createCampaign,
    editCampaignWindow,
    drafts,
    saveDraft,
    editDraft,
    connections,
    connect,
    qr,
    requestQr,
    disconnect,
    tokenCreate,
    tokenList,
    tokenRevoke,
    prepare,
    execute,
    prepareOneOff,
    executeOneOff,
    prepareQueueEdit,
    executeQueueEdit,
    queue,
    messages,
    audit,
  };
}
