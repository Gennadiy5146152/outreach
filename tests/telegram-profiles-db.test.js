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
    // Resume preserves the original delivery identity while moving missed slots.
    await api.create({sender:'resume_account'});
    await query("UPDATE outreach_telegram_profiles SET connection_status='connected',heartbeat_at=now() WHERE sender='resume_account'");
    const resumeSettings=await api.settingsPrepare('resume_account',{label:'Resume',paused:false,daily_limit:10,window_start:'09:30',window_end:'11:30'});
    await api.settingsExecute(resumeSettings.confirmation_token);
    const recipients=[];
    for(let i=0;i<71;i++) recipients.push(await recipient('resume_recipient_'+i,201+i));
    const batch=await api.launchPrepare({sender:'resume_account',recipients,start_date:day});
    await api.launchExecute(batch.confirmation_token);
    await query("UPDATE outreach_telegram_profiles SET paused=true,revision=revision+1 WHERE sender='resume_account'");
    await query("UPDATE outreach_messenger_drafts SET body='Changed after queueing' WHERE id=$1",[recipients[0].draft_id]);
    await query("UPDATE outreach_messenger_drafts SET website='https://resume-blocked.example' WHERE id=$1",[recipients[1].draft_id]);
    await query("INSERT INTO suppressions(domain,reason) VALUES ('resume-blocked.example','test')");
    const base=Date.now()+180000;
    const sameDay=new Date(base+4200000+10800000).toISOString().slice(0,10)===new Date(Date.now()+10800000).toISOString().slice(0,10);
    const windows=sameDay ? [
      {start:new Date(base).toISOString(),end:new Date(base+1800000).toISOString(),count:10},
      {start:new Date(base+2400000).toISOString(),end:new Date(base+4200000).toISOString(),count:10},
    ] : [];
    const original=(await api.queueList({sender:'resume_account',pageSize:100})).items;
    const resume=await api.resumePrepare({sender:'resume_account',today_windows:windows});
    assert.equal(resume.preview.jobs.length,69);
    assert.equal(resume.preview.daily_limit,10);
    assert.equal(resume.preview.excluded.length,2);
    assert.equal((await api.get('resume_account')).paused,true,'prepare must not enable sending');
    assert.deepEqual((await api.queueList({sender:'resume_account',pageSize:100})).items,original);
    const firstId=original[0].id,firstBody=original[0].body;
    await query("UPDATE outreach_telegram_deliveries SET body='Queue changed' WHERE id=$1",[firstId]);
    await assert.rejects(api.resumeExecute(resume.confirmation_token),/Outreach data changed/);
    await query('UPDATE outreach_telegram_deliveries SET body=$2 WHERE id=$1',[firstId,firstBody]);
    await assert.rejects(api.resumePrepare({sender:'resume_account',daily_limit:100}),/telegram_settings_invalid/);
    const refreshed=await api.resumePrepare({sender:'resume_account',today_windows:windows,daily_limit:20});
    assert.equal(refreshed.preview.daily_limit,20);
    const result=await api.resumeExecute(refreshed.confirmation_token);
    assert.equal(result.resumed,69);assert.equal(result.skipped,2);
    await assert.rejects(api.resumeExecute(refreshed.confirmation_token));
    const profile=await api.get('resume_account');
    assert.equal(profile.paused,false);assert.equal(profile.daily_limit,20);
    if(sameDay) assert.equal(profile.day_overrides[refreshed.preview.day].daily_limit,20);
    const queued=(await api.queueList({sender:'resume_account',status:'pending',pageSize:100})).items;
    for(const q of queued){
      const old=original.find(o=>o.id===q.id);
      assert.equal(q.random_id,old.random_id);assert.equal(q.body,old.body);assert.equal(q.address,old.address);
      assert.ok(q.send_before>q.scheduled_at);
    }
    if(sameDay){
      for(const w of windows) assert.equal(queued.filter(q=>q.scheduled_at>=new Date(w.start)&&q.scheduled_at<new Date(w.end)).length,10);
      const tomorrowJobs=queued.filter(q=>q.scheduled_at>=new Date(windows.at(-1).end));
      assert.equal(tomorrowJobs.length,49);
      const dailyCounts={};
      for(const q of tomorrowJobs){const date=new Date(+q.scheduled_at+10800000).toISOString().slice(0,10);dailyCounts[date]=(dailyCounts[date]||0)+1;}
      assert.deepEqual(Object.values(dailyCounts),[20,20,9]);
      assert.ok(tomorrowJobs.every(q=>new Date(+q.scheduled_at+10800000).toISOString().slice(11,16)>='09:30'&&new Date(+q.scheduled_at+10800000).toISOString().slice(11,16)<'11:30'));
    }
    const beforeGlobalStop=await api.resumePrepare({sender:'resume_account'});
    const resumeImpact=await withClient(outreachStopAllImpact);
    await withClient(db=>stopAllOutreach(db,resumeImpact.snapshot_token));
    await assert.rejects(api.resumeExecute(beforeGlobalStop.confirmation_token),/Outreach data changed/);
  } finally { await pool.end(); }
});
