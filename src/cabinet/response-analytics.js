import {ownerOnly,fail,uuid} from './security.js';

const TIME_ZONE='Europe/Moscow',DAY=86400000,MOSCOW_OFFSET=10800000;
const DEFAULT_SCHEDULE={timezone:TIME_ZONE,weekdays:[1,2,3,4,5],start:'09:00',end:'18:00',revision:0,updated_at:null};
const SCHEDULE_FIELDS="timezone,weekdays,to_char(start_time,'HH24:MI') AS start,to_char(end_time,'HH24:MI') AS end,revision,updated_at";

function milliseconds(value){
 if(!(value instanceof Date)&&typeof value!=='string')return NaN;
 return new Date(value).getTime();
}
function timestamp(value){
 const ms=milliseconds(value);
 return Number.isFinite(ms)?new Date(ms).toISOString():typeof value==='string'?value:null;
}
const weekday=day=>((day+3)%7+7)%7+1;
const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));

// Count whole weeks arithmetically: even centuries of history need at most six
// remainder days, plus the two partial boundary days. Moscow is UTC+03 for the
// service's operational history; there is no holiday or overnight calendar.
export function workingSeconds(start,end,schedule=DEFAULT_SCHEDULE){
 const from=milliseconds(start),to=milliseconds(end);
 if(!Number.isFinite(from)||!Number.isFinite(to)||to<from)return null;
 const opening=minutes(schedule.start)*60000,closing=minutes(schedule.end)*60000;
 const first=Math.floor((from+MOSCOW_OFFSET)/DAY),last=Math.floor((to+MOSCOW_OFFSET)/DAY);
 const active=new Set(schedule.weekdays);
 const partial=day=>active.has(weekday(day))?Math.max(0,Math.min(to,day*DAY-MOSCOW_OFFSET+closing)-Math.max(from,day*DAY-MOSCOW_OFFSET+opening)):0;
 if(first===last)return partial(first)/1000;
 const days=last-first-1,weeks=Math.floor(days/7);
 let full=weeks*active.size;
 for(let i=0;i<days%7;i++)if(active.has(weekday(first+1+i)))full++;
 return (partial(first)+partial(last)+full*(closing-opening))/1000;
}

function date(value){
 if(value===undefined)return null;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000'))throw fail('response_filters_invalid');
 const parsed=new Date(value+'T00:00:00Z');
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)throw fail('response_filters_invalid');
 return value;
}
function filters(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['from','to','group_username','mode','side','status','page','page_size'].includes(k)))throw fail('response_filters_invalid');
 const from=date(input.from),to=date(input.to),group=input.group_username===undefined?null:input.group_username;
 if(from&&to&&to<from||input.group_username!==undefined&&(typeof group!=='string'||!/^@?[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(group)))throw fail('response_filters_invalid');
 const {mode='elapsed',side='artem',status='all',page=1,page_size=20}=input;
 if(!['elapsed','working'].includes(mode)||!['artem','client'].includes(side)||!['all','answered','pending','anomaly'].includes(status)||!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(page_size)||page_size<1||page_size>100)throw fail('response_filters_invalid');
 return {from,to,group_username:group?.replace(/^@/,'').toLowerCase()??null,mode,side,status,page,page_size};
}
function scheduleInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['weekdays','start','end','expected_revision'].includes(k))||
  !Array.isArray(input.weekdays)||input.weekdays.length<1||input.weekdays.length>7||input.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7)||new Set(input.weekdays).size!==input.weekdays.length||
  typeof input.start!=='string'||typeof input.end!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.end)||input.end<=input.start||
  !Number.isSafeInteger(input.expected_revision)||input.expected_revision<0||input.expected_revision>=2147483647)throw fail('response_schedule_invalid');
 return {...input,weekdays:[...input.weekdays].sort((a,b)=>a-b)};
}

