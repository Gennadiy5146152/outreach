import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { createCabinet } from '../src/cabinet/router.js';
import { createCabinetStore } from '../src/cabinet/store.js';
import { digest } from '../src/cabinet/security.js';

test('one-off store rejects unauthorized credentials before any database access', async()=>{
  const query=async()=>{throw new Error('unexpected database access');};
  const store=createCabinetStore({query,withClient:query});
  const p={kind:'token',owner_id:randomUUID(),actor_key:'token:test',scopes:['outreach:send'],campaign_ids:[],all_campaigns:true};
  await assert.rejects(async()=>store.prepareOneOff(p,randomUUID(),{draft_ids:[randomUUID()],window_start:'14:00',window_end:'15:00'}),/scope_denied/);
});

const connectionString=process.env.CABINET_TEST_DATABASE_URL;
test('one-off launch is exact, scoped, same-day, atomic and limited to two extra messages', {skip:!connectionString}, async t=>{
  const url=new URL(connectionString);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&/^\/cabinet_test(?:_[a-z0-9]+)?$/.test(url.pathname));
  const pool=new pg.Pool({connectionString}), query=pool.query.bind(pool);
  const withClient=async fn=>{const db=await pool.connect();try{return await fn(db);}finally{db.release();}};
  let clock=new Date('2026-11-27T11:00:00Z');
  const store=createCabinetStore({query,withClient,now:()=>clock,sendEnabled:true});
  const cabinet=createCabinet({query,withClient,env:{nodeEnv:'development',cabinetTelegramSendEnabled:true}});
  const app=express();app.use(express.json());app.use('/api/cabinet',cabinet.router);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const jobs=async f=>(await query('SELECT * FROM cabinet_jobs WHERE owner_id=$1 ORDER BY id',[f.owner_id])).rows;
  async function fixture(count=10){
    clock=new Date('2026-11-27T11:00:00Z');
    const owner_id=randomUUID(),connection_id=randomUUID(),campaign_id=randomUUID(),sid=randomUUID();
    await query('INSERT INTO cabinet_accounts(id,login,display_name) VALUES($1,$2,$2)',[owner_id,'o-'+owner_id]);
    await query("INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,'test',now()+interval '1 hour')",[sid,owner_id]);
    const p={kind:'owner',owner_id,actor_key:'session:'+sid};
    await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username,username,telegram_user_id,status,generation,heartbeat_at) VALUES($1,$2,'sender','oneoff_sender','oneoff_sender',abs(hashtext($2::uuid::text))::bigint+40000000000,'connected',7,$3)",[connection_id,owner_id,clock]);
    await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name,daily_limit,window_start,window_end) VALUES($1,$2,$3,'one off',10,'12:02','13:55')",[campaign_id,owner_id,connection_id]);
    const drafts=[];
    for(let n=0;n<count+2;n++){
      const d=await store.saveDraft(p,campaign_id,{address:'https://t.me/oneoff_'+n,recipient_id:String(9900000+n),body:'Exact body '+n+'\n\nFinal paragraph.',permission_kind:'consent',permission_evidence:'Confirmed fixture permission'});
      if(n<count)await query("INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at,attempted_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,abs(hashtext($1::uuid::text))::bigint*1000+$8,$9,$9,'sent')",[owner_id,d.id,campaign_id,connection_id,d.address,d.recipient_id,d.body,n+1,new Date('2026-11-27T09:30:00Z')]);
      else drafts.push(d);
    }
    async function token(scopes=['outreach:send','outreach:draft'],all_campaigns=true){
      const raw='ocp_'+randomUUID(),id=randomUUID();
      await query("INSERT INTO cabinet_api_tokens(id,owner_id,name,token_hash,display_prefix,scopes,campaign_ids,all_campaigns,expires_at) VALUES($1,$2,'test',$3,'test',$4,$5,$6,now()+interval '1 hour')",[id,owner_id,digest(raw),scopes,all_campaigns?[]:[campaign_id],all_campaigns]);
      return {raw,p:{kind:'token',id,owner_id,actor_key:'token:'+id,scopes,campaign_ids:[campaign_id],all_campaigns}};
    }
    return {p,owner_id,connection_id,campaign_id,drafts,token,input:{draft_ids:drafts.map(d=>d.id),window_start:'14:01',window_end:'15:00'}};
  }
  const prepare=(f,p=f.p,input=f.input)=>store.prepareOneOff(p,f.campaign_id,input);
  const execute=(f,plan,p=f.p)=>store.executeOneOff(p,{confirmation_token:plan.confirmation_token,confirm:true});
  try{
    await t.test('prepare is inert and execute creates exactly 10+2 pinned jobs while preserving settings',async()=>{
      const f=await fixture(), before=await jobs(f);const plan=await prepare(f);
      assert.ok(plan);assert.equal(plan.requires_confirmation,true);assert.equal(plan.preview.kind,'one_off_launch');
      assert.deepEqual([plan.preview.daily_limit,plan.preview.window_start,plan.preview.window_end],[10,'12:02:00','13:55:00']);
      assert.deepEqual([plan.preview.one_off_day,plan.preview.one_off_window_start,plan.preview.one_off_window_end,plan.preview.one_off_daily_limit],['2026-11-27','14:01','15:00',12]);
      assert.deepEqual(plan.preview.items.map(i=>[i.draft_id,i.recipient_id,i.body]),f.drafts.map(d=>[d.id,String(d.recipient_id),d.body]));
      assert.ok(plan.preview.items.every(i=>i.scheduled_at.startsWith('2026-11-27')&&new Date(i.scheduled_at)>=clock));
      assert.deepEqual(await jobs(f),before);
      assert.deepEqual(await execute(f,plan),{ok:true,kind:'one_off_launch',count:2});
      const added=(await jobs(f)).filter(j=>j.one_off_day);
      assert.equal(added.length,2);assert.ok(added.every(j=>j.one_off_daily_limit===12&&j.one_off_window_start==='14:01:00'&&j.one_off_window_end==='15:00:00'));
      assert.equal((await jobs(f)).length,12);
      assert.deepEqual((await query('SELECT daily_limit,window_start,window_end,paused FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],{daily_limit:10,window_start:'12:02:00',window_end:'13:55:00',paused:false});
      await assert.rejects(execute(f,plan),/confirmation_invalid/);
    });
    await t.test('explicit permanent limit 20 is reviewed and only applied on execute, preserving the ordinary window',async()=>{
      const f=await fixture();const plan=await prepare(f,f.p,{...f.input,daily_limit:20});
      assert.equal(plan.preview.daily_limit,10);assert.equal(plan.preview.permanent_daily_limit,20);assert.equal(plan.preview.one_off_daily_limit,20);
      assert.equal((await query('SELECT daily_limit FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0].daily_limit,10);
      await execute(f,plan);assert.deepEqual((await query('SELECT daily_limit,window_start,window_end FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],{daily_limit:20,window_start:'12:02:00',window_end:'13:55:00'});
      assert.ok((await jobs(f)).filter(j=>j.one_off_day).every(j=>j.one_off_daily_limit===20));
      const normal=await store.saveDraft(f.p,f.campaign_id,{address:'https://t.me/normal_future',recipient_id:'9919998',body:'Ordinary next launch',permission_kind:'consent',permission_evidence:'Confirmed permission'});
      assert.equal((await store.prepare(f.p,f.campaign_id,{draft_ids:[normal.id]})).preview.daily_limit,20);
      const low=await fixture();await assert.rejects(prepare(low,low.p,{...low.input,daily_limit:11}),/one_off_capacity/);
      await assert.rejects(prepare(low,low.p,{...low.input,daily_limit:100}),/one_off_invalid/);
      await query("INSERT INTO cabinet_campaigns(owner_id,connection_id,name,daily_limit,window_start,window_end) VALUES($1,$2,'sibling',10,'12:02','13:55')",[low.owner_id,low.connection_id]);
      await assert.rejects(prepare(low,low.p,{...low.input,daily_limit:20}),/connection_schedule_conflict/);
    });
    await t.test('reviewed permanent end 15:55 and limit 20 apply atomically with exactly two jobs',async()=>{
      const f=await fixture();const input={...f.input,daily_limit:20,campaign_window_end:'15:55'};
      const plan=await prepare(f,f.p,input);
      assert.deepEqual([plan.preview.window_start,plan.preview.window_end,plan.preview.permanent_window_end,plan.preview.permanent_daily_limit],['12:02:00','13:55:00','15:55',20]);
      assert.deepEqual((await query('SELECT daily_limit,window_start,window_end,paused FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],{daily_limit:10,window_start:'12:02:00',window_end:'13:55:00',paused:true});
      assert.equal((await jobs(f)).length,10);
      await execute(f,plan);
      assert.deepEqual((await query('SELECT daily_limit,window_start,window_end,paused FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],{daily_limit:20,window_start:'12:02:00',window_end:'15:55:00',paused:false});
      assert.equal((await jobs(f)).length,12);assert.ok((await jobs(f)).filter(j=>j.one_off_day).every(j=>j.one_off_daily_limit===20));
      const endOnly=await fixture();const endPlan=await prepare(endOnly,endOnly.p,{...endOnly.input,campaign_window_end:'15:55'});await execute(endOnly,endPlan);
      assert.deepEqual((await query('SELECT daily_limit,window_start,window_end FROM cabinet_campaigns WHERE id=$1',[endOnly.campaign_id])).rows[0],{daily_limit:10,window_start:'12:02:00',window_end:'15:55:00'});
    });
    await t.test('proposed permanent end rejects malformed or insufficient windows, sibling conflict and stale settings',async()=>{
      const f=await fixture();for(const campaign_window_end of ['25:00','12:00','12:30',null,15])await assert.rejects(prepare(f,f.p,{...f.input,daily_limit:20,campaign_window_end}),/one_off_invalid/);
      const plan=await prepare(f,f.p,{...f.input,daily_limit:20,campaign_window_end:'15:55'});
      await query("UPDATE cabinet_campaigns SET window_end='14:55' WHERE id=$1",[f.campaign_id]);await assert.rejects(execute(f,plan),/plan_changed/);assert.equal((await jobs(f)).length,10);
      const sibling=await fixture();await query("INSERT INTO cabinet_campaigns(owner_id,connection_id,name,daily_limit,window_start,window_end) VALUES($1,$2,'sibling',20,'12:02','13:55')",[sibling.owner_id,sibling.connection_id]);
      await assert.rejects(prepare(sibling,sibling.p,{...sibling.input,daily_limit:20,campaign_window_end:'15:55'}),/connection_schedule_conflict/);
    });
    await t.test('strict input rejects caller day, ceiling, identities, duplicates, invalid windows and more than two',async()=>{
      const f=await fixture();for(const input of [{...f.input,one_off_day:'2026-11-28'},{...f.input,daily_limit:99},{...f.input,paused:false},{...f.input,draft_ids:[]},{...f.input,draft_ids:[f.drafts[0].id,f.drafts[0].id]},{...f.input,draft_ids:[...f.input.draft_ids,randomUUID()]},{...f.input,window_end:'25:00'},{...f.input,window_end:'13:00'}])await assert.rejects(prepare(f,f.p,input),/one_off_invalid/);
    });
    await t.test('both scopes and cabinet-wide ownership required at prepare and execute',async()=>{
      const f=await fixture();for(const scopes of [['outreach:send'],['outreach:draft'],['outreach:read']]){const tok=await f.token(scopes);await assert.rejects(prepare(f,tok.p),/scope_denied/);}
      const selected=await f.token(undefined,false);await assert.rejects(prepare(f,selected.p),/one_off_requires_all_campaigns/);
      const foreign=await fixture();await assert.rejects(store.prepareOneOff(f.p,foreign.campaign_id,foreign.input),/campaign_not_found/);
      const tok=await f.token(),plan=await prepare(f,tok.p);await assert.rejects(execute(f,plan,{...tok.p,scopes:['outreach:send']}),/scope_denied/);
      await assert.rejects(execute(f,plan,{...tok.p,all_campaigns:false}),/one_off_requires_all_campaigns/);
      const other=await f.token();await assert.rejects(execute(f,plan,other.p),/confirmation_invalid/);
    });
    await t.test('outstanding jobs anywhere on connection block prepare and invalidate execute',async()=>{
      for(const status of ['queued','sending','uncertain']){const f=await fixture(),plan=await prepare(f);await query('UPDATE cabinet_jobs SET status=$2 WHERE id=(SELECT id FROM cabinet_jobs WHERE owner_id=$1 LIMIT 1)',[f.owner_id,status]);await assert.rejects(execute(f,plan),/plan_changed/);await assert.rejects(prepare(f),/one_off_outstanding_jobs/);}
    });
    await t.test('all approval state changes reject atomically',async()=>{
      for(const [table,set] of [['cabinet_drafts',"body='changed'"],['cabinet_drafts','stopped=true'],['cabinet_drafts',"recipient_id=recipient_id+100000"],['cabinet_campaigns','paused=false'],['cabinet_campaigns','daily_limit=11'],['cabinet_connections','generation=generation+1'],['cabinet_connections',"status='error'"],['cabinet_connections',"username='changed'"],['cabinet_jobs',"status='failed'"]]){
        const f=await fixture(),plan=await prepare(f);await query(`UPDATE ${table} SET ${set} WHERE owner_id=$1`,[f.owner_id]);const before=await jobs(f);await assert.rejects(execute(f,plan),/plan_changed/);assert.deepEqual(await jobs(f),before);
      }
    });
    await t.test('old day, expired window, stale slots and inadequate remaining window never roll over',async()=>{
      const f=await fixture();await assert.rejects(prepare(f,f.p,{...f.input,window_start:'14:01',window_end:'14:02'}),/one_off_capacity/);
      const plan=await prepare(f);clock=new Date('2026-11-27T12:01:00Z');await assert.rejects(execute(f,plan),/one_off_expired/);
      clock=new Date('2026-11-28T10:00:00Z');await assert.rejects(execute(f,plan),/one_off_expired/);
      clock=new Date('2026-11-27T11:02:00Z');await query('UPDATE cabinet_connections SET heartbeat_at=$2 WHERE id=$1',[f.connection_id,clock]);await assert.rejects(execute(f,plan),/plan_schedule_expired/);
    });
    await t.test('two plans cannot reuse capacity and 12 consumed attempts prevent further allowance',async()=>{
      const f=await fixture(),a=await prepare(f),b=await prepare(f);const settled=await Promise.allSettled([execute(f,a),execute(f,b)]);assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal((await jobs(f)).length,12);
      await query("UPDATE cabinet_jobs SET status='sent' WHERE owner_id=$1",[f.owner_id]);
      const d=await store.saveDraft(f.p,f.campaign_id,{address:'https://t.me/new_extra',recipient_id:'9919999',body:'No third extra',permission_kind:'consent',permission_evidence:'Confirmed permission'});
      await assert.rejects(prepare(f,f.p,{...f.input,draft_ids:[d.id]}),/one_off_capacity/);
      const full=await fixture(12);await assert.rejects(prepare(full),/one_off_capacity/);
    });
    await t.test('connection state is refreshed after acquiring its row lock',async()=>{
      const f=await fixture();let reached;const ready=new Promise(r=>{reached=r;});
      const waiting=createCabinetStore({query,now:()=>clock,sendEnabled:true,withClient:fn=>withClient(db=>fn({query:async(sql,args)=>{if(sql.startsWith('SELECT id FROM cabinet_connections'))reached();return db.query(sql,args);}}))});
      const control=await pool.connect();await control.query('BEGIN');await control.query("UPDATE cabinet_connections SET generation=generation+1,username='fresh_sender' WHERE id=$1",[f.connection_id]);
      const pending=waiting.prepareOneOff(f.p,f.campaign_id,f.input);await ready;await control.query('COMMIT');control.release();const plan=await pending;assert.equal(plan.preview.sender,'fresh_sender');await execute(f,plan);
    });
    await t.test('first approved slot preserves three-minute spacing from a recent past attempt',async()=>{
      const f=await fixture();const last=new Date('2026-11-27T10:59:30Z');
      await query('UPDATE cabinet_jobs SET attempted_at=$2 WHERE id=(SELECT id FROM cabinet_jobs WHERE owner_id=$1 LIMIT 1)',[f.owner_id,last]);
      const plan=await prepare(f);assert.ok(new Date(plan.preview.items[0].scheduled_at)-last>=180000);
      await assert.rejects(prepare(f,f.p,{...f.input,draft_ids:[f.drafts[0].id],window_end:'14:02'}),/one_off_capacity/);
    });
    await t.test('expired or wrong-action confirmations and invalid one-off metadata fail closed',async()=>{
      const f=await fixture(),plan=await prepare(f);
      await assert.rejects(store.execute(f.p,{confirmation_token:plan.confirmation_token,confirm:true,kind:'launch'}),/confirmation_wrong_action/);
      const ordinary=await store.prepare(f.p,f.campaign_id,{draft_ids:f.input.draft_ids});
      await query("UPDATE cabinet_plans SET expires_at=clock_timestamp()+interval '10 minutes' WHERE token_hash=$1",[digest(ordinary.confirmation_token)]);
      await assert.rejects(execute(f,ordinary),/confirmation_wrong_action/);
      await assert.rejects(store.executeOneOff(f.p,{confirmation_token:plan.confirmation_token,confirm:true,daily_limit:99}),/one_off_invalid/);
      await query("UPDATE cabinet_plans SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[digest(plan.confirmation_token)]);
      await assert.rejects(execute(f,plan),/confirmation_invalid/);
      const fresh=await prepare(f);await execute(f,fresh);
      const j=(await jobs(f)).find(j=>j.one_off_day);
      for(const set of ["one_off_day=NULL","one_off_daily_limit=101","one_off_window_end=one_off_window_start","scheduled_at=scheduled_at+interval '1 day'","scheduled_at='2026-11-27T20:00:00Z'"])
        await assert.rejects(query(`UPDATE cabinet_jobs SET ${set} WHERE id=$1`,[j.id]),e=>e.code==='23514');
      const old=(await jobs(f)).find(j=>!j.one_off_day);
      await assert.rejects(query('UPDATE cabinet_jobs SET one_off_daily_limit=12 WHERE id=$1',[old.id]),e=>e.code==='23514');
    });
    await t.test('execution rereads state after a concurrent connection update resolves',async()=>{
      const f=await fixture(),plan=await prepare(f);let reached;const ready=new Promise(r=>{reached=r;});
      const waiting=createCabinetStore({query,now:()=>clock,sendEnabled:true,withClient:fn=>withClient(db=>fn({query:async(sql,args)=>{if(sql.startsWith('SELECT id FROM cabinet_connections'))reached();return db.query(sql,args);}}))});
      const control=await pool.connect();await control.query('BEGIN');await control.query('UPDATE cabinet_connections SET generation=generation+1 WHERE id=$1',[f.connection_id]);
      const pending=waiting.executeOneOff(f.p,{confirmation_token:plan.confirmation_token,confirm:true});await ready;await control.query('COMMIT');control.release();await assert.rejects(pending,/plan_changed/);assert.equal((await jobs(f)).length,10);
    });
    await t.test('HTTP exposes strict prepare/execute endpoints and no additional delivery controls',async()=>{
      const f=await fixture(),tok=await f.token();
      const request=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/cabinet${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tok.raw},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
      const bad=await request(`/campaigns/${f.campaign_id}/one-off/prepare`,{...f.input,daily_limit:101});assert.equal(bad.status,400);assert.equal(bad.data.error,'one_off_invalid');
      assert.equal((await request('/one-off/execute',{confirmation_token:'plan_12345678901234567890',confirm:false})).status,400);
    });
  }finally{await new Promise(r=>server.close(r));await pool.end();}
});
