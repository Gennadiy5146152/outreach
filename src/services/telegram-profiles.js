import crypto from "node:crypto";
import { createConfirmationStore } from "../mcp/confirmation-store.js";

const COMPANY_BLOCKED = `
WITH candidate AS (
  SELECT lower(btrim($1)) AS company,
         split_part(regexp_replace(lower($2), '^https?://(www[.])?', ''), '/', 1) AS domain
), related AS (
  SELECT l.id, l.email, l.domain, l.status, l.suppressed_at
  FROM leads l CROSS JOIN candidate c
  WHERE lower(btrim(l.company)) = c.company
     OR (c.domain <> '' AND c.domain NOT IN ('vk.com','t.me','tenchat.ru','taplink.cc')
        AND (lower(l.domain) = c.domain OR
          split_part(regexp_replace(lower(coalesce(l.website,'')), '^https?://(www[.])?', ''), '/', 1) = c.domain))
  UNION
  SELECT l.id, l.email, l.domain, l.status, l.suppressed_at
  FROM outreach_channel_contacts contact JOIN leads l ON l.id = contact.lead_id
  WHERE contact.channel = 'telegram' AND contact.address = $3
)
SELECT EXISTS (
  SELECT 1 FROM related r WHERE r.suppressed_at IS NOT NULL OR r.status = 'suppressed'
    OR EXISTS (SELECT 1 FROM suppressions s WHERE lower(s.email) = lower(r.email) OR lower(s.domain) = lower(r.domain))
    OR EXISTS (
      SELECT 1 FROM messages m WHERE m.lead_id = r.id AND (
        (m.direction = 'outbound' AND m.type NOT IN ('test','warmup') AND m.status = 'sent'
          AND coalesce(m.sent_at,m.created_at) >= now() - interval '30 days')
        OR m.reply_classification IN ('negative_reply','unsubscribe','not_target')))
    OR EXISTS (SELECT 1 FROM sending_queue q WHERE q.lead_id = r.id AND q.mode <> 'test'
      AND q.status IN ('pending','retrying','running'))
) OR EXISTS (
  SELECT 1 FROM suppressions s CROSS JOIN candidate c
  WHERE c.domain <> '' AND lower(s.domain) = c.domain
) OR EXISTS (
  SELECT 1 FROM outreach_channel_tasks t
  JOIN outreach_channel_contacts contact ON contact.id = t.contact_id
  WHERE contact.channel = 'telegram'
    AND (contact.address = $4 OR contact.lead_id IN (SELECT id FROM related))
    AND (t.status IN ('waiting','scheduled','declined') OR t.sent_at >= now() - interval '30 days')
) OR EXISTS (
  SELECT 1 FROM outreach_messenger_drafts d CROSS JOIN candidate c
  WHERE d.channel = 'telegram'
    AND (d.address = $5 OR lower(btrim(d.company)) = c.company)
    AND d.sent_at >= now() - interval '30 days'
) AS blocked
`;

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const active = ['pending', 'sending', 'sent', 'uncertain'];
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
export function telegramSender(value) {
  if (typeof value !== 'string') fail('telegram_profile_invalid');
  const sender = value.replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(sender)) fail('telegram_profile_invalid');
  return sender;
}
const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
export function telegramSettings(input) {
  const { label, paused, daily_limit, window_start, window_end } = input;
  if (typeof label !== 'string' || label.length > 100 || label.includes('\0') || typeof paused !== 'boolean'
      || !Number.isInteger(daily_limit) || daily_limit < 1 || daily_limit > 100
      || ![window_start, window_end].every(v => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))
      || minutes(window_end) - minutes(window_start) < daily_limit * 3) fail('telegram_settings_invalid');
  return { label: label.trim(), paused, daily_limit, window_start, window_end };
}
const configuration = p => ({ sender: p.sender, label: p.label, paused: p.paused,
  daily_limit: p.daily_limit, window_start: p.window_start.slice(0, 5), window_end: p.window_end.slice(0, 5), revision: p.revision,
  day_overrides: p.day_overrides || {} });
const connected = p => p.connection_status === 'connected' && p.heartbeat_at && Date.now() - new Date(p.heartbeat_at) < 90000;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nextDay = day => new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

