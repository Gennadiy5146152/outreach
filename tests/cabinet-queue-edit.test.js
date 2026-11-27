import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { createCabinet } from '../src/cabinet/router.js';
import { createCabinetStore } from '../src/cabinet/store.js';
import { digest } from '../src/cabinet/security.js';

const connectionString = process.env.CABINET_TEST_DATABASE_URL;
test('queued copy amendments are prepared, scoped, atomic and immutable after dispatch', { skip: !connectionString }, async t => {
  const parsed = new URL(connectionString);
  assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname) && /^\/cabinet_test(?:_[a-z0-9]+)?$/.test(parsed.pathname));
  const pool = new pg.Pool({ connectionString });
  const query = pool.query.bind(pool);
  const withClient = async fn => { const db = await pool.connect(); try { return await fn(db); } finally { db.release(); } };
  const cabinet = createCabinet({ query, withClient, env: { nodeEnv:'development', cabinetTelegramSendEnabled:false } });
  const store = cabinet.store;
  const app = express(); app.use(express.json()); app.use('/api/cabinet', cabinet.router);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(r => server.once('listening',r));
  const request = async (path, token, body) => { const res=await fetch(`http://127.0.0.1:${server.address().port}/api/cabinet${path}`, { method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+token}, body:JSON.stringify(body) }); return {status:res.status, data:await res.json()}; };
  async function fixture(statuses=['queued','queued']) {
    const owner_id=randomUUID(), connection_id=randomUUID(), campaign_id=randomUUID(), sid=randomUUID();
    await query('INSERT INTO cabinet_accounts(id,login,display_name) VALUES($1,$2,$2)',[owner_id,'q-'+owner_id]);
    await query("INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,'test',now()+interval '1 hour')",[sid,owner_id]);
    const p={kind:'owner',owner_id,actor_key:'session:'+sid};
    await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username,generation) VALUES($1,$2,'sender','queue_sender',7)",[connection_id,owner_id]);
    await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name) VALUES($1,$2,$3,'queue campaign')",[campaign_id,owner_id,connection_id]);
    const jobs=[];
    for (let n=0;n<statuses.length;n++) {
      const draft=await store.saveDraft(p,campaign_id,{address:'https://t.me/recipient_'+n,recipient_id:String(9900000+n),body:'Около 10 дней. После завершения показываю результат работ.',permission_kind:'consent',permission_evidence:'Confirmed fixture permission'});
      const {rows:[job]}=await query("INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,(abs(hashtext($8))::bigint*1000+$9),now()+interval '1 day',$10) RETURNING *",[owner_id,draft.id,campaign_id,connection_id,draft.address,draft.recipient_id,draft.body,owner_id,n+1,statuses[n]]);
      jobs.push(job);
    }
    async function token(scopes=['outreach:send','outreach:draft'], campaign_ids=[campaign_id], all_campaigns=false) {
      const raw='ocp_'+randomUUID(); const id=randomUUID();
      await query("INSERT INTO cabinet_api_tokens(id,owner_id,name,token_hash,display_prefix,scopes,campaign_ids,all_campaigns,expires_at) VALUES($1,$2,'test',$3,'test',$4,$5,$6,now()+interval '1 hour')",[id,owner_id,digest(raw),scopes,campaign_ids,all_campaigns]);
      return {raw,p:{kind:'token',id,owner_id,actor_key:'token:'+id,scopes,campaign_ids,all_campaigns}};
    }
    const items=jobs.filter(j=>j.status==='queued').map(j=>({job_id:j.id,body:'  Около 5 дней.\n\nТочный текст.  '}));
    return {p,owner_id,connection_id,campaign_id,jobs,items,token};
  }
  const rows = async f => (await query('SELECT * FROM cabinet_jobs WHERE owner_id=$1 ORDER BY id',[f.owner_id])).rows;
  const prepare = (f,p=f.p,items=f.items) => store.prepareQueueEdit(p,f.campaign_id,{items});
  const execute = (f,plan,p=f.p) => store.executeQueueEdit(p,{confirmation_token:plan.confirmation_token,confirm:true});
  try {
    await t.test('prepare previews exact old and new bodies without changing jobs, drafts, revision or pause',async()=>{
      const f=await fixture(); const before=await rows(f); const draftBefore=(await query('SELECT * FROM cabinet_drafts WHERE owner_id=$1 ORDER BY id',[f.owner_id])).rows;
      const plan=await prepare(f);
      assert.equal(plan.requires_confirmation,true); assert.equal(plan.preview.kind,'queue_edit');
      assert.equal(plan.preview.items.length,2);
      assert.deepEqual(plan.preview.items.map(i=>[i.job_id,i.old_body,i.new_body,i.address,i.recipient_id,i.scheduled_at]),f.jobs.map((j,n)=>[j.id,j.body,f.items[n].body,j.address,j.recipient_id,j.scheduled_at.toISOString()]));
      assert.equal(plan.preview.sender,'queue_sender');
      assert.deepEqual(await rows(f),before);
      assert.deepEqual((await query('SELECT * FROM cabinet_drafts WHERE owner_id=$1 ORDER BY id',[f.owner_id])).rows,draftBefore);
      const c=(await query('SELECT paused,revision FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0]; assert.deepEqual(c,{paused:true,revision:1});
    });
    await t.test('execute changes both copies once and preserves every other job field and pause',async()=>{
      const f=await fixture(['queued','queued','sent','uncertain']);
      await query('UPDATE cabinet_campaigns SET paused=false WHERE id=$1',[f.campaign_id]);
      const {p}=await f.token(); const before=await rows(f); const plan=await prepare(f,p);
      assert.deepEqual(await execute(f,plan,p),{ok:true,kind:'queue_edit',count:2});
      const after=await rows(f);
      assert.deepEqual(after,before.map(j=>({...j,body:j.status==='queued'?'  Около 5 дней.\n\nТочный текст.  ':j.body})));
      for(const j of after.filter(j=>j.status==='queued')) { assert.equal(j.body,'  Около 5 дней.\n\nТочный текст.  '); assert.equal((await query('SELECT body FROM cabinet_drafts WHERE id=$1',[j.draft_id])).rows[0].body,j.body); }
      assert.deepEqual((await query('SELECT paused,revision FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],{paused:false,revision:2});
      assert.equal((await query("SELECT count(*)::int n FROM cabinet_audit WHERE owner_id=$1 AND action='queued_copy_edited'",[f.owner_id])).rows[0].n,1);
      await assert.rejects(execute(f,plan,p),/confirmation_invalid/);
    });
    await t.test('both scopes, owned campaign and campaign allowlist required at prepare and execute',async()=>{
      const f=await fixture();
      for(const scopes of [['outreach:send'],['outreach:draft'],['outreach:read']]) { const tok=await f.token(scopes); await assert.rejects(prepare(f,tok.p),/scope_denied/); }
      const selected=await f.token(undefined,[randomUUID()]); await assert.rejects(prepare(f,selected.p),/campaign_not_found/);
      const foreign=await fixture(); await assert.rejects(store.prepareQueueEdit(f.p,foreign.campaign_id,{items:foreign.items}),/campaign_not_found/);
      const all=await f.token(undefined,[],true); const plan=await prepare(f,all.p);
      await assert.rejects(execute(f,plan,{...all.p,scopes:['outreach:send']}),/scope_denied/);
      await assert.rejects(execute(f,plan,{...all.p,campaign_ids:[],all_campaigns:false}),/campaign_not_found/);
      await execute(f,plan,all.p);
    });
    await t.test('nonqueued jobs and mixed invalid batches never amend any copy',async()=>{
      for(const status of ['sending','sent','uncertain','failed','cancelled']) {
        const f=await fixture(['queued',status]); const before=await rows(f);
        await assert.rejects(prepare(f,f.p,f.jobs.map(j=>({job_id:j.id,body:'changed'}))),/queue_edit_not_eligible/);
        assert.deepEqual(await rows(f),before);
        assert.equal((await query('SELECT count(*)::int n FROM cabinet_plans WHERE owner_id=$1',[f.owner_id])).rows[0].n,0);
      }
      const f=await fixture(); await assert.rejects(prepare(f,f.p,[...f.items,{job_id:randomUUID(),body:'changed'}]),/queue_edit_not_eligible/);
    });
    await t.test('strict schemas reject identity, schedule, pause, duplicates and invalid copy',async()=>{
      const f=await fixture();
      for(const input of [{items:[]},{items:f.items,paused:false},{items:[f.items[0],f.items[0]]},{items:[{...f.items[0],recipient_id:'123'}]},{items:[{...f.items[0],scheduled_at:'2030-01-01'}]},{items:[{...f.items[0],body:' '}]},{items:[{...f.items[0],body:'x'.repeat(4001)}]},{items:Array.from({length:101},()=>({job_id:randomUUID(),body:'x'}))}]) await assert.rejects(store.prepareQueueEdit(f.p,f.campaign_id,input));
      assert.equal((await query('SELECT count(*)::int n FROM cabinet_plans WHERE owner_id=$1',[f.owner_id])).rows[0].n,0);
    });
    await t.test('snapshot rejects changes in any bound job, draft, campaign or sender field atomically',async()=>{
      for(const [table,set] of [['cabinet_jobs',"body='other'"],['cabinet_jobs',"status='sending'"],['cabinet_jobs',"status='sent'"],['cabinet_jobs',"status='uncertain'"],['cabinet_jobs',"scheduled_at=scheduled_at+interval '1 minute'"],['cabinet_jobs','random_id=random_id+100'],['cabinet_drafts',"body='other'"],['cabinet_drafts',"permission_evidence='different permission'"],['cabinet_campaigns','revision=revision+1'],['cabinet_campaigns',"window_end='12:00'"],['cabinet_connections','generation=generation+1']]) {
        const f=await fixture(); const plan=await prepare(f);
        await query(`UPDATE ${table} SET ${set} WHERE owner_id=$1${table==='cabinet_jobs'?' AND id=$2':''}`,table==='cabinet_jobs'?[f.owner_id,f.jobs[1].id]:[f.owner_id]);
        const before=await rows(f); await assert.rejects(execute(f,plan),/plan_changed/); assert.deepEqual(await rows(f),before);
      }
    });
    await t.test('prepare reads sender generation and identity after acquiring the connection row lock',async()=>{
      const f=await fixture();
      let reached;
      const ready=new Promise(r=>{reached=r;});
      const waiting=createCabinetStore({query,withClient:fn=>withClient(db=>fn({query:async(sql,args)=>{
        if(sql.startsWith('SELECT id FROM cabinet_connections')) reached();
        return db.query(sql,args);
      }}))});
      const control=await pool.connect();
      await control.query('BEGIN');
      await control.query("UPDATE cabinet_connections SET generation=generation+1,username='fresh_sender' WHERE id=$1",[f.connection_id]);
      const preparing=waiting.prepareQueueEdit(f.p,f.campaign_id,{items:f.items});
      try { await ready; } finally { await control.query('COMMIT'); control.release(); }
      const plan=await preparing;
      assert.equal(plan.preview.sender,'fresh_sender');
      await execute(f,plan);
    });
    await t.test('snapshot preserves bigint and submillisecond precision',async()=>{
      for(const change of ["random_id=random_id-1", "scheduled_at=scheduled_at+interval '1 microsecond'"]) {
        const f=await fixture(['queued']);
        const high=9007199254740993n + BigInt('0x'+randomUUID().replaceAll('-','').slice(0,8))*1024n;
        await query("UPDATE cabinet_jobs SET random_id=$2 WHERE owner_id=$1",[f.owner_id,String(high)]);
        const plan=await prepare(f);
        await query(`UPDATE cabinet_jobs SET ${change} WHERE owner_id=$1`,[f.owner_id]);
        await assert.rejects(execute(f,plan),/plan_changed/);
      }
    });
    await t.test('confirmation must be explicit, live, same actor, cabinet, action and active credential',async()=>{
      const f=await fixture(); const tok=await f.token(); const plan=await prepare(f,tok.p);
      await assert.rejects(store.executeQueueEdit(tok.p,{confirmation_token:plan.confirmation_token,confirm:false}),/confirmation_required/);
      await assert.rejects(store.executeQueueEdit(tok.p,{confirmation_token:plan.confirmation_token,confirm:true,paused:false}));
      const other=await f.token(); await assert.rejects(execute(f,plan,other.p),/confirmation_invalid/);
      const foreign=await fixture(); await assert.rejects(execute(f,plan,foreign.p),/confirmation_invalid/);
      await assert.rejects(execute(f,{confirmation_token:'plan_wrong_token_123456789012345'},tok.p),/confirmation_invalid/);
      await assert.rejects(store.execute(tok.p,{confirmation_token:plan.confirmation_token,confirm:true,kind:'launch'}),/confirmation_wrong_action/);
      await query("UPDATE cabinet_plans SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[digest(plan.confirmation_token)]);
      await assert.rejects(execute(f,plan,tok.p),/confirmation_invalid/);
      const fresh=await prepare(f,tok.p); await query('UPDATE cabinet_api_tokens SET revoked_at=now() WHERE id=$1',[tok.p.id]);
      await assert.rejects(execute(f,fresh,tok.p),/cabinet_auth_required/);
      await query('DELETE FROM cabinet_sessions WHERE owner_id=$1',[f.owner_id]); await assert.rejects(prepare(f),/cabinet_auth_required/);
    });
    await t.test('HTTP exposes prepared amendment only and keeps dispatched draft edit guarded',async()=>{
      const f=await fixture(); const tok=await f.token();
      const plan=await request(`/campaigns/${f.campaign_id}/queue-edit/prepare`,tok.raw,{items:f.items}); assert.equal(plan.status,200);
      const denied=await request('/queue-edit/execute',tok.raw,{confirmation_token:plan.data.confirmation_token,confirm:false}); assert.equal(denied.status,400);
      assert.equal((await request('/queue-edit/execute',tok.raw,{confirmation_token:plan.data.confirmation_token,confirm:true})).status,200);
      await assert.rejects(store.editDraft(f.p,f.campaign_id,f.jobs[0].draft_id,{body:'ordinary edit'}),/draft_already_dispatched/);
    });
  } finally { await new Promise(r=>server.close(r)); await pool.end(); }
});
