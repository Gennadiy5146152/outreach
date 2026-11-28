import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import express from 'express';import {randomUUID} from 'node:crypto';
import {createCabinetMedia,sendPrivateMedia,parseMediaRange} from '../src/cabinet/media.js';
import {assertScope,fail} from '../src/cabinet/security.js';
test('private media ranges reject malformed/multi/empty or out-of-bounds input',()=>{
 assert.deepEqual(parseMediaRange(undefined,12),{start:0,end:11,partial:false});assert.deepEqual(parseMediaRange('bytes=2-5',12),{start:2,end:5,partial:true});assert.deepEqual(parseMediaRange('bytes=-3',12),{start:9,end:11,partial:true});assert.deepEqual(parseMediaRange('bytes=8-',12),{start:8,end:11,partial:true});
 for(const range of ['bytes=12-','bytes=5-2','bytes=-0','bytes=0-1,3-4','other=0-2','bytes=1e3-','bytes=9007199254740993-'])assert.throws(()=>parseMediaRange(range,12),/media_range_invalid/);
});
test('authenticated media reads stream one regular owned file and never expose filesystem metadata',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cabinet-media-')),owner=randomUUID(),id=randomUUID(),campaignId=randomUUID(),job=randomUUID();const key=owner+'/'+id+'.ogg',bytes=Buffer.from('OggS-private-audio');await fs.mkdir(path.join(root,owner));await fs.writeFile(path.join(root,key),bytes);
 const p={kind:'token',owner_id:owner,scopes:['outreach:read'],campaign_ids:[campaignId]},row={id,owner_id:owner,job_id:job,telegram_message_id:'1234',kind:'voice',mime_type:'audio/ogg',size_bytes:String(bytes.length),stored_bytes:String(bytes.length),status:'ready',storage_key:key};
 const media=createCabinetMedia({mediaDir:root,campaign:async(principal,cid)=>{assertScope(principal,'outreach:read',cid);if(principal.owner_id!==owner)throw fail('campaign_not_found',404);},query:async(sql,args)=>({rows:args[0]===owner&&args[1]===campaignId&&(!args[2]||args[2]===id)?[row]:[]})});
 const app=express();app.get('/media',async(req,res)=>{try{const principal=req.headers.authorization==='own'?p:req.headers.authorization==='other'?{...p,owner_id:randomUUID()}:null;if(!principal)throw fail('cabinet_auth_required',401);await sendPrivateMedia(req,res,await media.openMedia(principal,campaignId,id));}catch(e){if(!res.headersSent)res.status(e.status||500).json({error:e.message});}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/media';
 try{
  const metadata=await media.mediaList(p,campaignId);assert.ok(!JSON.stringify(metadata).includes('storage_key'));assert.ok(!JSON.stringify(metadata).includes(root));
  let r=await fetch(url,{headers:{authorization:'own'}});assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  r=await fetch(url,{headers:{authorization:'own',range:'bytes=2-5'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes 2-5/${bytes.length}`);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(2,6));
  r=await fetch(url,{method:'HEAD',headers:{authorization:'own'}});assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,0);
  r=await fetch(url,{headers:{range:'bytes=999-'}});assert.equal(r.status,401);assert.equal(r.headers.get('content-range'),null);
  r=await fetch(url,{headers:{authorization:'other',range:'bytes=999-'}});assert.equal(r.status,404);assert.equal(r.headers.get('content-range'),null);
  r=await fetch(url,{headers:{authorization:'own',range:'bytes=999-'}});assert.equal(r.status,416);
  await fs.unlink(path.join(root,key));await fs.symlink('/etc/hosts',path.join(root,key));await assert.rejects(media.openMedia(p,campaignId,id),/media_unavailable/);
  row.storage_key='../outside.ogg';await assert.rejects(media.openMedia(p,campaignId,id),/media_unavailable/);
 }finally{await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
});
