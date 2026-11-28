import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readFile} from 'node:fs/promises';

const connectionString=process.env.CABINET_TEST_DATABASE_URL;
test('response schema retains a non-null provenance column and owner-scoped schedule table', {skip:!connectionString},async()=>{
 const url=new URL(connectionString);
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&&/^\/cabinet_test(?:_[a-z0-9]+)?$/.test(url.pathname));
 const pool=new pg.Pool({connectionString});
 try{
  const column=(await pool.query("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_name='cabinet_messages' AND column_name='timestamp_source'")).rows[0];
  assert.ok(column,'persist timestamp provenance for both service anchors and Telegram messages');
  assert.equal(column.is_nullable,'NO');
  assert.match(column.column_default,/telegram/);
  const table=(await pool.query("SELECT to_regclass('cabinet_response_schedules') AS name")).rows[0];
  assert.equal(table.name,'cabinet_response_schedules');
 }finally{await pool.end();}
});


test('migration labels historical service receipts without retiming Telegram messages and constrains calendars', {skip:!connectionString},async()=>{
 const url=new URL(connectionString);assert.match(url.pathname,/^\/cabinet_test(?:_[a-z0-9]+)?$/);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
 const pool=new pg.Pool({connectionString}),db=await pool.connect(),schema='response_migration_'+randomUUID().replaceAll('-','');
 const owner=randomUUID(),campaign=randomUUID(),job=randomUUID(),connection=randomUUID();
 try{
  await db.query('BEGIN');await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET LOCAL search_path TO ${schema}`);
  await db.query(`CREATE TABLE cabinet_accounts(id uuid PRIMARY KEY);
   CREATE TABLE cabinet_campaigns(id uuid,owner_id uuid,UNIQUE(id,owner_id));
   CREATE TABLE cabinet_jobs(id uuid,owner_id uuid,connection_id uuid,recipient_id bigint,telegram_message_id bigint);
   CREATE TABLE cabinet_messages(job_id uuid,owner_id uuid,connection_id uuid,recipient_id bigint,telegram_message_id bigint,direction text,sent_at timestamptz)`);
  await db.query('INSERT INTO cabinet_accounts VALUES($1)',[owner]);await db.query('INSERT INTO cabinet_campaigns VALUES($1,$2)',[campaign,owner]);
  await db.query('INSERT INTO cabinet_jobs VALUES($1,$2,$3,12345,1)',[job,owner,connection]);
  await db.query("INSERT INTO cabinet_messages VALUES($1,$2,$3,12345,1,'outbound','2026-11-27T06:00:01Z'),($1,$2,$3,12345,2,'inbound','2026-11-27T06:00:02Z')",[job,owner,connection]);
  await db.query(await readFile(new URL('../db/migrations/036_cabinet_response_analytics.sql',import.meta.url),'utf8'));
  const rows=(await db.query('SELECT timestamp_source,sent_at FROM cabinet_messages ORDER BY telegram_message_id')).rows;
  assert.deepEqual(rows.map(r=>[r.timestamp_source,r.sent_at.toISOString()]),[['service_receipt','2026-11-27T06:00:01.000Z'],['telegram','2026-11-27T06:00:02.000Z']]);
  for(const weekdays of [[1,1],[0],[8],[],[[1,2],[3,4]]]){
   await db.query('SAVEPOINT invalid_schedule');
   await assert.rejects(db.query("INSERT INTO cabinet_response_schedules(owner_id,campaign_id,weekdays,start_time,end_time,revision) VALUES($1,$2,$3,'09:00','18:00',1)",[owner,campaign,weekdays]),error=>error.code==='23514');
   await db.query('ROLLBACK TO SAVEPOINT invalid_schedule');
  }
 }finally{await db.query('ROLLBACK');db.release();await pool.end();}
});

const implementation=await import('../src/cabinet/response-analytics.js').catch(error=>{
 if(error.code==='ERR_MODULE_NOT_FOUND')return {};
 throw error;
});
function api(name){assert.equal(typeof implementation[name],'function',`${name} implements response analytics`);return implementation[name];}
const schedule={timezone:'Europe/Moscow',weekdays:[1,2,3,4,5],start:'09:00',end:'18:00',revision:0,updated_at:null};

test('working seconds intersect Moscow weekday boundaries, not the elapsed wait',()=>{
 const working=api('workingSeconds');
 const examples=[
  ['2026-11-27T05:00:00Z','2026-11-27T06:00:00Z',0],
  ['2026-11-27T06:00:00Z','2026-11-27T15:00:00Z',32400],
  ['2026-11-27T14:59:59Z','2026-11-27T15:00:01Z',1],
  ['2026-11-27T15:00:00Z','2026-11-30T06:00:00Z',0],
  ['2026-11-27T14:30:00Z','2026-11-30T06:30:00Z',3600],
  ['2026-11-26T14:00:00Z','2026-11-27T07:00:00Z',7200],
  ['2026-11-23T06:00:00Z','2026-11-30T06:00:00Z',162000],
 ];
 for(const [from,to,want] of examples)assert.equal(working(from,to,schedule),want,`${from} to ${to}`);
 assert.equal(working('2026-11-28T06:00:00Z','2026-11-28T07:00:00Z',{...schedule,weekdays:[6]}),3600);
 assert.equal(working('2026-11-27T06:00:00.250Z','2026-11-27T06:00:01.750Z',schedule),1.5);
 assert.equal(working('2026-11-28T00:00:00Z','2026-11-27T00:00:00Z',schedule),null);
 assert.equal(working('invalid','2026-11-27T00:00:00Z',schedule),null);
 // 400 Gregorian years contain exactly 20,871 weeks; calculation stays bounded.
 assert.equal(working('2000-01-03T06:00:00Z','2400-01-03T06:00:00Z',schedule),3381102000);
});

function row(mid,direction,at,extra={}){
 return {job_id:'job-1',connection_id:'connection-1',recipient_id:'12345',address:'https://t.me/person',name:'First Person',source_url:'https://t.me/first_group/1',group_username:'first_group',anchor_message_id:'1',telegram_message_id:String(mid),direction,sent_at:at,timestamp_source:'telegram',...extra};
}
test('episodes retain the first inbound of each burst across verified jobs and separate the client denominator',()=>{
 const episodes=api('buildResponseEpisodes')([
  row(8,'outbound','2026-11-27T09:00:00Z',{job_id:'job-2',anchor_message_id:'6',name:'Changed',group_username:'second_group'}),
  row(4,'inbound','2026-11-27T07:01:00Z'),
  row(1,'outbound','2026-11-27T06:00:00Z',{timestamp_source:'service_receipt'}),
  row(3,'inbound','2026-11-27T07:00:00Z'),
  row(6,'outbound','2026-11-27T07:30:00Z',{job_id:'job-2',anchor_message_id:'6'}),
  row(9,'inbound','2026-11-27T15:30:00Z',{job_id:'job-2',anchor_message_id:'6'}),
 ],{schedule,as_of:'2026-11-28T12:00:00Z'});
 assert.equal(episodes.length,3);
 const artem=episodes.filter(e=>e.side==='artem'),client=episodes.find(e=>e.side==='client');
 assert.equal(artem[0].state,'answered');assert.equal(artem[0].start_message_id,'3');assert.equal(artem[0].end_message_id,'6');
 assert.equal(artem[0].message_count,2);assert.equal(artem[0].elapsed_seconds,1800);assert.equal(artem[0].working_seconds,1800);
 assert.deepEqual(artem[0].job_ids,['job-1','job-2']);assert.equal(artem[0].job_id,'job-1');
 assert.equal(artem[0].name,'First Person');assert.equal(artem[0].group_username,'first_group');
 assert.equal(artem[1].state,'pending');assert.equal(artem[1].elapsed_seconds,73800);assert.equal(artem[1].working_seconds,0);assert.equal(artem[1].end_message_id,null);
 assert.equal(client.elapsed_seconds,3600);assert.equal(client.start_message_id,'1');assert.equal(client.end_message_id,'3');assert.equal(client.start_time_source,'service_receipt');assert.equal(client.end_time_source,'telegram');
});

test('negative, invalid and future pending timestamps stay visible as anomalies',()=>{
 const build=api('buildResponseEpisodes');
 for(const [start,end,as_of,reason] of [
  ['2026-11-27T09:00:00Z','2026-11-27T08:00:00Z','2026-11-28T00:00:00Z','negative_duration'],
  ['invalid','2026-11-27T08:00:00Z','2026-11-28T00:00:00Z','invalid_timestamp'],
  ['2026-11-29T09:00:00Z',null,'2026-11-28T00:00:00Z','negative_duration'],
 ]){
  const rows=[row(1,'outbound','2026-11-27T06:00:00Z'),row(2,'inbound',start)];if(end)rows.push(row(3,'outbound',end));
  const episode=build(rows,{schedule,as_of}).find(e=>e.side==='artem');
  assert.equal(episode.state,'anomaly');assert.equal(episode.anomaly_reason,reason);
  assert.equal(episode.elapsed_seconds,null);assert.equal(episode.working_seconds,null);
 }
});

test('analytics validates unknown keys, impossible dates and scalar types before reading data',async()=>{
 const create=api('createResponseAnalytics'),id=randomUUID();
 const methods=create({query:()=>{throw new Error('unexpected data read');},campaign:()=>{throw new Error('unexpected campaign read');}});
 for(const input of [{from:''},{to:''},{group_username:null},{group_username:''},{mode:null},{side:null},{status:null},{page:null},{page_size:null},{extra:1},{from:'2026-02-30'},{from:null},{from:'0000-01-01'},{from:'2026-12-01',to:'2026-11-01'},{group_username:[]},{group_username:'bad/path'},{mode:'night'},{side:'both'},{status:'broken'},{page:0},{page:true},{page_size:101},{page_size:'20'}]){
  await assert.rejects(methods.responseAnalytics({},id,input),/response_filters_invalid/);
 }
});

import {digest} from '../src/cabinet/security.js';
test('response analytics and calendars use real scoped verified conversations', {skip:!connectionString},async t=>{
 const url=new URL(connectionString);assert.match(url.pathname,/^\/cabinet_test(?:_[a-z0-9]+)?$/);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
 api('createResponseAnalytics');
 const {createCabinetStore}=await import('../src/cabinet/store.js');
 const pool=new pg.Pool({connectionString}),query=pool.query.bind(pool),owners=[];
 const withClient=async fn=>{const db=await pool.connect();try{return await fn(db);}finally{db.release();}};
 const store=createCabinetStore({query,withClient,now:()=>new Date('2026-11-30T07:00:00Z')});
 async function fixture(){
  const owner_id=randomUUID(),connection_id=randomUUID(),campaign_id=randomUUID(),sid=randomUUID(),tokenId=randomUUID();owners.push(owner_id);
  await query('INSERT INTO cabinet_accounts(id,login,display_name) VALUES($1,$2,$2)',[owner_id,'response-'+owner_id]);
  await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username) VALUES($1,$2,'Response','response_sender')",[connection_id,owner_id]);
  await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name) VALUES($1,$2,$3,'Response')",[campaign_id,owner_id,connection_id]);
  await query("INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,'test',now()+interval '1 hour')",[sid,owner_id]);
  await query("INSERT INTO cabinet_api_tokens(id,owner_id,name,token_hash,display_prefix,scopes,campaign_ids,expires_at) VALUES($1,$2,'Reader',$3,'test',ARRAY['outreach:read'],$4,now()+interval '1 hour')",[tokenId,owner_id,digest(tokenId),[campaign_id]]);
  const p={kind:'owner',owner_id,actor_key:'session:'+sid};
  const token={kind:'token',id:tokenId,owner_id,actor_key:'token:'+tokenId,scopes:['outreach:read'],campaign_ids:[campaign_id],all_campaigns:false};
  async function job({uid='12345',mid=1,at='2026-11-27T06:00:00Z',status='sent',anchor=true,completed=true,group='first_group'}={}){
   const draft=(await query("INSERT INTO cabinet_drafts(owner_id,campaign_id,address,recipient_id,name,body,source_url) VALUES($1,$2,'https://t.me/person',$3,'First Person','Service',$4) ON CONFLICT(campaign_id,recipient_id) DO UPDATE SET source_url=EXCLUDED.source_url RETURNING id",[owner_id,campaign_id,uid,`https://t.me/${group}/1`])).rows[0];
   const j=(await query("INSERT INTO cabinet_jobs(owner_id,draft_id,campaign_id,connection_id,address,recipient_id,body,random_id,status,scheduled_at,completed_at,telegram_message_id,recipient_source) VALUES($1,$2,$3,$4,$5,$6,'Service',$7,$8,$9,$10,$11,$12) RETURNING *",[owner_id,draft.id,campaign_id,connection_id,'tg://user?id='+uid,uid,Math.floor(Math.random()*1e15)+1,status,at,completed?at:null,mid,{chat_id:'99999',username:group,message_id:1}])).rows[0];
   if(anchor)await message(j,'outbound',at,mid,'service_receipt');return j;
  }
  async function message(j,direction,at,mid,timeSource='telegram'){
   await query('INSERT INTO cabinet_messages(owner_id,job_id,connection_id,recipient_id,telegram_message_id,direction,body,sent_at,timestamp_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner_id,j.id,connection_id,j.recipient_id,mid,direction,'Message '+mid,at,timeSource]);
  }
  return {owner_id,connection_id,campaign_id,p,token,sid,job,message};
 }
 try{
  await t.test('default calendar reads owner and token scope; save is owner-only CAS with no delivery changes',async()=>{
   const f=await fixture(),j=await f.job(),before=(await query('SELECT * FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0];
   assert.deepEqual(await store.responseSchedule(f.p,f.campaign_id),schedule);
   assert.deepEqual(await store.responseSchedule(f.token,f.campaign_id),schedule);
   const save=(input,principal=f.p)=>store.saveResponseSchedule(principal,f.campaign_id,input);
   for(const input of [{weekdays:[],start:'09:00',end:'18:00',expected_revision:0},{weekdays:[1,1],start:'09:00',end:'18:00',expected_revision:0},{weekdays:[0],start:'09:00',end:'18:00',expected_revision:0},{weekdays:[1],start:'18:00',end:'09:00',expected_revision:0},{weekdays:[1],start:'9:00',end:'18:00',expected_revision:0},{weekdays:[1],start:'09:00',end:'24:00',expected_revision:0},{weekdays:[1],start:'09:00',end:'18:00',expected_revision:'0'},{weekdays:[1],start:'09:00',end:'18:00',expected_revision:0,timezone:'UTC'}])await assert.rejects(save(input),/response_schedule_invalid/);
   const input={weekdays:[5,1],start:'10:00',end:'17:00',expected_revision:0};
   await assert.rejects(save(input,f.token),/owner_session_required/);
   const saved=await save(input);assert.deepEqual(saved.weekdays,[1,5]);assert.equal(saved.revision,1);assert.equal(saved.start,'10:00');assert.ok(saved.updated_at);
   await assert.rejects(save(input),/response_schedule_changed/);
   const raced=await Promise.allSettled([save({...input,expected_revision:1}),save({...input,expected_revision:1})]);
   assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);assert.equal(raced.filter(r=>r.status==='rejected'&&r.reason.code==='response_schedule_changed').length,1);
   assert.deepEqual((await query('SELECT * FROM cabinet_campaigns WHERE id=$1',[f.campaign_id])).rows[0],before);
   assert.equal((await query('SELECT status FROM cabinet_jobs WHERE id=$1',[j.id])).rows[0].status,'sent');
   assert.equal((await query('SELECT count(*)::int AS n FROM cabinet_jobs WHERE owner_id=$1',[f.owner_id])).rows[0].n,1);
  });
  await t.test('bursts span jobs, pairing precedes dates/source filters and pagination leaves aggregates intact',async()=>{
   const f=await fixture(),j=await f.job();
   await f.message(j,'inbound','2026-11-27T20:59:00Z',2);await f.message(j,'inbound','2026-11-27T21:01:00Z',3);
   const follow=await f.job({mid:4,at:'2026-11-30T06:30:00Z',group:'later_group'});
   await f.message(follow,'outbound','2026-11-30T06:40:00Z',5);await f.message(follow,'inbound','2026-11-30T06:45:00Z',6);
   const second=await f.job({uid:'23456',mid:10,group:'other_group'});await f.message(second,'inbound','2026-11-27T07:00:00Z',11);await f.message(second,'outbound','2026-11-27T08:00:00Z',12);
   const report=await store.responseAnalytics(f.token,f.campaign_id,{from:'2026-11-27',to:'2026-11-27',group_username:'@FIRST_GROUP',mode:'working',page_size:1});
   assert.equal(report.as_of,'2026-11-30T07:00:00.000Z');assert.equal(report.date_basis,'episode_started_moscow_day');
   assert.equal(report.episodes.total,1);assert.equal(report.episodes.items[0].start_message_id,'2');assert.equal(report.episodes.items[0].end_message_id,'4');assert.equal(report.episodes.items[0].message_count,2);assert.equal(report.episodes.items[0].source_url,'https://t.me/first_group/1');assert.equal(report.episodes.items[0].duration_seconds,1800);
   assert.equal(report.summary.artem.answered,1);assert.equal(report.summary.artem.pending,0);assert.equal(report.summary.artem.median_seconds,1800);
   assert.equal(report.summary.client.answered,1);assert.equal(report.summary.client.median_seconds,32400);
   assert.deepEqual(report.available_groups,['first_group','other_group']);assert.equal(report.by_day[0].day,'2026-11-27');assert.equal(report.by_group[0].group_username,'first_group');
   const all=await store.responseAnalytics(f.p,f.campaign_id,{mode:'working',page_size:1,status:'answered'});
   assert.equal(all.summary.artem.answered,2);assert.equal(all.summary.artem.pending,1);assert.equal(all.summary.artem.median_seconds,2700);assert.equal(all.summary.artem.p90_seconds,3600);assert.equal(all.summary.artem.oldest_pending_seconds,900);assert.equal(all.episodes.total,2);assert.equal(all.episodes.items.length,1);
   const pending=await store.responseAnalytics(f.p,f.campaign_id,{status:'pending',mode:'working'});assert.equal(pending.episodes.items[0].duration_seconds,900);
   await store.saveResponseSchedule(f.p,f.campaign_id,{weekdays:[1],start:'10:00',end:'18:00',expected_revision:0});
   const changed=await store.responseAnalytics(f.p,f.campaign_id,{mode:'working'});assert.equal(changed.summary.artem.median_seconds,0);assert.equal(changed.schedule.revision,1);
  });
  await t.test('unverified/incomplete deliveries, arbitrary prior rows and another tenant never enter reports',async()=>{
   const f=await fixture(),other=await fixture();
   const verified=await f.job();await f.message(verified,'inbound','2026-11-27T05:00:00Z',-1);
   const failed=await f.job({uid:'23456',mid:10,status:'failed'});await f.message(failed,'inbound','2026-11-27T07:00:00Z',11);
   const noAnchor=await f.job({uid:'34567',mid:20,anchor:false});await f.message(noAnchor,'inbound','2026-11-27T07:00:00Z',21);
   const noCompleted=await f.job({uid:'45678',mid:30,completed:false});await f.message(noCompleted,'inbound','2026-11-27T07:00:00Z',31);
   const alien=await other.job();await other.message(alien,'inbound','2026-11-27T07:00:00Z',2);
   const r=await store.responseAnalytics(f.p,f.campaign_id,{});assert.equal(r.summary.artem.answered,0);assert.equal(r.summary.artem.pending,0);assert.equal(r.summary.client.pending,1);assert.equal(r.episodes.total,0);
   await assert.rejects(store.responseAnalytics(other.p,f.campaign_id,{}),/campaign_not_found/);
   await assert.rejects(store.responseAnalytics({...f.token,campaign_ids:[]},f.campaign_id,{}),/campaign_not_found/);
   await assert.rejects(store.responseAnalytics({...f.token,scopes:[]},f.campaign_id,{}),/scope_denied/);
   await query('DELETE FROM cabinet_sessions WHERE token_hash=$1',[f.sid]);
   await assert.rejects(store.saveResponseSchedule(f.p,f.campaign_id,{weekdays:[1],start:'09:00',end:'18:00',expected_revision:0}),/cabinet_auth_required/);
  });
  await t.test('anomaly status is retrievable but excluded from answered latency and pending counts',async()=>{
   const f=await fixture(),j=await f.job();await f.message(j,'inbound','2026-11-27T09:00:00Z',2);await f.message(j,'outbound','2026-11-27T08:00:00Z',3);
   const r=await store.responseAnalytics(f.p,f.campaign_id,{status:'anomaly'});assert.equal(r.episodes.total,1);assert.equal(r.episodes.items[0].duration_seconds,null);assert.equal(r.summary.artem.anomalies,1);assert.equal(r.summary.artem.answered,0);assert.equal(r.summary.artem.pending,0);assert.equal(r.summary.artem.median_seconds,null);assert.equal(r.summary.artem.p90_seconds,null);
   const client=await store.responseAnalytics(f.p,f.campaign_id,{side:'client'});assert.equal(client.episodes.total,1);assert.equal(client.summary.client.median_seconds,10800);
  });
 }finally{
  for(const owner of owners){
   for(const table of ['cabinet_response_schedules','cabinet_audit','cabinet_messages','cabinet_jobs','cabinet_drafts','cabinet_campaigns','cabinet_connections','cabinet_api_tokens','cabinet_sessions'])await query(`DELETE FROM ${table} WHERE owner_id=$1`,[owner]);
   await query('DELETE FROM cabinet_accounts WHERE id=$1',[owner]);
  }
  await pool.end();
 }
});
