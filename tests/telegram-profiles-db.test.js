// Run against a disposable empty database only:
// TELEGRAM_TEST_DATABASE_URL=postgres://.../outreach_test node --test tests/telegram-profiles-db.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import pg from 'pg';
import { createTelegramProfiles } from '../src/services/telegram-profiles.js';

test('two profiles: migration, isolated limits, global duplicates, stop-list and exact approval', { skip: !process.env.TELEGRAM_TEST_DATABASE_URL }, async () => {
  const url = process.env.TELEGRAM_TEST_DATABASE_URL;
  assert.match(new URL(url).pathname, /test/, 'Use a disposable test database');
  const pool = new pg.Pool({ connectionString:url });
  const query = (sql, values) => pool.query(sql, values);
  const withClient = async fn => { const c=await pool.connect(); try {return await fn(c);} finally {c.release();} };
  const api = createTelegramProfiles({query,withClient});
  try {
    assert.equal((await query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
    const files = (await fs.readdir(new URL('../db/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
    for (const file of files) {
      if (file.startsWith('024_')) {
        const {rows:[legacy]}=await query(`INSERT INTO outreach_messenger_drafts(collection,channel,address,name,company,source_url,body)
          VALUES ('Legacy','telegram','https://t.me/legacy_recipient','Legacy','Legacy','https://example.org','Legacy') RETURNING id`);
        await query(`INSERT INTO outreach_telegram_deliveries(draft_id,sender,recipient_id,address,body,permission_kind,permission_evidence,scheduled_at,random_id)
          VALUES ($1,'legacy_account',99,'https://t.me/legacy_recipient','Legacy','consent','Existing approval','2026-11-23T10:00:00+03:00',99)`,[legacy.id]);
      }
      await query(await fs.readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
    }
    const migrated=await api.get('legacy_account');
    assert.equal(migrated.paused,false);
    assert.equal((await api.queueList({sender:'legacy_account',status:'pending'})).total,1);
    await query("UPDATE outreach_telegram_deliveries SET status='cancelled' WHERE sender='legacy_account'");
    const first=await api.create({sender:'first_account'}), second=await api.create({sender:'second_account'});
    assert.equal(first.paused,true); assert.equal(second.connection_status,'awaiting_session');
    await assert.rejects(api.create({sender:'FIRST_ACCOUNT'}),/telegram_profile_exists/);
    await query("UPDATE outreach_telegram_profiles SET connection_status='connected',heartbeat_at=now() WHERE sender IN ('first_account','second_account')");
    for (const sender of ['first_account','second_account']) {
      const prepared=await api.settingsPrepare(sender,{label:sender,paused:false,daily_limit:1,window_start:'16:00',window_end:'18:00'});
      await api.settingsExecute(prepared.confirmation_token);
    }
    const recipient = async (name, id) => {
      const {rows:[d]}=await query(`INSERT INTO outreach_messenger_drafts(collection,channel,address,name,company,source_url,body)
        VALUES ('Test','telegram',$1,$2,$2,'https://example.org','Добрый день!\n\nПредложение.') RETURNING id`,['https://t.me/'+name,name]);
      return {draft_id:d.id,recipient_id:String(id),permission_kind:'consent',permission_evidence:'User request test'};
    };
    const a=await recipient('first_recipient',101),b=await recipient('second_recipient',102),c=await recipient('third_recipient',103);
    const day=new Date(Date.now()+86400000).toISOString().slice(0,10);
    const one=await api.launchPrepare({sender:'first_account',recipients:[a,b],start_date:day});
    assert.equal(one.preview.jobs.length,2);
    assert.notEqual(one.preview.jobs[0].scheduled_at.slice(0,10),one.preview.jobs[1].scheduled_at.slice(0,10));
    const other=await api.launchPrepare({sender:'second_account',recipients:[c],start_date:day});
    assert.equal(other.preview.jobs[0].scheduled_at.slice(0,10),one.preview.jobs[0].scheduled_at.slice(0,10));
    await api.launchExecute(one.confirmation_token);
    await api.launchExecute(other.confirmation_token);
    await assert.rejects(api.launchExecute(one.confirmation_token));
    await assert.rejects(api.launchPrepare({sender:'second_account',recipients:[a],start_date:day}),/telegram_no_eligible_contacts/);
    const d=await recipient('fourth_recipient',104);
    const stale=await api.launchPrepare({sender:'second_account',recipients:[d],start_date:day});
    await query("UPDATE outreach_messenger_drafts SET body='Изменённый текст' WHERE id=$1",[d.draft_id]);
    await assert.rejects(api.launchExecute(stale.confirmation_token),/telegram_plan_changed/);
    assert.equal((await api.queueList({sender:'first_account'})).total,2);
    assert.equal((await api.queueList({sender:'second_account'})).total,1);
    const e=await recipient('fifth_recipient',105);
    await query("UPDATE outreach_messenger_drafts SET website='https://blocked.example' WHERE id=$1",[e.draft_id]);
    await query("INSERT INTO suppressions(domain,reason) VALUES ('blocked.example','test')");
    await assert.rejects(api.launchPrepare({sender:'second_account',recipients:[e],start_date:day}),/telegram_no_eligible_contacts/);
    // A profile configuration change invalidates a prepared launch even if the heartbeat changes normally.
    const fresh=await api.launchPrepare({sender:'second_account',recipients:[d],start_date:day});
    const settings=await api.settingsPrepare('second_account',{label:'Second',paused:true,daily_limit:1,window_start:'16:00',window_end:'18:00'});
    await api.settingsExecute(settings.confirmation_token);
    await assert.rejects(api.launchExecute(fresh.confirmation_token),/telegram_profile_paused/);
    const {stopAllOutreach,outreachStopAllImpact}=await import('../src/services/outreach-control.js');
    const beforeStop=await api.launchPrepare({sender:'first_account',recipients:[d],start_date:day});
    const impact=await withClient(outreachStopAllImpact);
    await withClient(db=>stopAllOutreach(db,impact.snapshot_token));
    await assert.rejects(api.launchExecute(beforeStop.confirmation_token), /Outreach data changed/);
    assert.equal((await api.queueList({status:'pending'})).total,0);
    assert.equal((await api.queueList({status:'cancelled'})).total,4);
  } finally { await pool.end(); }
});