// Each row is from a verified sent job with its exact outbound service anchor.
// Neither unverified jobs nor general chat history can enter this population.
const MESSAGES_SQL=`WITH verified AS (
 SELECT j.*,anchor.telegram_message_id AS anchor_message_id
 FROM cabinet_jobs j JOIN cabinet_messages anchor ON anchor.owner_id=j.owner_id
  AND anchor.job_id=j.id AND anchor.connection_id=j.connection_id AND anchor.recipient_id=j.recipient_id
  AND anchor.telegram_message_id=j.telegram_message_id AND anchor.direction='outbound'
 WHERE j.owner_id=$1 AND j.campaign_id=$2 AND j.status='sent' AND j.completed_at IS NOT NULL
), first_anchor AS (
 SELECT connection_id,recipient_id,min(anchor_message_id) AS message_id FROM verified GROUP BY connection_id,recipient_id
)
SELECT j.id AS job_id,j.connection_id,j.recipient_id::text,j.address,d.name,
 CASE WHEN j.recipient_source IS NOT NULL THEN 'https://t.me/'||(j.recipient_source->>'username')||'/'||(j.recipient_source->>'message_id') ELSE d.source_url END AS source_url,
 lower(COALESCE(j.recipient_source->>'username',substring(d.source_url from '^https://t[.]me/([A-Za-z][A-Za-z0-9_]{3,31})/[0-9]+$'))) AS group_username,
 j.anchor_message_id::text,m.telegram_message_id::text,m.direction,m.sent_at,m.timestamp_source
FROM verified j JOIN cabinet_drafts d ON d.id=j.draft_id AND d.owner_id=j.owner_id AND d.campaign_id=j.campaign_id
JOIN first_anchor first ON first.connection_id=j.connection_id AND first.recipient_id=j.recipient_id
JOIN cabinet_messages m ON m.owner_id=j.owner_id AND m.job_id=j.id
 AND m.connection_id=j.connection_id AND m.recipient_id=j.recipient_id
WHERE m.telegram_message_id>=first.message_id
ORDER BY j.connection_id,j.recipient_id,m.telegram_message_id,m.id`;
const compareId=(a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;

export function buildResponseEpisodes(rows,{schedule=DEFAULT_SCHEDULE,as_of}={}){
 const conversations=new Map(),result=[];
 for(const row of rows){
  const key=row.connection_id+':'+row.recipient_id;
  if(!conversations.has(key))conversations.set(key,[]);
  conversations.get(key).push(row);
 }
 for(const messages of conversations.values()){
  messages.sort((a,b)=>compareId(a.telegram_message_id,b.telegram_message_id)||String(a.job_id).localeCompare(String(b.job_id)));
  const deliveries=[...new Map(messages.map(m=>[m.job_id,m])).values()].sort((a,b)=>compareId(a.anchor_message_id,b.anchor_message_id)||String(a.job_id).localeCompare(String(b.job_id)));
  const first=deliveries[0],job_ids=deliveries.map(m=>m.job_id);
  const anchor=messages.find(m=>m.job_id===first.job_id&&m.direction==='outbound'&&m.telegram_message_id===first.anchor_message_id);
  if(!anchor)continue;
  const scoped=messages.filter(m=>compareId(m.telegram_message_id,anchor.telegram_message_id)>=0);
  function emit(side,start,end,count,burst=[]){
   const startMs=milliseconds(start.sent_at),endMs=milliseconds(end?end.sent_at:as_of);
   let anomaly_reason=null;
   if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||burst.some(m=>!Number.isFinite(milliseconds(m.sent_at))))anomaly_reason='invalid_timestamp';
   else if(endMs<startMs||burst.some(m=>milliseconds(m.sent_at)<startMs||milliseconds(m.sent_at)>endMs))anomaly_reason='negative_duration';
   const elapsed_seconds=anomaly_reason?null:(endMs-startMs)/1000;
   const working_seconds=anomaly_reason?null:workingSeconds(start.sent_at,end?end.sent_at:as_of,schedule);
   result.push({id:`${side}:${first.connection_id}:${first.recipient_id}:${start.telegram_message_id}`,recipient_id:String(first.recipient_id),connection_id:first.connection_id,
    job_id:first.job_id,job_ids:[...job_ids],address:first.address,name:first.name,group_username:first.group_username??null,source_url:first.source_url,
    side,state:anomaly_reason?'anomaly':end?'answered':'pending',started_at:timestamp(start.sent_at),answered_at:end?timestamp(end.sent_at):null,
    start_message_id:String(start.telegram_message_id),end_message_id:end?String(end.telegram_message_id):null,message_count:count,elapsed_seconds,working_seconds,
    duration_seconds:elapsed_seconds,start_time_source:start.timestamp_source,end_time_source:end?end.timestamp_source:null,...(anomaly_reason?{anomaly_reason}:{})});
  }
  const clientReply=scoped.find(m=>m.direction==='inbound'&&compareId(m.telegram_message_id,anchor.telegram_message_id)>0);
  emit('client',anchor,clientReply??null,clientReply?1:0);
  let burst=[];
  for(const message of scoped){
   if(message.direction==='inbound')burst.push(message);
   else if(burst.length){emit('artem',burst[0],message,burst.length,burst);burst=[];}
  }
  if(burst.length)emit('artem',burst[0],null,burst.length,burst);
 }
 return result;
}
function moscowDay(value){
 const ms=milliseconds(value);if(!Number.isFinite(ms))return null;
 return new Date(ms+MOSCOW_OFFSET).toISOString().slice(0,10);
}
function metrics(episodes){
 const answered=episodes.filter(e=>e.state==='answered').map(e=>e.duration_seconds).sort((a,b)=>a-b),pending=episodes.filter(e=>e.state==='pending');
 const middle=Math.floor(answered.length/2);
 return {answered:answered.length,pending:pending.length,anomalies:episodes.filter(e=>e.state==='anomaly').length,
  median_seconds:answered.length?(answered.length%2?answered[middle]:(answered[middle-1]+answered[middle])/2):null,
  p90_seconds:answered.length?answered[Math.ceil(answered.length*.9)-1]:null,
  oldest_pending_seconds:pending.length?pending.reduce((max,e)=>Math.max(max,e.duration_seconds),0):null};
}
function breakdown(episodes,key,value){
 const groups=new Map();for(const episode of episodes){const k=value(episode);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(episode);}
 return [...groups].sort(([a],[b])=>String(a??'').localeCompare(String(b??''))).map(([k,items])=>({[key]:k,...metrics(items)}));
}

