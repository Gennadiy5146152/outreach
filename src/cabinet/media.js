import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fail,uuid} from './security.js';
const TYPES=new Set(['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/flac','audio/webm','audio/aac','video/mp4','video/webm','video/quicktime']);
const BASE=`FROM cabinet_media md JOIN cabinet_jobs j ON j.id=md.job_id AND j.owner_id=md.owner_id
 JOIN cabinet_messages m ON m.owner_id=md.owner_id AND m.job_id=md.job_id AND m.connection_id=md.connection_id AND m.telegram_message_id=md.telegram_message_id
 JOIN cabinet_messages anchor ON anchor.owner_id=j.owner_id AND anchor.job_id=j.id AND anchor.connection_id=j.connection_id AND anchor.telegram_message_id=j.telegram_message_id AND anchor.direction='outbound'
 WHERE md.owner_id=$1 AND j.campaign_id=$2 AND j.status='sent' AND j.completed_at IS NOT NULL AND md.connection_id=j.connection_id AND md.recipient_id=j.recipient_id AND m.telegram_message_id>anchor.telegram_message_id`;
export function createCabinetMedia({query,campaign,mediaDir=path.resolve('storage/cabinet-media')}){
 async function mediaList(p,id,input={}){
  id=uuid(id);await campaign(p,id,'outreach:read');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['job_id','page','page_size'].includes(k)))throw fail('media_filters_invalid');
  const job=input.job_id?uuid(input.job_id):null,page=Number(input.page??1),page_size=Number(input.page_size??50);
  if(!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(page_size)||page_size<1||page_size>100)throw fail('media_filters_invalid');
  const result=await query(`SELECT md.id,md.job_id,md.telegram_message_id::text,md.kind,md.mime_type,md.size_bytes::text,md.stored_bytes::text,md.duration_seconds,md.status,md.error_code,md.created_at,md.updated_at,m.direction,m.sent_at,m.timestamp_source ${BASE} AND ($3::uuid IS NULL OR j.id=$3) ORDER BY md.created_at,md.id`,[p.owner_id,id,job]);
  const fields=['id','job_id','telegram_message_id','kind','mime_type','size_bytes','stored_bytes','duration_seconds','status','error_code','created_at','updated_at','direction','sent_at','timestamp_source'];
  const all=result.rows.map(m=>({...Object.fromEntries(fields.map(key=>[key,m[key]])),download_url:m.status==='ready'?`/api/cabinet/campaigns/${id}/media/${m.id}`:null}));
  return {items:all.slice((page-1)*page_size,page*page_size),total:all.length,page,page_size};
 }
 async function openMedia(p,id,mediaId){
  id=uuid(id);mediaId=uuid(mediaId);await campaign(p,id,'outreach:read');
  const row=(await query(`SELECT md.id,md.owner_id,md.job_id,md.telegram_message_id::text,md.kind,md.mime_type,md.size_bytes::text,md.stored_bytes::text,md.status,md.storage_key ${BASE} AND md.id=$3`,[p.owner_id,id,mediaId])).rows[0];
  if(!row)throw fail('media_not_found',404);if(row.status!=='ready')throw fail('media_not_ready',409);
  let handle;
  try{
   const prefix=String(p.owner_id)+'/'+mediaId+'.',key=row.storage_key;
   if(typeof key!=='string'||!key.startsWith(prefix)||!(/^[a-z0-9]{1,8}$/).test(key.slice(prefix.length)))throw new Error();
   const root=await fs.realpath(mediaDir),ownerDir=path.join(root,String(p.owner_id)),target=path.join(root,key),ownerStat=await fs.lstat(ownerDir);
   if(!ownerStat.isDirectory()||ownerStat.isSymbolicLink()||await fs.realpath(ownerDir)!==ownerDir)throw new Error();
   handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat({bigint:true});
   if(!stat.isFile()||stat.size<=0n||stat.size!==BigInt(row.stored_bytes)||stat.size!==BigInt(row.size_bytes)||stat.size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error();
   return {handle,size:Number(stat.size),mime_type:TYPES.has(row.mime_type)?row.mime_type:'application/octet-stream',filename:`${row.kind}-${row.telegram_message_id}.${key.slice(prefix.length)}`};
  }catch{if(handle)await handle.close();throw fail('media_unavailable',503);}
 }
 return {mediaList,openMedia};
}
export function parseMediaRange(value,size){
 if(value===undefined)return {start:0,end:size-1,partial:false};
 const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(size)||size<=0)throw fail('media_range_invalid',416);
 let start,end;
 if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)throw fail('media_range_invalid',416);start=Math.max(0,size-suffix);end=size-1;}
 else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)throw fail('media_range_invalid',416);end=Math.min(end,size-1);}
 return {start,end,partial:true};
}
export async function sendPrivateMedia(req,res,file){
 const {handle,size}=file;
 try{
  res.set({'Content-Type':file.mime_type,'Content-Disposition':`${req.query?.download==='1'?'attachment':'inline'}; filename="${file.filename}"`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"sandbox; default-src 'none'",'Accept-Ranges':'bytes'});
  let range;try{range=parseMediaRange(req.headers.range,size);}catch(error){res.set('Content-Range',`bytes */${size}`);res.status(416).end();return;}
  const {start,end,partial}=range;res.status(partial?206:200);res.set('Content-Length',String(end-start+1));if(partial)res.set('Content-Range',`bytes ${start}-${end}/${size}`);
  if(req.method==='HEAD'){res.end();return;}
  const stream=handle.createReadStream({start,end,autoClose:false});
  try{await pipeline(stream,res);}catch(error){if(!res.destroyed&&!res.headersSent)throw error;}
 }finally{await handle.close();}
}
