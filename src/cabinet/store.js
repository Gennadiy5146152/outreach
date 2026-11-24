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
            "SELECT 1 FROM cabinet_api_tokens WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND expires_at>now()",
            [p.id, p.owner_id],
          )
        ).rowCount
      )
        throw fail("cabinet_auth_required", 401);
      if (
        p.kind === "owner" &&
        !(
          await db.query(
            "SELECT 1 FROM cabinet_sessions WHERE token_hash=$1 AND owner_id=$2 AND expires_at>now()",
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
        `SELECT t.id,t.owner_id,t.scopes,t.campaign_ids,a.login,a.display_name FROM cabinet_api_tokens t
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
    await query(
      "INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,$3,$4)",
      [digest(raw), account.id, csrf, new Date(now().getTime() + 43200000)],
    );
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
      `SELECT c.*,t.status connection_status,t.username,t.heartbeat_at,t.generation connection_generation,t.telegram_user_id,t.error_code connection_error FROM cabinet_campaigns c
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
        [p.owner_id, p.kind === "owner" ? null : p.campaign_ids],
      )
    ).rows;
  }
  async function createCampaign(p, input) {
    ownerOnly(p);
    const connection = uuid(input.connection_id);
    const name = text(input.name, 200);
    const limit = Number(input.daily_limit ?? 10),
      start = String(input.window_start || "09:30"),
      end = String(input.window_end || "11:30");
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
  async function saveDraft(p, id, input) {
    await campaign(p, id, "outreach:draft");
    const body = text(input.body),
      address =
        "https://t.me/" +
        username(String(input.address || "").replace(/^https:\/\/t\.me\//, ""));
    if (
      !/^[1-9]\d{0,18}$/.test(String(input.recipient_id)) ||
      BigInt(input.recipient_id) > 9223372036854775807n
    )
      throw fail("recipient_id_required");
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
      `INSERT INTO cabinet_drafts(owner_id,campaign_id,address,recipient_id,name,body,source_url,permission_kind,permission_evidence)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
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
      ],
    );
    await audit(p, "draft_created", d.id);
    return d;
  }
  async function editDraft(p, id, draftId, input) {
    await campaign(p, id, "outreach:draft");
    uuid(draftId);
    return transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "cabinet:" + p.owner_id,
      ]);
      if (
        (
          await db.query(
            "SELECT 1 FROM cabinet_jobs WHERE owner_id=$1 AND draft_id=$2 AND status IN ('queued','sending','sent','uncertain')",
            [p.owner_id, draftId],
          )
        ).rowCount
      )
        throw fail("draft_already_dispatched", 409);
      const {
        rows: [d],
      } = await db.query(
        "UPDATE cabinet_drafts SET body=$4,updated_at=now() WHERE owner_id=$1 AND campaign_id=$2 AND id=$3 RETURNING *",
        [p.owner_id, id, draftId, text(input.body)],
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
  VALUES($1,$2,$3,'pending_qr',1) RETURNING ${CONNECTION_FIELDS}`,
      [p.owner_id, text(input.label || "@" + sender, 100), sender],
    );
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
    const scopes = [...new Set(input.scopes || [])],
      ids = [...new Set(input.campaign_ids || [])].map(uuid);
    if (
      !scopes.length ||
      scopes.some((x) => !SCOPES.includes(x)) ||
      !ids.length ||
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
      `INSERT INTO cabinet_api_tokens(owner_id,name,token_hash,display_prefix,scopes,campaign_ids,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,display_prefix,scopes,campaign_ids,expires_at`,
      [
        p.owner_id,
        text(input.name, 100),
        digest(token),
        token.slice(0, 10) + "…" + token.slice(-4),
        scopes,
        ids,
        new Date(now().getTime() + days * 86400000),
      ],
    );
    await audit(p, "token_created", saved.id);
    return { ...saved, token };
  }
  async function tokenList(p) {
    ownerOnly(p);
    return (
      await query(
        "SELECT id,name,display_prefix,scopes,campaign_ids,expires_at,revoked_at,last_used_at FROM cabinet_api_tokens WHERE owner_id=$1 ORDER BY created_at DESC",
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
        "SELECT * FROM cabinet_drafts WHERE owner_id=$1 AND campaign_id=$2 AND id=ANY($3::uuid[]) ORDER BY id",
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
            `INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
  async function queue(p, id, page = 1) {
    await campaign(p, id);
    return (
      await query(
        "SELECT id,draft_id,address,body,status,scheduled_at,completed_at,error_code FROM cabinet_jobs WHERE owner_id=$1 AND campaign_id=$2 ORDER BY scheduled_at DESC,id LIMIT 100 OFFSET $3",
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
    createCampaign,
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
    queue,
    messages,
    audit,
  };
}
