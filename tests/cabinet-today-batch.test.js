import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createCabinetStore,scheduleJobs} from '../src/cabinet/store.js';

test('ordinary scheduling still skips weekends; explicit same-day scheduling can include them',()=>{
 const input={now:new Date('2026-11-28T06:00:00Z'),window_start:'12:02',window_end:'15:55',daily_limit:20,count:20,random:()=>0.5};
 assert.ok(scheduleJobs(input).every(d=>d.startsWith('2026-11-30')));
 assert.ok(scheduleJobs({...input,include_weekends:true}).every(d=>d.startsWith('2026-11-28')));
});

const connectionString=process.env.CABINET_TEST_DATABASE_URL;
test('reviewed today batch supports twenty truthful public-context messages without changing ordinary delivery', {skip:!connectionString},async t=>{
 const url=new URL(connectionString);assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&/^\/cabinet_test(?:_[a-z0-9]+)?$/.test(url.pathname));
 const pool=new pg.Pool({connectionString}),query=pool.query.bind(pool),withClient=async fn=>{const db=await pool.connect();try{return await fn(db);}finally{db.release();}};
 let clock=new Date('2026-11-28T06:00:00Z');
 const store=createCabinetStore({query,withClient,sendEnabled:true,now:()=>clock});
 const jobs=async f=>(await query('SELECT * FROM cabinet_jobs WHERE owner_id=$1 ORDER BY id',[f.owner_id])).rows;
 async function fixture(){
  clock=new Date('2026-11-28T06:00:00Z');
  const owner_id=randomUUID(),connection_id=randomUUID(),campaign_id=randomUUID(),sid=randomUUID();
  await query('INSERT INTO cabinet_accounts(id,login,display_name) VALUES($1,$2,$2)',[owner_id,'today-'+owner_id]);
  await query("INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,'test',now()+interval '1 hour')",[sid,owner_id]);
  const p={kind:'owner',owner_id,actor_key:'session:'+sid};
  await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username,username,telegram_user_id,status,generation,heartbeat_at) VALUES($1,$2,'sender','today_sender','today_sender',abs(hashtext($2::uuid::text))::bigint+40000000000,'connected',7,$3)",[connection_id,owner_id,clock]);
  await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name,daily_limit,window_start,window_end) VALUES($1,$2,$3,'today',20,'12:02','15:55')",[campaign_id,owner_id,connection_id]);
  const drafts=[];
  for(let n=0;n<21;n++)drafts.push(await store.saveDraft(p,campaign_id,{address:'https://t.me/context_'+n,recipient_id:String(9900000+n),body:'Saw your public message. Do you need wrapping?',source_url:'https://t.me/carclub/123',permission_kind:'public_context',permission_evidence:JSON.stringify({date:'2026-11-18',quote:'I bought a vehicle in Moscow.',source_url:'https://t.me/carclub/123'})}));
  return {p,owner_id,connection_id,campaign_id,drafts,input:{draft_ids:drafts.slice(0,20).map(d=>d.id),window_start:'12:02',window_end:'15:55'}};
 }
 const prepare=f=>store.prepareTodayBatch(f.p,f.campaign_id,f.input);
 const execute=(f,plan)=>store.executeOneOff(f.p,{confirm:true,confirmation_token:plan.confirmation_token});
 try{
  await t.test('prepare is inert, previews basis and exact texts, execute pins twenty Saturday jobs',async()=>{
   const f=await fixture(),plan=await prepare(f);assert.equal(plan.requires_confirmation,true);assert.equal(plan.preview.launch_mode,'today_batch');
   assert.equal(plan.preview.one_off_daily_limit,20);assert.equal(plan.preview.one_off_day,'2026-11-28');assert.equal(plan.preview.items.length,20);
   assert.ok(plan.preview.items.every(i=>i.scheduled_at.startsWith('2026-11-28')&&i.permission_kind==='public_context'&&JSON.parse(i.permission_evidence).quote==='I bought a vehicle in Moscow.'&&i.source_url==='https://t.me/carclub/123'));
   assert.equal((await jobs(f)).length,0);await execute(f,plan);assert.equal((await jobs(f)).length,20);assert.ok((await jobs(f)).every(j=>j.one_off_mode==='today_batch'));
   assert.deepEqual((await query('SELECT daily_limit,window_start,window_end FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],{daily_limit:20,window_start:'12:02:00',window_end:'15:55:00'});
   await assert.rejects(execute(f,plan),/confirmation_invalid/);
  });
  await t.test('public context cannot pass through ordinary launch or legacy two-message exception',async()=>{
   const f=await fixture();await assert.rejects(store.prepare(f.p,f.campaign_id,{draft_ids:[f.drafts[0].id]}),/draft_not_eligible/);
   await assert.rejects(store.prepareOneOff(f.p,f.campaign_id,{...f.input,draft_ids:[f.drafts[0].id]}),/draft_not_eligible/);
  });
  await t.test('context evidence is truthful, linked and nonempty; unknown kinds still rejected',async()=>{
   const f=await fixture(),d=f.drafts[0];
   for(const edit of [{permission_kind:'public_context',permission_evidence:'yes'},{permission_kind:'public_context',permission_evidence:'Long enough but no public source URL included here',source_url:'https://example.com/test'},{permission_kind:'unknown',permission_evidence:'invalid'}])await assert.rejects(store.editDraft(f.p,f.campaign_id,d.id,edit));
   for(const evidence of ['https://t.me/carclub/123 unrelated filler',{date:'2026-02-30',quote:'Real quotation goes here',source_url:d.source_url},{date:'2026-11-29',quote:'Real quotation goes here',source_url:d.source_url},{date:'2026-11-18',quote:'',source_url:d.source_url},{date:'2026-11-18',quote:'Real quotation goes here',source_url:'https://t.me/carclub/999'}]){
    const edit={permission_kind:'public_context',source_url:d.source_url,permission_evidence:typeof evidence==='string'?evidence:JSON.stringify(evidence)};await assert.rejects(store.editDraft(f.p,f.campaign_id,d.id,edit),/public_context_evidence_required/);
   }
  });
  await t.test('strict twenty limit, no permanent setting edits, duplicate IDs and daily quota',async()=>{
   const f=await fixture();for(const input of [{...f.input,draft_ids:f.drafts.map(d=>d.id)},{...f.input,draft_ids:[f.drafts[0].id,f.drafts[0].id]},{...f.input,daily_limit:100},{...f.input,campaign_window_end:'23:59'},{...f.input,one_off_day:'2026-11-29'},{...f.input,window_start:'11:59'},{...f.input,window_end:'16:00'}])await assert.rejects(store.prepareTodayBatch(f.p,f.campaign_id,input));
   await query('UPDATE cabinet_campaigns SET daily_limit=10 WHERE id=$1',[f.campaign_id]);await assert.rejects(prepare(f),/one_off_capacity/);
  });
  await t.test('stops, no permission, cross-sender history and changed approval state remain protected',async()=>{
   for(const mutation of ["UPDATE cabinet_drafts SET stopped=true WHERE owner_id=$1","UPDATE cabinet_drafts SET permission_kind=NULL WHERE owner_id=$1","UPDATE cabinet_connections SET generation=generation+1 WHERE owner_id=$1"]){const f=await fixture(),plan=await prepare(f);await query(mutation,[f.owner_id]);await assert.rejects(execute(f,plan),/plan_changed/);assert.equal((await jobs(f)).length,0);}
   const f=await fixture();const other=randomUUID(),otherCampaign=randomUUID();await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username) VALUES($1,$2,'other','other_sender')",[other,f.owner_id]);await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name) VALUES($1,$2,$3,'other')",[otherCampaign,f.owner_id,other]);
   const otherDraft=await store.saveDraft(f.p,otherCampaign,{address:f.drafts[0].address,recipient_id:String(f.drafts[0].recipient_id),body:'previous inquiry',permission_kind:'request',permission_evidence:'Previous service request'});
   await query("INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at,status,attempted_at) VALUES($1,$2,$3,$4,$5,$6,'prior',$8,$7,'sent',$7)",[f.owner_id,otherDraft.id,otherCampaign,other,f.drafts[0].address,f.drafts[0].recipient_id,clock,String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15)))]);await assert.rejects(prepare(f),/draft_not_eligible/);
  });
  await t.test('same-day plan cannot roll over or execute after a previewed slot',async()=>{
   const f=await fixture(),plan=await prepare(f);clock=new Date('2026-11-29T06:00:00Z');await assert.rejects(execute(f,plan),/one_off_expired/);assert.equal((await jobs(f)).length,0);
  });
  await t.test('cross-profile stop added after prepare invalidates whole batch; foreign cabinet does not',async()=>{
   const f=await fixture(),foreign=await fixture();await query('UPDATE cabinet_drafts SET stopped=true WHERE owner_id=$1',[foreign.owner_id]);
   const sibling=randomUUID();await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name,daily_limit,window_start,window_end) VALUES($1,$2,$3,'sibling',20,'12:02','15:55')",[sibling,f.owner_id,f.connection_id]);
   const duplicate=await store.saveDraft(f.p,sibling,{address:f.drafts[0].address,recipient_id:String(f.drafts[0].recipient_id),body:'stopped elsewhere'});const plan=await prepare(f);await query('UPDATE cabinet_drafts SET stopped=true WHERE id=$1',[duplicate.id]);await assert.rejects(execute(f,plan),/plan_changed/);assert.equal((await jobs(f)).length,0);await assert.rejects(prepare(f),/draft_not_eligible/);
  });
  await t.test('cross-profile send added after prepare invalidates the plan',async()=>{
   const f=await fixture(),connection=randomUUID(),campaign=randomUUID();await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username) VALUES($1,$2,'other','other_sender')",[connection,f.owner_id]);await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name) VALUES($1,$2,$3,'other')",[campaign,f.owner_id,connection]);
   const d=await store.saveDraft(f.p,campaign,{address:f.drafts[0].address,recipient_id:String(f.drafts[0].recipient_id),body:'previous request'}),plan=await prepare(f);
   await query("INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,scheduled_at,status,attempted_at) VALUES($1,$2,$3,$4,$5,$6,'prior',$8,$7,'sent',$7)",[f.owner_id,d.id,campaign,connection,d.address,d.recipient_id,clock,String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15)))]);await assert.rejects(execute(f,plan),/plan_changed/);assert.equal((await jobs(f)).filter(j=>j.campaign_id===f.campaign_id).length,0);
  });
  await t.test('competing approved plans cannot reserve forty messages',async()=>{
   const f=await fixture(),a=await prepare(f),b=await prepare(f),results=await Promise.allSettled([execute(f,a),execute(f,b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await jobs(f)).length,20);
  });
 }finally{await pool.end();}
});