export function telegramRecipient(row) {
  if (!row || !uuid.test(row.draft_id) || !/^[1-9]\d{0,18}$/.test(String(row.recipient_id))
      || BigInt(row.recipient_id) >= 2n ** 63n || !['request', 'consent'].includes(row.permission_kind)
      || typeof row.permission_evidence !== 'string' || row.permission_evidence.trim().length < 3
      || row.permission_evidence.length > 1000 || row.permission_evidence.includes('\0')) fail('telegram_recipient_invalid');
  return { draft_id: row.draft_id, recipient_id: String(row.recipient_id), permission_kind: row.permission_kind,
    permission_evidence: row.permission_evidence.trim() };
}

// Every slot has random jitter, with at least two minutes between messages.
export function telegramSlots(day, profile, randomInt = crypto.randomInt) {
  const start = Date.parse(`${day}T${profile.window_start.slice(0, 5)}:00+03:00`);
  const span = (minutes(profile.window_end) - minutes(profile.window_start)) * 60000;
  const width = Math.floor(span / profile.daily_limit);
  return Array.from({ length: profile.daily_limit }, (_, i) =>
    new Date(start + i * width + randomInt(1000, Math.max(1001, width - 120000))));
}

export function telegramLaunchWindows({day,windows,limit,count,now=new Date()}) {
  if (!Array.isArray(windows) || !windows.length || windows.length>4 || count>limit) fail('telegram_launch_windows_invalid');
  let end='', total=0;
  const slots=[];
  for(const w of windows) {
    if (![w.start,w.end].every(t=>typeof t==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) ||
        !Number.isInteger(w.count) || w.count<1 || w.start<end || minutes(w.end)-minutes(w.start)<w.count*3 ||
        new Date(`${day}T${w.start}:00+03:00`)<=new Date(+now+60000)) fail('telegram_launch_windows_invalid');
    total+=w.count; end=w.end;
    const send_before=new Date(`${day}T${w.end}:00+03:00`).toISOString();
    slots.push(...telegramSlots(day,{daily_limit:w.count,window_start:w.start,window_end:w.end}).map(slot=>({scheduled_at:slot.toISOString(),send_before})));
  }
  if(total!==count) fail('telegram_launch_windows_invalid');
  return {slots,override:{daily_limit:limit,window_start:windows[0].start,window_end:windows.at(-1).end}};
}

