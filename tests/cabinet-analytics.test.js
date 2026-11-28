import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {createCabinetStore} from '../src/cabinet/store.js';
import {createCabinet} from '../src/cabinet/router.js';
import {digest} from '../src/cabinet/security.js';

const connectionString=process.env.CABINET_TEST_DATABASE_URL;
test('cabinet conversion statistics and evidence-based outcomes', {skip:!connectionString},async t=>{
 const u=new URL(connectionString);assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&/^\/cabinet_test(?:_[a-z0-9]+)?$/.test(u.pathname));
 const pool=new pg.Pool({connectionString}), query=pool.query.bind(pool);
 const withClient=async fn=>{const db=await pool.connect();try{return await fn(db);}finally{db.release();}};
 const store=createCabinetStore({query,withClient});
 const app=express();app.use(express.json());app.use('/api/cabinet',createCabinet({query,withClient,env:{nodeEnv:'development'}}).router);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const owners=[];
 async function fixture(){
  const owner_id=randomUUID(), connection_id=randomUUID(),campaign_id=randomUUID();owners.push(owner_id);
  await query('INSERT INTO cabinet_accounts(id,login,display_name) VALUES($1,$2,$2)',[owner_id,'stats-'+owner_id]);
  await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username) VALUES($1,$2,'Test','stats_sender')",[connection_id,owner_id]);
  await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name) VALUES($1,$2,$3,'Stats')",[campaign_id,owner_id,connection_id]);
  const sid=randomUUID(),tokenId=randomUUID(),rawToken='ocp_'+randomUUID();
  await query("INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,'test',now()+interval '1 hour')",[sid,owner_id]);
  await query("INSERT INTO cabinet_api_tokens(id,owner_id,name,token_hash,display_prefix,scopes,campaign_ids,expires_at) VALUES($1,$2,'Agent',$3,'test',ARRAY['outreach:read','outreach:draft'],$4,now()+interval '1 hour')",[tokenId,owner_id,digest(rawToken),[campaign_id]]);
  const p={kind:'owner',owner_id,actor_key:'session:'+sid};
  const agent={kind:'token',id:tokenId,owner_id,actor_key:'token:'+tokenId,scopes:['outreach:read','outreach:draft'],campaign_ids:[campaign_id],all_campaigns:false};
  let serial=1;
  async function job(uid='12345',at='2026-11-27T09:00:00Z',status='sent',group='public_group'){
   const draft=await query("INSERT INTO cabinet_drafts(owner_id,campaign_id,address,recipient_id,name,body,source_url) VALUES($1,$2,'https://t.me/test_person',$3,'Person','Service message',$4) ON CONFLICT(campaign_id,recipient_id) DO UPDATE SET name=EXCLUDED.name RETURNING id",[owner_id,campaign_id,uid,`https://t.me/${group}/123`]);
   const mid=serial++;const j=(await query("INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,status,scheduled_at,completed_at,telegram_message_id) VALUES($1,$2,$3,$4,'https://t.me/test_person',$5,'Service message',$6,$7,$8,$9,$10) RETURNING *",[owner_id,draft.rows[0].id,campaign_id,connection_id,uid,Math.floor(Math.random()*1e15)+1,status,at,status==='sent'?at:null,status==='sent'?mid:null])).rows[0];
   if(status==='sent')await message(j,'outbound','Service message',at,mid);
   return j;
  }
  async function message(j,direction='inbound',body='Сколько стоит?',at='2026-11-28T07:00:00Z',mid=serial++){
   await query('INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[owner_id,j.id,connection_id,j.recipient_id,mid,direction,body,at]);return String(mid);
  }
  const reviews=(params={})=>store.conversationReviews(p,campaign_id,{pending_only:false,...params});
  const save=(row,extra={},principal=agent)=>store.saveConversationOutcome(principal,campaign_id,row.job_id,{status:'interested',reason:'Получатель попросил стоимость работ',expected_snapshot:row.snapshot,evidence_message_ids:row.evidence_test??[row.last_inbound_message_id],...extra});
  return {p,agent,rawToken,owner_id,campaign_id,job,message,reviews,save};
 }
 try{
  await t.test('unique recipients, followups, late replies and Moscow cohorts',async()=>{
   const f=await fixture();const j=await f.job();await f.message(j);await f.message(j);await f.message(j,'outbound','Ответ мастера');
   const again=await f.job('12345','2026-11-28T08:00:00Z');await f.message(again);
   await f.job('23456','2026-11-27T20:59:59Z');await f.job('34567','2026-11-27T21:00:00Z');
   await f.job('45678','2026-11-27T10:00:00Z','failed');await f.job('56789','2026-11-27T10:00:00Z','uncertain');
   const s=await store.campaignStats(f.p,f.campaign_id,{from:'2026-11-27',to:'2026-11-27'});
   assert.equal(s.totals.sent,2);assert.equal(s.totals.replied,1);assert.equal(s.totals.reply_rate,50);
   assert.equal(s.totals.needs_review,1);assert.equal(s.by_day.length,1);
   assert.equal((await store.campaignStats(f.p,f.campaign_id,{from:'2026-11-28',to:'2026-11-28'})).totals.sent,1);
  });
  await t.test('empty denominator, source filters, invalid dates and media-only replies',async()=>{
   const f=await fixture();let s=await store.campaignStats(f.p,f.campaign_id,{});assert.equal(s.totals.reply_rate,null);
   const j=await f.job('12345',undefined,undefined,'LiAuto');await f.message(j,'inbound','');
   s=await store.campaignStats(f.p,f.campaign_id,{group_username:'liauto'});assert.equal(s.totals.sent,1);assert.equal(s.totals.replied,1);
   assert.equal((await store.campaignStats(f.p,f.campaign_id,{group_username:'other_group'})).totals.sent,0);
   for(const filters of [{from:'2026-02-30'},{from:'2026-11-28',to:'2026-11-27'},{group_username:'x;DROP TABLE x'},{owner_id:randomUUID()}])await assert.rejects(store.campaignStats(f.p,f.campaign_id,filters));
  });
  await t.test('saved assessment drives rates, late messages invalidate agent snapshot, duplicate write is idempotent',async()=>{
   const f=await fixture();const j=await f.job();const evidence=await f.message(j);
   let row=(await f.reviews()).items[0];const before=(await query('SELECT revision,paused FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0];
   await f.save(row,{evidence_message_ids:[evidence]});await f.save(row,{evidence_message_ids:[evidence]});
   let s=await store.campaignStats(f.p,f.campaign_id,{});assert.equal(s.totals.interested,1);assert.equal(s.totals.interested_rate,100);
   assert.equal((await store.conversationReviews(f.agent,f.campaign_id,{pending_only:true})).items.length,0);
   await f.message(j,'inbound','Уже не актуально');
   s=await store.campaignStats(f.p,f.campaign_id,{});assert.equal(s.totals.interested,0);assert.equal(s.totals.needs_review,1);
   await assert.rejects(f.save(row,{evidence_message_ids:[evidence]}),/outcome_snapshot_changed/);
   assert.deepEqual((await query('SELECT revision,paused FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],before);
   assert.equal((await query('SELECT count(*)::int n FROM cabinet_jobs WHERE owner_id=$1',[f.owner_id])).rows[0].n,1);
  });
  await t.test('read+draft scopes, campaign ownership and exact evidence are enforced',async()=>{
   const f=await fixture(),other=await fixture();const j=await f.job();const mid=await f.message(j);const foreign=await other.job();const foreignMid=await other.message(foreign);
   const row=(await f.reviews()).items[0];
   await assert.rejects(store.campaignStats(other.p,f.campaign_id,{}),/campaign_not_found/);
   for(const scopes of [['outreach:read'],['outreach:draft']])await assert.rejects(f.save(row,{}, {...f.agent,scopes}),/scope_denied/);
   await assert.rejects(f.save(row,{}, {...f.agent,campaign_ids:[]}),/campaign_not_found/);
   await assert.rejects(f.save(row,{evidence_message_ids:['999999']}),/outcome_evidence_invalid/);
   // Same numeric Telegram ID in another owner's account is not evidence for a foreign job.
   await assert.rejects(store.saveConversationOutcome(f.agent,f.campaign_id,foreign.id,{status:'interested',reason:'test',expected_snapshot:row.snapshot,evidence_message_ids:[foreignMid]}),/thread_not_found/);
   await assert.rejects(f.save(row,{owner_id:other.owner_id,evidence_message_ids:[mid]}),/outcome_invalid/);
   await assert.rejects(f.save(row,{status:'booked',evidence_message_ids:[mid]}),/outcome_booking_evidence_required/);
  });
  await t.test('booking needs both sides and manual corrections are protected',async()=>{
   const f=await fixture(),j=await f.job();const mid=await f.message(j,'inbound','Подтверждаю запись на 30 ноября');
   let row=(await f.reviews()).items[0];await f.save(row,{status:'booked',reason:'Мастер предложил дату, клиент подтвердил',evidence_message_ids:['1',mid]});
   let s=await store.campaignStats(f.p,f.campaign_id,{});assert.equal(s.totals.booked,1);assert.equal(s.totals.interested,1);
   row=(await f.reviews()).items[0];await f.save(row,{status:'later',reason:'Клиент перенёс запись по телефону',evidence_message_ids:[mid]},f.p);
   row=(await f.reviews()).items[0];await assert.rejects(f.save(row),/outcome_manual_locked/);
   await f.message(j,'inbound','Позже уточню дату');
   s=await store.campaignStats(f.p,f.campaign_id,{});assert.equal(s.totals.later,1);
   assert.equal((await store.conversationReviews(f.agent,f.campaign_id,{pending_only:true})).items.length,0);
  });
  await t.test('review list pagination is stable and exposes no unrelated conversations',async()=>{
   const f=await fixture();for(let i=0;i<3;i++){const j=await f.job(String(80000+i));await f.message(j);}
   const one=await f.reviews({page:1,page_size:2});const two=await f.reviews({page:2,page_size:2});
   assert.equal(one.total,3);assert.equal(one.items.length,2);assert.equal(two.items.length,1);
   assert.equal(new Set([...one.items,...two.items].map(x=>x.recipient_id)).size,3);
   assert.ok(one.items.every(x=>x.snapshot&&x.job_ids.length===1&&x.last_inbound_message_id));
  });
  await t.test('deferred worklist keeps undated contacts across cohort periods and owner dates stay separate from classification',async()=>{
   const f=await fixture(),j=await f.job('99101','2026-10-01T09:00:00Z');await f.message(j,'inbound','Пока отложил');
   let row=(await f.reviews()).items[0];await f.save(row,{status:'later',reason:'Клиент пока отложил работу'});
   let list=await store.followUps(f.agent,f.campaign_id,{});assert.equal(list.total,1);assert.equal(list.totals.undated,1);assert.equal(list.items[0].follow_up_on,null);
   const before=(await query('SELECT revision FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0].revision;
   row=list.items[0];await store.saveFollowUp(f.p,f.campaign_id,j.id,{follow_up_on:list.today,follow_up_note:'Вернуться к обсуждению крыши',expected_snapshot:row.snapshot});
   list=await store.followUps(f.agent,f.campaign_id,{view:'due'});assert.equal(list.total,1);assert.equal(list.items[0].follow_up_note,'Вернуться к обсуждению крыши');assert.equal(list.items[0].review_source,'agent');
   assert.equal((await query('SELECT revision FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0].revision,before);
   await f.message(j,'inbound','Пока всё так же');row=(await f.reviews()).items[0];
   assert.equal((await store.followUps(f.agent,f.campaign_id,{})).total,1); // stale assessments cannot silently lose deferred contacts
   await f.save(row,{status:'later',reason:'Повторно подтвердил отсрочку'});list=await store.followUps(f.agent,f.campaign_id,{});assert.equal(list.items[0].follow_up_on,list.today);
   row=(await f.reviews()).items[0];await f.save(row,{status:'interested',reason:'Возобновил обсуждение цены'});assert.equal((await store.followUps(f.agent,f.campaign_id,{})).total,0);
   row=(await f.reviews()).items[0];assert.equal(row.follow_up_on,list.today);assert.equal(row.follow_up_note,'Вернуться к обсуждению крыши');
  });
  await t.test('follow-up views, ordering and paging preserve exact Moscow date boundaries',async()=>{
   const f=await fixture();const today=(await query("SELECT (now() AT TIME ZONE 'Europe/Moscow')::date::text AS day")).rows[0].day;
   for(let i=0;i<4;i++){const j=await f.job(String(99200+i));await f.message(j);const row=(await f.reviews()).items.find(x=>x.job_id===j.id);await f.save(row,{status:'later',reason:'Клиент отложил до уточнения'});
    if(i)await store.saveFollowUp(f.p,f.campaign_id,j.id,{follow_up_on:i===1?today:i===2?'2099-01-01':'2020-01-01',follow_up_note:'',expected_snapshot:row.snapshot});
   }
   const all=await store.followUps(f.p,f.campaign_id,{page:1,page_size:2});assert.deepEqual(all.totals,{total:4,undated:1,due:2,upcoming:1});assert.equal(all.today,today);assert.equal(all.items[0].follow_up_on,'2020-01-01');assert.equal(all.items[1].follow_up_on,today);
   assert.equal((await store.followUps(f.p,f.campaign_id,{view:'undated'})).total,1);assert.equal((await store.followUps(f.p,f.campaign_id,{view:'upcoming'})).total,1);
   assert.equal((await store.followUps(f.p,f.campaign_id,{page:2,page_size:2})).items.length,2);
   await assert.rejects(store.followUps(f.p,f.campaign_id,{view:'unknown'}),/follow_up_filters_invalid/);
  });
  await t.test('only owner can manually schedule a deferred contact, scoped and snapshot checked',async()=>{
   const f=await fixture(),other=await fixture(),j=await f.job();await f.message(j);let row=(await f.reviews()).items[0];await f.save(row,{status:'later',reason:'Клиент отложил решение'});
   const input={follow_up_on:'2026-12-12',follow_up_note:'Через пару недель',expected_snapshot:row.snapshot};
   await assert.rejects(store.saveFollowUp(f.agent,f.campaign_id,j.id,input),/owner_session_required/);
   await assert.rejects(store.saveFollowUp(other.p,f.campaign_id,j.id,input),/campaign_not_found/);
   await assert.rejects(store.followUps(other.agent,f.campaign_id,{}),/scope_denied|campaign_not_found/);
   for(const invalid of [{...input,follow_up_on:'2026-02-30'},{...input,follow_up_on:undefined},{...input,owner_id:f.owner_id},{...input,expected_snapshot:'x'}])await assert.rejects(store.saveFollowUp(f.p,f.campaign_id,j.id,invalid),/follow_up_invalid/);
   await f.message(j);await assert.rejects(store.saveFollowUp(f.p,f.campaign_id,j.id,input),/outcome_snapshot_changed/);
   row=(await f.reviews()).items[0];await store.saveFollowUp(f.p,f.campaign_id,j.id,{...input,follow_up_on:null,follow_up_note:'Пока без даты',expected_snapshot:row.snapshot});
   assert.equal((await store.followUps(f.p,f.campaign_id,{})).items[0].follow_up_on,null);
   await f.save(row,{status:'declined',reason:'Не актуально'});await assert.rejects(store.saveFollowUp(f.p,f.campaign_id,j.id,{...input,expected_snapshot:row.snapshot}),/follow_up_not_deferred/);
  });
  await t.test('HTTP metrics, paginated review and outcome routes enforce token boundaries',async()=>{
   const f=await fixture(),other=await fixture();const j=await f.job();await f.message(j);
   const url=`http://127.0.0.1:${server.address().port}/api/cabinet/campaigns/${f.campaign_id}`;
   const headers={authorization:'Bearer '+f.rawToken,'content-type':'application/json'};
   let r=await fetch(url+'/stats?from=2026-11-27&to=2026-11-27',{headers});assert.equal(r.status,200);assert.equal((await r.json()).totals.replied,1);
   r=await fetch(url+'/reviews?pending_only=true',{headers});assert.equal(r.status,200);const row=(await r.json()).items[0];
   r=await fetch(url+'/reviews/'+row.job_id,{method:'PATCH',headers,body:JSON.stringify({status:'interested',reason:'Запросил стоимость',expected_snapshot:row.snapshot,evidence_message_ids:[row.last_inbound_message_id]})});assert.equal(r.status,200);
   assert.equal((await r.json()).review_source,'agent');
   r=await fetch(url+'/reviews/'+row.job_id,{method:'PATCH',headers,body:JSON.stringify({status:'later',reason:'Клиент попросил вернуться позже',expected_snapshot:row.snapshot,evidence_message_ids:[row.last_inbound_message_id]})});assert.equal(r.status,200);
   r=await fetch(url+'/followups?view=undated',{headers});assert.equal(r.status,200);assert.equal((await r.json()).total,1);
   r=await fetch(url+'/followups/'+row.job_id,{method:'PATCH',headers,body:JSON.stringify({follow_up_on:'2026-12-12',follow_up_note:'',expected_snapshot:row.snapshot})});assert.equal(r.status,403);

   r=await fetch(url+'/stats',{headers:{authorization:'Bearer '+other.rawToken}});assert.equal(r.status,404);
  });
  await t.test('concurrent ingestion invalidates a pending write under the same reply lock',async()=>{
   const f=await fixture(),j=await f.job();await f.message(j);const row=(await f.reviews()).items[0];
   const db=await pool.connect();try{
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['cabinet-replies:'+j.connection_id]);
    const assertion=assert.rejects(f.save(row),/outcome_snapshot_changed/);
    await new Promise(r=>setTimeout(r,20));
    await db.query("INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at) VALUES($1,$2,$3,$4,999,'inbound','Не актуально',now())",[f.owner_id,j.id,j.connection_id,j.recipient_id]);
    await db.query('COMMIT');await assertion;
   }finally{await db.query('ROLLBACK');db.release();}
  });
  await t.test('manual result cannot turn an unanswered recipient into a Telegram reply',async()=>{
   const f=await fixture();await f.job();const row=(await f.reviews()).items[0];
   await f.save(row,{status:'booked',reason:'Запись согласована по телефону',evidence_message_ids:['1']},f.p);
   const s=await store.campaignStats(f.p,f.campaign_id,{});
   assert.equal(s.totals.sent,1);assert.equal(s.totals.replied,0);assert.equal(s.totals.no_reply,1);assert.equal(s.totals.booked,1);assert.equal(s.reply_outcomes.booked,0);assert.equal(Object.values(s.reply_outcomes).reduce((a,b)=>a+b,0),0);
  });
 }finally{
  for(const id of owners)await query('DELETE FROM cabinet_accounts WHERE id=$1',[id]).catch(async()=>{
   await query('DELETE FROM cabinet_conversation_outcomes WHERE owner_id=$1',[id]).catch(()=>{});
   for(const table of ['cabinet_audit','cabinet_messages','cabinet_jobs','cabinet_drafts','cabinet_campaigns','cabinet_connections','cabinet_api_tokens','cabinet_sessions'])await query(`DELETE FROM ${table} WHERE owner_id=$1`,[id]);
   await query('DELETE FROM cabinet_accounts WHERE id=$1',[id]);
  });await new Promise(r=>server.close(r));await pool.end();
 }
});
