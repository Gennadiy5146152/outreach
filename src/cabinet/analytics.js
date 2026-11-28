import {assertScope,ownerOnly,fail,uuid} from './security.js';

export const OUTCOME_STATUSES=['interested','later','declined','not_target','needs_review','booked'];
function date(value){
 if(value===undefined||value==='')return null;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000'))throw fail('stats_filters_invalid');
 const d=new Date(value+'T00:00:00Z');
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)throw fail('stats_filters_invalid');
 return value;
}
function filters(input={},review=false){
 const allowed=review?['from','to','group_username','page','page_size','pending_only']:['from','to','group_username'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw fail('stats_filters_invalid');
 const from=date(input.from),to=date(input.to),group=input.group_username||null;
 if(from&&to&&to<from)throw fail('stats_filters_invalid');
 if(group&&(typeof group!=='string'||!/^\@?[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(group)))throw fail('stats_filters_invalid');
 const result={from,to,group:group?.replace(/^@/,'').toLowerCase()??null};
 if(review){
  const page=Number(input.page??1),page_size=Number(input.page_size??50),pending=input.pending_only??true;
  if(!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(page_size)||page_size<1||page_size>100||![true,false,'true','false'].includes(pending))throw fail('stats_filters_invalid');
  Object.assign(result,{page,page_size,pending_only:pending===true||pending==='true'});
 }
 return result;
}

// A cohort is chosen BEFORE date/source filters. Follow-ups cannot create another person.
// Draft source_url is immutable after dispatch under editDraft; source-mode jobs also
// retain their immutable public-message recipient_source on the delivery itself.
const PEOPLE_SQL=`WITH sent AS (
 SELECT j.*,anchor.sent_at AS delivered_at FROM cabinet_jobs j
 JOIN cabinet_messages anchor ON anchor.owner_id=j.owner_id AND anchor.job_id=j.id
   AND anchor.connection_id=j.connection_id AND anchor.recipient_id=j.recipient_id
   AND anchor.telegram_message_id=j.telegram_message_id AND anchor.direction='outbound'
 WHERE j.owner_id=$1 AND j.campaign_id=$2 AND j.status='sent' AND j.completed_at IS NOT NULL
), first_delivery AS (
 SELECT DISTINCT ON(recipient_id) * FROM sent ORDER BY recipient_id,delivered_at,id
), people AS (
 SELECT f.id AS job_id,f.recipient_id::text,f.connection_id,f.address,d.name,d.source_url,
   f.delivered_at AS first_sent_at,(f.delivered_at AT TIME ZONE 'Europe/Moscow')::date::text AS cohort_day,
   lower(COALESCE(f.recipient_source->>'username',substring(d.source_url from '^https://t[.]me/([A-Za-z][A-Za-z0-9_]{3,31})/[0-9]+$'))) AS group_username,
   history.*,o.status AS assessed_status,o.reason,o.evidence_message_ids::text[] AS evidence_message_ids,
   o.review_source,o.reviewed_at,o.snapshot AS assessment_snapshot,
   o.follow_up_on::text,o.follow_up_note,o.follow_up_updated_at,
   COALESCE(o.snapshot<>history.snapshot,false) AS stale,
   CASE WHEN o.status IS NULL AND history.inbound_count=0 THEN 'no_reply'
     WHEN o.status IS NULL OR (o.review_source='agent' AND o.snapshot<>history.snapshot) THEN 'needs_review'
     ELSE o.status END AS status,
   (history.inbound_count>0 AND (o.snapshot IS NULL OR o.snapshot<>history.snapshot)
     AND COALESCE(o.review_source,'agent')<>'manual') AS pending_review
 FROM first_delivery f JOIN cabinet_drafts d ON d.id=f.draft_id AND d.owner_id=f.owner_id
 CROSS JOIN LATERAL (
  SELECT count(*)::int AS message_count,count(*) FILTER(WHERE m.direction='inbound')::int AS inbound_count,
   max(m.sent_at) FILTER(WHERE m.direction='inbound') AS last_inbound_at,
   max(m.telegram_message_id) FILTER(WHERE m.direction='inbound')::text AS last_inbound_message_id,
   max(m.telegram_message_id)::text AS last_message_id,
   md5(COALESCE(string_agg(m.id::text||':'||m.telegram_message_id::text||':'||m.direction||':'||m.sent_at::text||':'||COALESCE(m.reply_to_message_id::text,'')||':'||md5(m.body),',' ORDER BY m.telegram_message_id,m.id),'')) AS snapshot,
   ARRAY(SELECT s2.id FROM sent s2 WHERE s2.recipient_id=f.recipient_id ORDER BY s2.delivered_at,s2.id) AS job_ids
  FROM cabinet_messages m JOIN sent s ON s.id=m.job_id AND s.owner_id=m.owner_id
  WHERE m.owner_id=f.owner_id AND m.recipient_id=f.recipient_id
 ) history
 LEFT JOIN cabinet_conversation_outcomes o ON o.owner_id=f.owner_id AND o.campaign_id=f.campaign_id AND o.recipient_id=f.recipient_id
)
SELECT * FROM people WHERE ($3::date IS NULL OR cohort_day::date>=$3::date)
 AND ($4::date IS NULL OR cohort_day::date<=$4::date)
 AND ($5::text IS NULL OR group_username=$5)
ORDER BY first_sent_at,recipient_id::bigint`;

function totals(rows){
 const result={sent:rows.length,replied:0,interested:0,booked:0,later:0,declined:0,not_target:0,needs_review:0,no_reply:0,pending_review:0,manual_stale:0};
 let interestedReplies=0;
 for(const row of rows){
  if(row.inbound_count>0)result.replied++;
  else result.no_reply++;
  if(['interested','booked'].includes(row.status)){result.interested++;if(row.inbound_count>0)interestedReplies++;}
  if(!['interested','no_reply'].includes(row.status)&&Object.hasOwn(result,row.status))result[row.status]++;
  if(row.pending_review)result.pending_review++;
  if(row.stale&&row.review_source==='manual')result.manual_stale++;
 }
 const rate=(n,d)=>d?Math.round(n/d*10000)/100:null;
 return {...result,reply_rate:rate(result.replied,result.sent),interested_rate:rate(result.interested,result.sent),interested_reply_rate:rate(interestedReplies,result.replied),booking_rate:rate(result.booked,result.sent)};
}
function groups(rows,key){
 const map=new Map();for(const row of rows){const value=row[key]??'unknown';if(!map.has(value))map.set(value,[]);map.get(value).push(row);}
 return [...map].map(([value,items])=>({[key]:value,...totals(items)}));
}

export function createCabinetAnalytics({query,campaign,ownerTransaction}){
 async function rows(p,id,f,db){
  await campaign(p,id,'outreach:read',db);
  return (await (db?db.query(PEOPLE_SQL,[p.owner_id,id,f.from,f.to,f.group]):query(PEOPLE_SQL,[p.owner_id,id,f.from,f.to,f.group]))).rows;
 }
 async function campaignStats(p,id,input={}){
  id=uuid(id);const f=filters(input);const available=await rows(p,id,{...f,group:null});
  const people=f.group?available.filter(r=>r.group_username===f.group):available;
  const reply_outcomes=Object.fromEntries(OUTCOME_STATUSES.map(status=>[status,people.filter(r=>r.inbound_count>0&&r.status===status).length]));
  return {campaign_id:id,time_zone:'Europe/Moscow',cohort:'first_confirmed_delivery',filters:{from:f.from,to:f.to,group_username:f.group},available_groups:[...new Set(available.map(r=>r.group_username).filter(Boolean))].sort(),totals:totals(people),reply_outcomes,by_day:groups(people,'cohort_day'),by_group:groups(people,'group_username'),last_reviewed_at:people.reduce((last,r)=>r.reviewed_at&&(!last||r.reviewed_at>last)?r.reviewed_at:last,null)};
 }
 async function conversationReviews(p,id,input={}){
  id=uuid(id);const f=filters(input,true);const all=await rows(p,id,f);
  const selected=f.pending_only?all.filter(r=>r.pending_review):all;
  return {items:selected.slice((f.page-1)*f.page_size,f.page*f.page_size),total:selected.length,page:f.page,page_size:f.page_size};
 }
 async function saveConversationOutcome(p,id,jobId,input){
  id=uuid(id);jobId=uuid(jobId);assertScope(p,'outreach:read',id);assertScope(p,'outreach:draft',id);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['status','reason','expected_snapshot','evidence_message_ids'].includes(k))||
   !OUTCOME_STATUSES.includes(input.status)||typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>1000||
   typeof input.expected_snapshot!=='string'||!(/^[a-f0-9]{32}$/).test(input.expected_snapshot)||
   !Array.isArray(input.evidence_message_ids)||input.evidence_message_ids.length<1||input.evidence_message_ids.length>20||
   input.evidence_message_ids.some(x=>typeof x!=='string'||!(/^[1-9]\d{0,18}$/).test(x)||BigInt(x)>9223372036854775807n)||
   new Set(input.evidence_message_ids).size!==input.evidence_message_ids.length)throw fail('outcome_invalid');
  return ownerTransaction(p,async db=>{
   await campaign(p,id,'outreach:draft',db);
   const job=(await db.query("SELECT connection_id,recipient_id::text FROM cabinet_jobs WHERE owner_id=$1 AND campaign_id=$2 AND id=$3 AND status='sent'",[p.owner_id,id,jobId])).rows[0];
   if(!job)throw fail('thread_not_found',404);
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['cabinet-replies:'+job.connection_id]);
   const all=await rows(p,id,{from:null,to:null,group:null},db),row=all.find(r=>r.recipient_id===job.recipient_id);
   if(!row)throw fail('thread_not_found',404);
   if(row.snapshot!==input.expected_snapshot)throw fail('outcome_snapshot_changed',409);
   const source=p.kind==='owner'?'manual':'agent';
   if(source==='agent'&&row.review_source==='manual')throw fail('outcome_manual_locked',409);
   const evidence=(await db.query(`SELECT m.telegram_message_id::text,m.direction FROM cabinet_messages m
     JOIN cabinet_jobs j ON j.id=m.job_id AND j.owner_id=m.owner_id
     WHERE m.owner_id=$1 AND j.campaign_id=$2 AND j.recipient_id=$3 AND j.status='sent'
       AND m.telegram_message_id=ANY($4::bigint[])`,[p.owner_id,id,job.recipient_id,input.evidence_message_ids])).rows;
   if(evidence.length!==input.evidence_message_ids.length|| (source==='agent'&&!evidence.some(m=>m.direction==='inbound')))throw fail('outcome_evidence_invalid');
   if(source==='agent'&&input.status==='booked'&&!evidence.some(m=>m.direction==='outbound'))throw fail('outcome_booking_evidence_required');
   const saved=(await db.query(`INSERT INTO cabinet_conversation_outcomes(owner_id,campaign_id,recipient_id,status,reason,evidence_message_ids,snapshot,review_source,actor_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(owner_id,campaign_id,recipient_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,
      evidence_message_ids=EXCLUDED.evidence_message_ids,snapshot=EXCLUDED.snapshot,review_source=EXCLUDED.review_source,actor_key=EXCLUDED.actor_key,
      reviewed_at=CASE WHEN (cabinet_conversation_outcomes.status,cabinet_conversation_outcomes.reason,cabinet_conversation_outcomes.evidence_message_ids,cabinet_conversation_outcomes.snapshot,cabinet_conversation_outcomes.review_source)
       IS DISTINCT FROM (EXCLUDED.status,EXCLUDED.reason,EXCLUDED.evidence_message_ids,EXCLUDED.snapshot,EXCLUDED.review_source) THEN now() ELSE cabinet_conversation_outcomes.reviewed_at END
    RETURNING status,reason,evidence_message_ids::text[],snapshot,review_source,reviewed_at`,
    [p.owner_id,id,job.recipient_id,input.status,input.reason.trim(),input.evidence_message_ids,row.snapshot,source,p.actor_key])).rows[0];
   return {job_id:row.job_id,recipient_id:row.recipient_id,...saved};
  });
 }
 async function followUps(p,id,input={}){
  id=uuid(id);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['view','page','page_size'].includes(k)))throw fail('follow_up_filters_invalid');
  const view=input.view??'all',page=Number(input.page??1),page_size=Number(input.page_size??50);
  if(!['all','undated','due','upcoming'].includes(view)||!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(page_size)||page_size<1||page_size>100)throw fail('follow_up_filters_invalid');
  // Use the retained assessment even while a new message is awaiting review.
  const deferred=(await rows(p,id,{from:null,to:null,group:null})).filter(r=>r.assessed_status==='later');
  const today=(await query("SELECT (now() AT TIME ZONE 'Europe/Moscow')::date::text AS day")).rows[0].day;
  const kind=r=>!r.follow_up_on?'undated':r.follow_up_on<=today?'due':'upcoming';
  const totals={total:deferred.length,undated:0,due:0,upcoming:0};for(const r of deferred)totals[kind(r)]++;
  const priority={due:0,undated:1,upcoming:2};
  const selected=deferred.filter(r=>view==='all'||kind(r)===view).sort((a,b)=>priority[kind(a)]-priority[kind(b)]||(a.follow_up_on||'').localeCompare(b.follow_up_on||'')||a.first_sent_at-b.first_sent_at||(BigInt(a.recipient_id)<BigInt(b.recipient_id)?-1:1));
  return {time_zone:'Europe/Moscow',today,totals,total:selected.length,page,page_size,items:selected.slice((page-1)*page_size,page*page_size)};
 }
 async function saveFollowUp(p,id,jobId,input){
  ownerOnly(p);id=uuid(id);jobId=uuid(jobId);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['follow_up_on','follow_up_note','expected_snapshot'].includes(k))||
    !(input.follow_up_on===null||typeof input.follow_up_on==='string'&&input.follow_up_on!=='')||typeof input.follow_up_note!=='string'||input.follow_up_note.length>1000||
    typeof input.expected_snapshot!=='string'||!(/^[a-f0-9]{32}$/).test(input.expected_snapshot))throw fail('follow_up_invalid');
  let day=null;try{if(input.follow_up_on!==null)day=date(input.follow_up_on);}catch{throw fail('follow_up_invalid');}
  return ownerTransaction(p,async db=>{
   await campaign(p,id,'outreach:draft',db);
   const job=(await db.query("SELECT connection_id,recipient_id::text FROM cabinet_jobs WHERE owner_id=$1 AND campaign_id=$2 AND id=$3 AND status='sent'",[p.owner_id,id,jobId])).rows[0];
   if(!job)throw fail('thread_not_found',404);
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['cabinet-replies:'+job.connection_id]);
   const row=(await rows(p,id,{from:null,to:null,group:null},db)).find(r=>r.recipient_id===job.recipient_id);
   if(!row)throw fail('thread_not_found',404);
   if(row.snapshot!==input.expected_snapshot)throw fail('outcome_snapshot_changed',409);
   if(row.assessed_status!=='later')throw fail('follow_up_not_deferred',409);
   const saved=(await db.query(`UPDATE cabinet_conversation_outcomes SET follow_up_on=$4,follow_up_note=$5,
     follow_up_updated_at=now(),follow_up_actor_key=$6 WHERE owner_id=$1 AND campaign_id=$2 AND recipient_id=$3
     RETURNING follow_up_on::text,follow_up_note,follow_up_updated_at`,[p.owner_id,id,job.recipient_id,day,input.follow_up_note.trim(),p.actor_key])).rows[0];
   await db.query("INSERT INTO cabinet_audit(owner_id,actor_key,action,target_id) VALUES($1,$2,'follow_up_schedule',$3)",[p.owner_id,p.actor_key,row.job_id]);
   return {job_id:row.job_id,recipient_id:row.recipient_id,...saved};
  });
 }
 return {campaignStats,conversationReviews,saveConversationOutcome,followUps,saveFollowUp};
}