export function createTelegramProfiles({ query, withClient, confirmations = createConfirmationStore() }) {
  async function get(sender, db = { query }, lock = false) {
    const { rows: [p] } = await db.query(`SELECT * FROM outreach_telegram_profiles WHERE sender = $1${lock ? ' FOR UPDATE' : ''}`, [telegramSender(sender)]);
    if (!p) fail('telegram_profile_not_found', 404);
    return p;
  }
  async function transaction(fn) {
    return withClient(async db => {
      await db.query('BEGIN');
      try {
        await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('outreach_delivery_control'))");
        await db.query("SELECT pg_advisory_xact_lock(hashtext('outreach_telegram_queue'))");
        const result = await fn(db);
        await db.query('COMMIT');
        return result;
      } catch (e) { await db.query('ROLLBACK'); throw e; }
    });
  }
  async function draft(job, db = { query }, lock = false) {
    const { rows: [d] } = await db.query(`SELECT * FROM outreach_messenger_drafts WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [job.draft_id]);
    return d;
  }
  async function eligible(d, job, db = { query }, ownId = null) {
    if (!d || d.channel !== 'telegram' || !/^https:\/\/t\.me\/[a-z][a-z0-9_]{3,31}$/i.test(d.address)
        || d.partnership || d.technology_product || d.review_reason || d.sent_at) return false;
    const { rows: [company] } = await db.query(COMPANY_BLOCKED, [d.company, d.website, d.address, d.address, d.address]);
    if (company.blocked) return false;
    const { rows: [r] } = await db.query(`SELECT EXISTS (
      SELECT 1 FROM outreach_telegram_deliveries q JOIN outreach_messenger_drafts other ON other.id = q.draft_id
      WHERE q.id IS DISTINCT FROM $5::uuid AND (q.recipient_id = $1 OR lower(q.address) = lower($2) OR lower(btrim(other.company)) = lower(btrim($3))
        OR ($4 <> '' AND other.website = $4))
        AND (q.status IN ('pending','sending','uncertain') OR (q.status = 'sent' AND q.completed_at >= now() - interval '30 days'))
    ) AS blocked`, [job.recipient_id, d.address, d.company, d.website, ownId]);
    return !r.blocked;
  }
  async function dayUsage(sender, day, db = { query }, exclude = []) {
    const { rows } = await db.query(`SELECT scheduled_at, attempted_at FROM outreach_telegram_deliveries
      WHERE sender = $1 AND id <> ALL($4::uuid[]) AND ((status = ANY($3::text[]) AND (scheduled_at AT TIME ZONE 'Europe/Moscow')::date = $2)
        OR (attempted_at AT TIME ZONE 'Europe/Moscow')::date = $2)`, [sender, day, active, exclude]);
    return rows;
  }
  function ready(p) {
    if (p.paused) fail('telegram_profile_paused', 409);
    if (!connected(p)) fail('telegram_profile_not_connected', 409);
  }
  async function pending(sender, db = { query }, lock = false) {
    const { rows } = await db.query(`SELECT * FROM outreach_telegram_deliveries
      WHERE sender=$1 AND status='pending' ORDER BY scheduled_at,id${lock ? ' FOR UPDATE' : ''}`, [sender]);
    return rows;
  }
  return {
    get,
    async list() {
      const { rows } = await query(`SELECT p.*,
        (SELECT count(*)::int FROM outreach_telegram_deliveries q WHERE q.sender = p.sender AND q.status = 'pending') AS pending,
        (SELECT count(*)::int FROM outreach_telegram_deliveries q WHERE q.sender = p.sender AND q.status = 'sent'
          AND (q.completed_at AT TIME ZONE 'Europe/Moscow')::date = (now() AT TIME ZONE 'Europe/Moscow')::date) AS sent_today
        FROM outreach_telegram_profiles p ORDER BY p.created_at, p.sender`);
      return rows.map(p => ({ ...p, effective_settings: p.day_overrides?.[today()] || {
        daily_limit:p.daily_limit,window_start:p.window_start,window_end:p.window_end },
        connection_status: p.connection_status === 'connected' && !connected(p) ? 'offline' : p.connection_status, timezone: 'Europe/Moscow' }));
    },
    async create({ sender, label = '' }) {
      const account = telegramSender(sender);
      if (typeof label !== 'string' || label.length > 100 || label.includes('\0')) fail('telegram_profile_invalid');
      const { rows: [p] } = await query(`INSERT INTO outreach_telegram_profiles(sender,label) VALUES ($1,$2)
        ON CONFLICT (sender) DO NOTHING RETURNING *`, [account, label.trim()]);
      if (!p) fail('telegram_profile_exists', 409);
      return p;
    },
    async settingsPrepare(sender, values) {
      const p = await get(sender);
      const settings = telegramSettings(values);
      return confirmations.prepare({ operation: 'telegram_settings', payload: { sender: p.sender, settings },
        snapshot: configuration(p), summary: `@${p.sender}: ${settings.daily_limit} сообщений в день, ${settings.window_start}–${settings.window_end} МСК; ${settings.paused ? 'пауза' : 'работает'}. Существующие задания сохраняют назначенные даты.`,
        preview: { current: configuration(p), settings } });
    },
    async settingsExecute(token) {
      const plan = confirmations.claim({ token, operation: 'telegram_settings', confirm: true });
      return transaction(async db => {
        const p = await get(plan.payload.sender, db, true);
        confirmations.verify({ plan, currentSnapshot: configuration(p) });
        if (!plan.payload.settings.paused && !connected(p)) fail('telegram_profile_not_connected', 409);
        const s = plan.payload.settings;
        const { rows: [saved] } = await db.query(`UPDATE outreach_telegram_profiles SET label=$2, paused=$3, daily_limit=$4,
          window_start=$5, window_end=$6, revision=revision+1, updated_at=now() WHERE sender=$1 RETURNING *`,
        [p.sender, s.label, s.paused, s.daily_limit, s.window_start, s.window_end]);
        return saved;
      });
    },
    async queueList({ sender = '', status = '', page = 1, pageSize = 50 } = {}) {
      if (sender) sender = telegramSender(sender);
      if (status && !['pending','sending','sent','skipped','failed','uncertain','cancelled'].includes(status)) fail('telegram_queue_filter_invalid');
      page = Number(page); pageSize = Number(pageSize);
      if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 5 || pageSize > 100) fail('telegram_queue_filter_invalid');
      const params = [sender, status];
      const where = `WHERE ($1 = '' OR q.sender = $1) AND ($2 = '' OR q.status = $2)`;
      const { rows: [count] } = await query(`SELECT count(*)::int AS total FROM outreach_telegram_deliveries q ${where}`, params);
      const { rows: items } = await query(`SELECT q.*, d.name, d.company FROM outreach_telegram_deliveries q
        JOIN outreach_messenger_drafts d ON d.id=q.draft_id ${where}
        ORDER BY (q.status IN ('pending','sending')) DESC, q.scheduled_at, q.id LIMIT $3 OFFSET $4`, [...params, pageSize, (page-1)*pageSize]);
      return { items, total: count.total, page, pageSize };
    },
    async resumePrepare({ sender, today_windows = [], daily_limit }) {
      const p = await get(sender);
      const normal = {...p,...telegramSettings({...configuration(p),daily_limit:daily_limit ?? p.daily_limit})};
      if (!connected(p)) fail('telegram_profile_not_connected',409);
      if (!Array.isArray(today_windows) || today_windows.length > 4) fail('telegram_resume_windows_invalid');
      const day = today(), windows = today_windows.map(w => ({ start:new Date(w.start),end:new Date(w.end),count:w.count }));
      let previousEnd = 0;
      for (const w of windows) {
        if (!Number.isFinite(+w.start) || !Number.isFinite(+w.end) || !Number.isInteger(w.count) || w.count < 1
          || +w.start <= Date.now()+60000 || +w.start < previousEnd || +w.end-+w.start < w.count*180000
          || [w.start,w.end].some(t=>new Date(+t+10800000).toISOString().slice(0,10)!==day)) fail('telegram_resume_windows_invalid');
        previousEnd=+w.end;
      }
      const totalToday = windows.reduce((n,w)=>n+w.count,0);
      if (totalToday > 100) fail('telegram_resume_windows_invalid');
      const rows = await pending(p.sender);
      if (!rows.length || rows.length > 500 || rows.some(q=>q.attempted_at)) fail('telegram_resume_queue_invalid',409);
      const jobs=[],excluded=[];
      for (const q of rows) {
        telegramRecipient(q);
        const d = await draft(q);
        if (!await eligible(d,q,{query},q.id) || d.address!==q.address || d.body!==q.body) {
          excluded.push({id:q.id,address:q.address,reason:'draft_or_contact_changed'}); continue;
        }
        jobs.push({...q,name:d.name,company:d.company});
      }
      if (!jobs.length || totalToday > jobs.length) fail('telegram_resume_no_eligible_contacts',409);
      const ids = rows.map(q=>q.id);
      const usedToday = await dayUsage(p.sender,day,{query},ids);
      const override = totalToday ? {
        daily_limit:totalToday+usedToday.length,
        window_start:new Date(+windows[0].start+10800000).toISOString().slice(11,16),
        window_end:new Date(+windows.at(-1).end+10800000).toISOString().slice(11,16),
      } : null;
      if (override?.daily_limit>100) fail('telegram_resume_windows_invalid');
      let index=0;
      for (const w of windows) {
        const width=Math.floor((+w.end-+w.start)/w.count);
        for (let i=0;i<w.count;i++) {
          const slot=new Date(+w.start+i*width+crypto.randomInt(1000,width-120000));
          if (usedToday.some(r=>[r.scheduled_at,r.attempted_at].some(t=>t && Math.abs(new Date(t)-slot)<120000))) fail('telegram_resume_slot_busy',409);
          Object.assign(jobs[index++],{scheduled_at:slot.toISOString(),send_before:w.end.toISOString()});
        }
      }
      for (let d=nextDay(day),attempts=0;index<jobs.length && attempts<730;d=nextDay(d),attempts++) {
        const effective={...normal,...p.day_overrides?.[d]};
        const used=await dayUsage(p.sender,d,{query},ids);
        let remaining=Math.max(0,effective.daily_limit-used.length);
        for (const slot of telegramSlots(d,effective)) {
          if (!remaining || index===jobs.length) break;
          if (used.some(r=>[r.scheduled_at,r.attempted_at].some(t=>t && Math.abs(new Date(t)-slot)<120000))) continue;
          Object.assign(jobs[index++],{scheduled_at:slot.toISOString(),send_before:new Date(`${d}T${effective.window_end.slice(0,5)}:00+03:00`).toISOString()});
          remaining--;
        }
      }
      if (index!==jobs.length) fail('telegram_schedule_unavailable',409);
      const payload={sender:p.sender,jobs,excluded,day,override,windows:today_windows,daily_limit:normal.daily_limit};
      return confirmations.prepare({operation:'telegram_resume',payload,snapshot:{profile:configuration(p),rows},
        summary:`@${p.sender}: возобновить ${jobs.length} сообщений, пропустить ${excluded.length}. Сегодня ${totalToday}; далее ${normal.daily_limit}/день, ${p.window_start.slice(0,5)}–${p.window_end.slice(0,5)} МСК. Получатели и тексты сохранены.`,preview:payload});
    },
    async resumeExecute(token) {
      const plan=confirmations.claim({token,operation:'telegram_resume',confirm:true});
      return transaction(async db=>{
        const p=await get(plan.payload.sender,db,true),rows=await pending(p.sender,db,true);
        confirmations.verify({plan,currentSnapshot:{profile:configuration(p),rows}});
        if (!connected(p) || plan.payload.day!==today()) fail('telegram_plan_changed',409);
        const normal={...p,daily_limit:plan.payload.daily_limit};
        const ids=rows.map(q=>q.id),planned=[];
        for (const job of plan.payload.jobs) {
          const d=await draft(job,db,true),stamp=new Date(job.scheduled_at);
          if (stamp<=new Date() || !await eligible(d,job,db,job.id) || d.body!==job.body || d.address!==job.address) fail('telegram_plan_changed',409);
          const day=new Date(+stamp+10800000).toISOString().slice(0,10);
          const effective=day===plan.payload.day && plan.payload.override ? {...normal,...plan.payload.override} : {...normal,...p.day_overrides?.[day]};
          const used=await dayUsage(p.sender,day,db,ids);
          const sameDay=planned.filter(j=>new Date(+new Date(j.scheduled_at)+10800000).toISOString().slice(0,10)===day);
          if (used.length+sameDay.length>=effective.daily_limit || [...used,...sameDay].some(r=>[r.scheduled_at,r.attempted_at].some(t=>t && Math.abs(new Date(t)-stamp)<120000))) fail('telegram_plan_changed',409);
          const localTime=new Date(+stamp+10800000).toISOString().slice(11,16);
          if (localTime<effective.window_start.slice(0,5) || localTime>=effective.window_end.slice(0,5)) fail('telegram_plan_changed',409);
          planned.push(job);
        }
        for (const skip of plan.payload.excluded) {
          const job=rows.find(q=>q.id===skip.id),d=await draft(job,db,true);
          if (await eligible(d,job,db,job.id) && d.body===job.body && d.address===job.address) fail('telegram_plan_changed',409);
        }
        for (const job of planned) await db.query('UPDATE outreach_telegram_deliveries SET scheduled_at=$2,send_before=$3 WHERE id=$1',[job.id,job.scheduled_at,job.send_before]);
        for (const skip of plan.payload.excluded) await db.query("UPDATE outreach_telegram_deliveries SET status='skipped',detail=$2,completed_at=now() WHERE id=$1",[skip.id,skip.reason]);
        const overrides={...p.day_overrides};
        if (plan.payload.override) overrides[plan.payload.day]=plan.payload.override;
        await db.query("UPDATE outreach_telegram_profiles SET paused=false,day_overrides=$2::jsonb,daily_limit=$3,revision=revision+1,updated_at=now() WHERE sender=$1",[p.sender,JSON.stringify(overrides),normal.daily_limit]);
        return {sender:p.sender,resumed:planned.length,skipped:plan.payload.excluded.length,today_override:plan.payload.override,daily_limit:normal.daily_limit};
      });
    },
    async launchPrepare({ sender, recipients, start_date = today(), windows }) {
      const p = await get(sender); ready(p);
      if (!Array.isArray(recipients) || !recipients.length || recipients.length > 500) fail('telegram_batch_invalid');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !Number.isFinite(Date.parse(start_date))
          || new Date(`${start_date}T12:00:00Z`).toISOString().slice(0,10) !== start_date || start_date < today()) fail('telegram_start_invalid');
      const jobs = [], excluded = [], companies = new Set(), users = new Set(), addresses = new Set();
      for (const input of recipients) {
        const job = telegramRecipient(input), d = await draft(job);
        const company = d?.company.trim().toLowerCase();
        if (!await eligible(d, job) || companies.has(company) || users.has(job.recipient_id) || addresses.has(d.address.toLowerCase())) {
          excluded.push(job.draft_id); continue;
        }
        companies.add(company); users.add(job.recipient_id); addresses.add(d.address.toLowerCase());
        jobs.push({ ...job, address: d.address, name: d.name, company: d.company, body: d.body });
      }
      if (!jobs.length) fail('telegram_no_eligible_contacts', 409);
      if (windows !== undefined) {
        const dated=telegramLaunchWindows({day:start_date,windows,limit:p.daily_limit,count:jobs.length});
        // A dated override applies to the whole sender, so it must not move or
        // invalidate another already-approved job on that day.
        const used=await dayUsage(p.sender,start_date);
        if(used.length) fail('telegram_launch_day_busy',409);
        jobs.forEach((job,i)=>Object.assign(job,dated.slots[i]));
        const payload={sender:p.sender,jobs,excluded,profile:configuration(p),scheduled_day:start_date,day_override:dated.override,windows};
        return confirmations.prepare({operation:'telegram_launch',payload,snapshot:configuration(p),
          summary:`@${p.sender}: ${jobs.length} сообщений на ${start_date}; ${windows.map(w=>`${w.count} в ${w.start}–${w.end}`).join(', ')} МСК. Исключено ${excluded.length}. Получатели и тексты в плане. Без подтверждения отправка не запускается.`,preview:payload});
      }
      let day = start_date, index = 0;
      for (let attempts = 0; index < jobs.length && attempts < 730; attempts++, day = nextDay(day)) {
        const used = await dayUsage(p.sender, day);
        let remaining = Math.max(0, p.daily_limit - used.length);
        for (const slot of telegramSlots(day, p)) {
          if (!remaining || index === jobs.length) break;
          if (slot.getTime() <= Date.now() + 60000 || used.some(r => [r.scheduled_at, r.attempted_at].some(t => t && Math.abs(new Date(t) - slot) < 120000))) continue;
          jobs[index++].scheduled_at = slot.toISOString(); remaining--;
        }
      }
      if (index !== jobs.length) fail('telegram_schedule_unavailable', 409);
      const payload = { sender: p.sender, jobs, excluded, profile: configuration(p) };
      return confirmations.prepare({ operation: 'telegram_launch', payload, snapshot: configuration(p),
        summary: `@${p.sender}: подготовлено ${jobs.length} сообщений, исключено ${excluded.length}. Лимит ${p.daily_limit}/день; окно ${p.window_start.slice(0,5)}–${p.window_end.slice(0,5)} МСК. Отправка начнётся по расписанию после подтверждения.`, preview: payload });
    },
    async launchExecute(token) {
      const plan = confirmations.claim({ token, operation: 'telegram_launch', confirm: true });
      return transaction(async db => {
        const p = await get(plan.payload.sender, db, true); ready(p);
        confirmations.verify({ plan, currentSnapshot: configuration(p) });
        if(plan.payload.day_override && (await dayUsage(p.sender,plan.payload.scheduled_day,db)).length) fail('telegram_launch_day_busy',409);
        for (const job of plan.payload.jobs) {
          const d = await draft(job, db, true), stamp = new Date(job.scheduled_at);
          if (stamp <= new Date() || !await eligible(d, job, db)
              || ['address','name','company','body'].some(k => d[k] !== job[k])) fail('telegram_plan_changed', 409);
          const day = job.scheduled_at; // Slots are UTC; calendar limits use Moscow.
          const localDay = new Date(stamp.getTime() + 10800000).toISOString().slice(0,10);
          const used = await dayUsage(p.sender, localDay, db);
          if (used.length >= p.daily_limit || used.some(r => [r.scheduled_at,r.attempted_at].some(t => t && Math.abs(new Date(t)-stamp) < 120000))) fail('telegram_plan_changed', 409);
          await db.query(`INSERT INTO outreach_telegram_deliveries
            (draft_id,sender,recipient_id,address,body,permission_kind,permission_evidence,scheduled_at,random_id,send_before)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [job.draft_id,p.sender,job.recipient_id,job.address,job.body,
            job.permission_kind,job.permission_evidence,day,crypto.randomBytes(8).readBigUInt64BE() % (2n**63n-2n) + 1n,job.send_before||null]);
        }
        if(plan.payload.day_override) {
          const overrides={...p.day_overrides,[plan.payload.scheduled_day]:plan.payload.day_override};
          await db.query("UPDATE outreach_telegram_profiles SET day_overrides=$2::jsonb,revision=revision+1,updated_at=now() WHERE sender=$1",[p.sender,JSON.stringify(overrides)]);
        }
        return { queued: plan.payload.jobs.length, sender: p.sender };
      });
    },
  };
}