export function createResponseAnalytics({query,campaign,ownerTransaction,now=()=>new Date()}){
 async function readSchedule(p,id,db){
  const {rows}=await (db?db.query(`SELECT ${SCHEDULE_FIELDS} FROM cabinet_response_schedules WHERE owner_id=$1 AND campaign_id=$2`,[p.owner_id,id]):query(`SELECT ${SCHEDULE_FIELDS} FROM cabinet_response_schedules WHERE owner_id=$1 AND campaign_id=$2`,[p.owner_id,id]));
  return rows[0]??{...DEFAULT_SCHEDULE,weekdays:[...DEFAULT_SCHEDULE.weekdays]};
 }
 async function responseSchedule(p,id){
  id=uuid(id);await campaign(p,id,'outreach:read');
  return readSchedule(p,id);
 }
 async function saveResponseSchedule(p,id,input){
  ownerOnly(p);id=uuid(id);const data=scheduleInput(input);
  return ownerTransaction(p,async db=>{
   await campaign(p,id,'outreach:read',db);
   // Serializes the absent-row case as well as updates. It is deliberately
   // independent from delivery windows and never edits campaign/jobs.
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['cabinet-response-schedule:'+p.owner_id+':'+id]);
   const current=await readSchedule(p,id,db);
   if(current.revision!==data.expected_revision)throw fail('response_schedule_changed',409);
   const saved=(await db.query(`INSERT INTO cabinet_response_schedules(owner_id,campaign_id,weekdays,start_time,end_time,revision)
    VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(owner_id,campaign_id) DO UPDATE SET weekdays=EXCLUDED.weekdays,start_time=EXCLUDED.start_time,
    end_time=EXCLUDED.end_time,revision=cabinet_response_schedules.revision+1,updated_at=clock_timestamp()
    WHERE cabinet_response_schedules.revision=$6 RETURNING ${SCHEDULE_FIELDS}`,[p.owner_id,id,data.weekdays,data.start,data.end,data.expected_revision])).rows[0];
   if(!saved)throw fail('response_schedule_changed',409);
   return saved;
  });
 }
 async function responseAnalytics(p,id,input={}){
  id=uuid(id);const f=filters(input);
  await campaign(p,id,'outreach:read');
  const as_of=now().toISOString(),schedule=await readSchedule(p,id);
  const rows=(await query(MESSAGES_SQL,[p.owner_id,id])).rows;
  const episodes=buildResponseEpisodes(rows,{schedule,as_of}).map(e=>({...e,duration_seconds:f.mode==='working'?e.working_seconds:e.elapsed_seconds}));
  // Pair before filtering: an answer after the selected date is still an answer.
  const dated=episodes.filter(e=>{const day=moscowDay(e.started_at);return (!f.from||day!==null&&day>=f.from)&&(!f.to||day!==null&&day<=f.to);});
  const selected=dated.filter(e=>!f.group_username||e.group_username===f.group_username),side=selected.filter(e=>e.side===f.side);
  const listed=side.filter(e=>f.status==='all'||e.state===f.status).sort((a,b)=>(a.state==='pending'?0:1)-(b.state==='pending'?0:1)||(b.duration_seconds??-1)-(a.duration_seconds??-1)||a.id.localeCompare(b.id));
  return {mode:f.mode,side:f.side,time_zone:TIME_ZONE,date_basis:'episode_started_moscow_day',as_of,schedule,
   filters:{from:f.from,to:f.to,group_username:f.group_username,status:f.status},available_groups:[...new Set(dated.map(e=>e.group_username).filter(Boolean))].sort(),
   summary:{artem:metrics(selected.filter(e=>e.side==='artem')),client:metrics(selected.filter(e=>e.side==='client'))},
   by_day:breakdown(side,'day',e=>moscowDay(e.started_at)),by_group:breakdown(side,'group_username',e=>e.group_username),
   episodes:{items:listed.slice((f.page-1)*f.page_size,f.page*f.page_size),total:listed.length,page:f.page,page_size:f.page_size}};
 }
 return {responseAnalytics,responseSchedule,saveResponseSchedule};
}
