import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import pg from 'pg';
import { createTelegramProfiles } from '../src/services/telegram-profiles.js';

test('resume prepares the reviewed copy and requires fresh approval before replacing an unattempted queue body', { skip: !process.env.TELEGRAM_REFRESH_TEST_DATABASE_URL }, async () => {
  const url=process.env.TELEGRAM_REFRESH_TEST_DATABASE_URL;
  assert.match(new URL(url).pathname,/test/,'Use a disposable empty database');
  const pool=new pg.Pool({connectionString:url});
  const query=(sql,args)=>pool.query(sql,args);
  const withClient=async fn=>{const c=await pool.connect();try{return await fn(c);}finally{c.release();}};
  const api=createTelegramProfiles({query,withClient});
  try {
    assert.equal((await query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
    const files=(await fs.readdir(new URL('../db/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
    for(const file of files)await query(await fs.readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
    await api.create({sender:'reviewed_account'});
    await query("UPDATE outreach_telegram_profiles SET connection_status='connected',heartbeat_at=now(),paused=false WHERE sender='reviewed_account'");
    const recipients=[];
    for(let i=0;i<3;i++){
      const {rows:[draft]}=await query(`INSERT INTO outreach_messenger_drafts(collection,channel,address,name,company,source_url,body)
        VALUES ('Review','telegram',$1,$2,$2,'https://example.org','Old queued copy') RETURNING id`,['https://t.me/reviewed_person_'+i,'Reviewed company '+i]);
      recipients.push({draft_id:draft.id,recipient_id:String(9000+i),permission_kind:'consent',permission_evidence:'Previously approved contact'});
    }
    const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
    const launch=await api.launchPrepare({sender:'reviewed_account',recipients,start_date:tomorrow});
    await api.launchExecute(launch.confirmation_token);
    await query("UPDATE outreach_telegram_profiles SET paused=true,revision=revision+1 WHERE sender='reviewed_account'");
    await query("UPDATE outreach_messenger_drafts SET body='Reviewed current copy' WHERE id=$1",[recipients[0].draft_id]);
    await query("UPDATE outreach_messenger_drafts SET review_reason='Role needs checking' WHERE id=$1",[recipients[1].draft_id]);
    await query("UPDATE outreach_messenger_drafts SET address='https://t.me/a_different_person' WHERE id=$1",[recipients[2].draft_id]);
    const before=(await api.queueList({sender:'reviewed_account',pageSize:25})).items;
    const plan=await api.resumePrepare({sender:'reviewed_account'});
    assert.equal(plan.preview.jobs.length,1,'A reviewed edit must not be dropped as an ineligible recipient');
    assert.equal(plan.preview.excluded.length,2,'A hold or recipient change cannot be silently approved');
    assert.equal(plan.preview.jobs[0].body,'Reviewed current copy');
    assert.equal(plan.preview.jobs[0].previous_body,'Old queued copy');
    assert.equal(plan.preview.jobs[0].body_changed,true);
    assert.deepEqual((await api.queueList({sender:'reviewed_account',pageSize:25})).items,before,'Prepare cannot rewrite the queue');
    assert.equal((await api.get('reviewed_account')).paused,true);
    const releasePlan=await api.resumePrepare({sender:'reviewed_account'});
    await query("UPDATE outreach_messenger_drafts SET review_reason='',body='Newly released reviewed copy' WHERE id=$1",[recipients[1].draft_id]);
    await assert.rejects(api.resumeExecute(releasePlan.confirmation_token),/telegram_plan_changed/,'A held contact becoming eligible changes the approved exclusions');
    assert.equal((await api.get('reviewed_account')).paused,true);
    await query("UPDATE outreach_messenger_drafts SET review_reason='Role needs checking' WHERE id=$1",[recipients[1].draft_id]);
    await query("UPDATE outreach_messenger_drafts SET body='Edited after preparation' WHERE id=$1",[recipients[0].draft_id]);
    await assert.rejects(api.resumeExecute(plan.confirmation_token),/telegram_plan_changed/);
    assert.equal((await api.get('reviewed_account')).paused,true);
    const fresh=await api.resumePrepare({sender:'reviewed_account'});
    const result=await api.resumeExecute(fresh.confirmation_token);
    assert.equal(result.resumed,1);assert.equal(result.skipped,2);
    const all=(await api.queueList({sender:'reviewed_account',pageSize:25})).items;
    const queued=all.filter(j=>j.status==='pending');
    assert.equal(queued.length,1);assert.equal(queued[0].body,'Edited after preparation');
    const original=before.find(j=>j.id===queued[0].id);
    for(const field of ['random_id','address','recipient_id','permission_kind','permission_evidence']) assert.equal(queued[0][field],original[field]);
    assert.equal(all.filter(j=>j.status==='skipped').length,2);
    assert.equal((await api.get('reviewed_account')).paused,false);
    await assert.rejects(api.resumeExecute(fresh.confirmation_token));
  } finally { await pool.end(); }
});
