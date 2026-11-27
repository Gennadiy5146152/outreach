import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { createCabinet } from '../src/cabinet/router.js';
import { createCabinetStore } from '../src/cabinet/store.js';
import { digest } from '../src/cabinet/security.js';

const connectionString=process.env.CABINET_TEST_DATABASE_URL;
const source={chat_id:'9223372036854775807',username:'public_group',message_id:2147483647};
const invalidSources=[null,[],{},'group',1,{...source,extra:true},{username:source.username,message_id:1},{...source,chat_id:123},{...source,chat_id:'0'},{...source,chat_id:'-1'},{...source,chat_id:'01'},{...source,chat_id:'9223372036854775808'},{...source,username:'Public_Group'},{...source,username:'@public_group'},{...source,username:'a'},{...source,username:null},{...source,message_id:0},{...source,message_id:-1},{...source,message_id:1.5},{...source,message_id:2147483648},{...source,message_id:'123'},{...source,message_id:null}];
test('source recipients bind immutable exact public-message context throughout cabinet approvals', {skip:!connectionString}, async t=>{
  const url=new URL(connectionString);assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&/^\/cabinet_test(?:_[a-z0-9]+)?$/.test(url.pathname));
  const pool=new pg.Pool({connectionString}),query=pool.query.bind(pool);
  const withClient=async fn=>{const db=await pool.connect();try{return await fn(db);}finally{db.release();}};
  const clock=new Date('2026-11-27T11:00:00Z');
  const store=createCabinetStore({query,withClient,now:()=>clock,sendEnabled:true});
  const cabinet=createCabinet({query,withClient,env:{nodeEnv:'development',cabinetTelegramSendEnabled:true}});
  const app=express();app.use(express.json());app.use('/api/cabinet',cabinet.router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  async function fixture(){
    const owner_id=randomUUID(),connection_id=randomUUID(),campaign_id=randomUUID(),sid=randomUUID();
    await query('INSERT INTO cabinet_accounts(id,login,display_name) VALUES($1,$2,$2)',[owner_id,'s-'+owner_id]);
    await query("INSERT INTO cabinet_sessions(token_hash,owner_id,csrf,expires_at) VALUES($1,$2,'test',clock_timestamp()+interval '1 hour')",[sid,owner_id]);
    const p={kind:'owner',owner_id,actor_key:'session:'+sid};
    await query("INSERT INTO cabinet_connections(id,owner_id,label,expected_username,username,telegram_user_id,status,generation,heartbeat_at) VALUES($1,$2,'sender','source_sender','source_sender',abs(hashtext($2::uuid::text))::bigint+60000000000,'connected',7,$3)",[connection_id,owner_id,clock]);
    await query("INSERT INTO cabinet_campaigns(id,owner_id,connection_id,name,daily_limit,window_start,window_end) VALUES($1,$2,$3,'source campaign',20,'09:00','18:00')",[campaign_id,owner_id,connection_id]);
    const input={recipient_id:'9007199254740993',name:'Source author',body:'Exact source recipient text.\n\nQuestion?',source_url:'https://example.com/research',permission_kind:'request',permission_evidence:'Dated original public request'};
    const save=(override={})=>store.saveDraft(p,campaign_id,{...input,recipient_source:source,...override});
    const legacy=()=>store.saveDraft(p,campaign_id,{...input,recipient_id:'9912345',address:'https://t.me/legacy_person'});
    async function token(scopes=['outreach:read','outreach:draft','outreach:send']){
      const raw='ocp_'+randomUUID(),id=randomUUID();await query("INSERT INTO cabinet_api_tokens(id,owner_id,name,token_hash,display_prefix,scopes,campaign_ids,all_campaigns,expires_at) VALUES($1,$2,'test',$3,'test',$4,'{}',true,clock_timestamp()+interval '1 hour')",[id,owner_id,digest(raw),scopes]);
      return {raw,p:{kind:'token',id,owner_id,actor_key:'token:'+id,scopes,campaign_ids:[],all_campaigns:true}};
    }
    return {p,owner_id,connection_id,campaign_id,input,save,legacy,token};
  }
  const jobs=async f=>(await query('SELECT * FROM cabinet_jobs WHERE owner_id=$1 ORDER BY id',[f.owner_id])).rows;
  // The schedule clock is fixed; existing approval TTLs are checked by live DB time.
  const live=async promise=>{const plan=await promise;await query("UPDATE cabinet_plans SET expires_at=clock_timestamp()+interval '10 minutes' WHERE token_hash=$1",[digest(plan.confirmation_token)]);return plan;};
  const prepare=async(f,ds,kind='launch')=>kind==='one_off_launch'?store.prepareOneOff(f.p,f.campaign_id,{draft_ids:ds.map(d=>d.id),window_start:'14:01',window_end:'15:00'}):live(store.prepare(f.p,f.campaign_id,{draft_ids:ds.map(d=>d.id)},kind));
  const execute=(f,plan)=>plan.preview.kind==='one_off_launch'?store.executeOneOff(f.p,{confirmation_token:plan.confirmation_token,confirm:true}):store.execute(f.p,{confirmation_token:plan.confirmation_token,confirm:true,kind:plan.preview.kind});
  try{
    await t.test('source mode creates a canonical personal address and exact bigint-safe context, while username mode stays null',async()=>{
      const f=await fixture(),d=await f.save(),old=await f.legacy();
      assert.equal(d.address,'tg://user?id='+f.input.recipient_id);assert.equal(d.recipient_id,f.input.recipient_id);assert.deepEqual(d.recipient_source,source);assert.equal(d.source_url,f.input.source_url);
      assert.equal(old.address,'https://t.me/legacy_person');assert.equal(old.recipient_source,null);
      assert.deepEqual((await store.drafts(f.p,f.campaign_id)).find(r=>r.id===d.id).recipient_source,source);assert.equal((await jobs(f)).length,0);
    });
    await t.test('source and address are exclusive and source requires exact keys, types, normalized username and bounds',async()=>{
      const f=await fixture();for(const recipient_source of invalidSources)await assert.rejects(f.save({recipient_source}),/recipient_source_invalid/);
      for(const address of ['https://t.me/legacy_person','',null])await assert.rejects(f.save({address}),/recipient_address_conflict/);
      await assert.rejects(f.save({recipient_source:undefined}),/recipient_source_invalid/);
      await assert.rejects(f.save({recipient_id:9007199254740992}),/recipient_id_required/);
      await assert.rejects(store.saveDraft(f.p,f.campaign_id,{...f.input}),/invalid_telegram_username/);
      assert.equal((await store.drafts(f.p,f.campaign_id)).length,0);
    });
    await t.test('identity source is immutable while research source_url remains independent',async()=>{
      const f=await fixture(),d=await f.save();for(const input of [{recipient_source:{...source,message_id:1}},{recipient_source:null},{address:'https://t.me/other_person'},{recipient_id:'9912345'}])await assert.rejects(store.editDraft(f.p,f.campaign_id,d.id,input),/draft_edit_invalid/);
      const edited=await store.editDraft(f.p,f.campaign_id,d.id,{source_url:'https://example.com/other',body:'New copy'});assert.deepEqual(edited.recipient_source,source);assert.equal(edited.address,d.address);assert.equal(edited.recipient_id,d.recipient_id);assert.equal(edited.source_url,'https://example.com/other');
    });
    await t.test('PostgreSQL rejects every malformed non-null source and wrong canonical address on drafts and jobs',async()=>{
      const f=await fixture(),d=await f.legacy();
      for(const recipient_source of invalidSources)await assert.rejects(query('UPDATE cabinet_drafts SET address=$2,recipient_source=$3::jsonb WHERE id=$1',[d.id,'tg://user?id='+d.recipient_id,JSON.stringify(recipient_source)]),e=>e.code==='23514');
      await assert.rejects(query('UPDATE cabinet_drafts SET recipient_source=$2 WHERE id=$1',[d.id,source]),e=>e.code==='23514');
      await query('UPDATE cabinet_drafts SET address=$2,recipient_source=$3 WHERE id=$1',[d.id,'tg://user?id='+d.recipient_id,source]);
      const plan=await prepare(f,[d]);await execute(f,plan);const [j]=await jobs(f);
      for(const recipient_source of invalidSources)await assert.rejects(query('UPDATE cabinet_jobs SET recipient_source=$2::jsonb WHERE id=$1',[j.id,JSON.stringify(recipient_source)]),e=>e.code==='23514');
      await assert.rejects(query("UPDATE cabinet_jobs SET address='https://t.me/not_the_source_author' WHERE id=$1",[j.id]),e=>e.code==='23514');
      // Existing null-source rows retain their historically accepted address shape.
      await query("UPDATE cabinet_jobs SET recipient_source=NULL,address='fixture compatibility' WHERE id=$1",[j.id]);
    });
    await t.test('both launch paths preview and copy exact source without claiming Telegram proof ran',async()=>{
      for(const kind of ['launch','one_off_launch']){
        const f=await fixture(),d=await f.save(),old=await f.legacy(),plan=await prepare(f,[d,old],kind);
        assert.deepEqual(plan.preview.items.map(i=>[i.address,i.recipient_id,i.recipient_source,i.body]),[[d.address,d.recipient_id,source,d.body],[old.address,old.recipient_id,null,old.body]]);assert.equal((await jobs(f)).length,0);
        await execute(f,plan);const rows=await jobs(f);assert.equal(rows.length,2);assert.deepEqual(rows.find(j=>j.draft_id===d.id).recipient_source,source);assert.equal(rows.find(j=>j.draft_id===old.id).recipient_source,null);
        const queued=(await store.queue(f.p,f.campaign_id)).find(j=>j.draft_id===d.id);assert.deepEqual(queued.recipient_source,source);assert.equal(queued.recipient_id,d.recipient_id);
      }
    });
    await t.test('source changes invalidate ordinary and one-off approvals atomically',async()=>{
      for(const kind of ['launch','one_off_launch']){const f=await fixture(),d=await f.save(),plan=await prepare(f,[d],kind);await query("UPDATE cabinet_drafts SET recipient_source=jsonb_set(recipient_source,'{message_id}','123') WHERE id=$1",[d.id]);await assert.rejects(execute(f,plan),/plan_changed/);assert.equal((await jobs(f)).length,0);}
    });
    await t.test('queue edit previews and preserves source, rejects metadata edits, mismatches and stale source snapshots',async()=>{
      const f=await fixture(),d=await f.save(),plan=await prepare(f,[d]);await execute(f,plan);const [j]=await jobs(f);
      const items=[{job_id:j.id,body:'Changed queued copy'}];const amendment=await live(store.prepareQueueEdit(f.p,f.campaign_id,{items}));assert.deepEqual(amendment.preview.items[0].recipient_source,source);
      await assert.rejects(store.prepareQueueEdit(f.p,f.campaign_id,{items:[{...items[0],recipient_source:{...source,message_id:1}}]}),/queue_edit_invalid/);
      await store.executeQueueEdit(f.p,{confirmation_token:amendment.confirmation_token,confirm:true});assert.deepEqual((await jobs(f))[0].recipient_source,source);
      const stale=await live(store.prepareQueueEdit(f.p,f.campaign_id,{items}));await query("UPDATE cabinet_jobs SET recipient_source=jsonb_set(recipient_source,'{message_id}','123') WHERE id=$1",[j.id]);
      await assert.rejects(store.executeQueueEdit(f.p,{confirmation_token:stale.confirmation_token,confirm:true}),/plan_changed/);
      await assert.rejects(store.prepareQueueEdit(f.p,f.campaign_id,{items}),/queue_edit_not_eligible/);
    });
    await t.test('cross-mode recipients deduplicate by UID and stopped source drafts remain blocked',async()=>{
      for(const sourceFirst of [true,false]){
        const f=await fixture(),first=sourceFirst?await f.save():await store.saveDraft(f.p,f.campaign_id,{...f.input,address:'https://t.me/same_person'});await execute(f,await prepare(f,[first]));
        const {rows:[second]}=await query("INSERT INTO cabinet_campaigns(owner_id,connection_id,name,daily_limit,window_start,window_end) VALUES($1,$2,'other',20,'09:00','18:00') RETURNING id",[f.owner_id,f.connection_id]);
        const d=await store.saveDraft(f.p,second.id,{...f.input,...(sourceFirst?{address:'https://t.me/same_person'}:{recipient_source:source})});
        await assert.rejects(store.prepare(f.p,second.id,{draft_ids:[d.id]}),/draft_not_eligible/);
      }
      const f=await fixture(),d=await f.save();await query('UPDATE cabinet_drafts SET stopped=true WHERE id=$1',[d.id]);await assert.rejects(prepare(f,[d]),/draft_not_eligible/);
    });
    await t.test('HTTP preserves source, ownership, edit immutability and action scopes',async()=>{
      const f=await fixture(),tok=await f.token();const request=async(path,body,method='POST',raw=tok.raw)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/cabinet${path}`,{method,headers:{'content-type':'application/json',authorization:'Bearer '+raw},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
      const created=await request(`/campaigns/${f.campaign_id}/drafts`,{...f.input,recipient_source:source});assert.equal(created.status,201);assert.deepEqual(created.data.recipient_source,source);assert.equal(created.data.address,'tg://user?id='+f.input.recipient_id);
      assert.equal((await request(`/campaigns/${f.campaign_id}/drafts/${created.data.id}`,{recipient_source:source},'PATCH')).status,400);
      const foreign=await fixture();assert.equal((await request(`/campaigns/${foreign.campaign_id}/drafts`,{...f.input,recipient_source:source})).status,404);
      const send=await f.token(['outreach:send']);assert.equal((await request(`/campaigns/${f.campaign_id}/drafts`,{...f.input,recipient_source:source},'POST',send.raw)).status,403);
      assert.equal((await request(`/campaigns/${f.campaign_id}/drafts`,{...f.input,address:'https://t.me/wrong',recipient_source:source})).status,400);
      assert.deepEqual((await request(`/campaigns/${f.campaign_id}/drafts`,undefined,'GET')).data[0].recipient_source,source);
    });
  }finally{await new Promise(r=>server.close(r));await pool.end();}
});
