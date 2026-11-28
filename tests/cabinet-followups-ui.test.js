import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs/promises';
const browserModule=process.env.PUPPETEER_MODULE;
test('deferred page leaves dates blank until owner action, supports rescheduling/clearing and mobile layout',{skip:!browserModule},async()=>{
 const {default:puppeteer}=await import(browserModule),root=new URL('../public/',import.meta.url);
 const server=http.createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;if(!['/','/cabinet.css','/cabinet-followups.js'].includes(path)){res.writeHead(404);res.end();return;}const file=path==='/'?'cabinet.html':path.slice(1);let source=await fs.readFile(new URL(file,root),'utf8');if(path==='/')source=source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.setHeader('content-type',path==='/'?'text/html':path.endsWith('.css')?'text/css':'text/javascript');res.end(source);}catch(e){res.writeHead(500);res.end(e.message);}});
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const browser=await puppeteer.launch({headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1450,height:1000});await page.goto('http://127.0.0.1:'+server.address().port+'/#followups');
  await page.evaluate(async()=>{
   document.getElementById('workspace').hidden=false;document.querySelectorAll('[data-cabinet-page]').forEach(e=>e.hidden=e.id!=='followups');
   const {createCabinetFollowUps}=await import('/cabinet-followups.js');
   const row={job_id:'job1',job_ids:['job1'],recipient_id:'1',name:'Отложенный клиент',address:'https://t.me/later_customer',group_username:'liauto',source_url:'https://t.me/liauto/123',reason:'Пока отложил оклейку крыши',follow_up_on:null,follow_up_note:'',snapshot:'a'.repeat(32),stale:false};
   const h=window.followUpHarness={row,patches:[],requests:[],hold:false,pending:[]};
   h.api=async(path,body,method)=>{h.requests.push(path);if(method==='PATCH'){h.patches.push(body);if(h.holdPatch)await new Promise(resolve=>(h.pendingPatches??=[]).push(resolve));row.follow_up_on=body.follow_up_on;row.follow_up_note=body.follow_up_note;return {};}
    if(path.includes('/threads/'))return [{direction:'inbound',telegram_message_id:'201',body:'Пока передумал, вернёмся позже',sent_at:'2026-11-27T09:00:00Z'}];
    if(h.hold)await new Promise(resolve=>h.pending.push(resolve));
    const view=new URL(path,location.origin).searchParams.get('view'),kind=!row.follow_up_on?'undated':row.follow_up_on<='2026-11-28'?'due':'upcoming',match=view==='all'||view===kind;
    return {today:'2026-11-28',totals:{total:1,undated:kind==='undated'?1:0,due:kind==='due'?1:0,upcoming:kind==='upcoming'?1:0},total:match?1:0,items:match?[{...row,name:path.includes('/b/')?'Другой клиент':row.name}]:[]};
   };
   h.module=createCabinetFollowUps({api:h.api,at:x=>x,onCampaignChange:id=>h.module.select(id)});h.module.setCampaigns([{id:'a',name:'Москва'},{id:'b',name:'Вторая'}]);await h.module.select('a');
  });
  assert.equal(await page.evaluate(()=>followUpHarness.patches.length),0);
  assert.match(await page.$eval('#followUpRows',e=>e.textContent),/Нужно назначить/);
  await page.evaluate(()=>document.querySelector('.followup-date-action').click());assert.equal(await page.$eval('#followUpDateInput',e=>e.value),'');
  await page.evaluate(()=>{document.getElementById('followUpDateInput').value='2026-12-12';document.getElementById('followUpNote').value='Обсудить крышу';document.getElementById('followUpDateForm').requestSubmit(document.querySelector('#followUpDateForm [type=submit]'));});
  await page.waitForFunction(()=>followUpHarness.patches.length===1&&!document.getElementById('followUpDateDialog').open);
  assert.deepEqual(await page.evaluate(()=>followUpHarness.patches[0]),{follow_up_on:'2026-12-12',follow_up_note:'Обсудить крышу',expected_snapshot:'a'.repeat(32)});
  await page.evaluate(()=>document.querySelector('.followup-date-action').click());await page.evaluate(()=>{document.getElementById('followUpDateInput').value='';document.getElementById('followUpDateForm').requestSubmit(document.querySelector('#followUpDateForm [type=submit]'));});
  await page.waitForFunction(()=>followUpHarness.patches.length===2&&!document.getElementById('followUpDateDialog').open);assert.equal(await page.evaluate(()=>followUpHarness.patches[1].follow_up_on),null);
  await page.evaluate(()=>document.querySelector('.followup-thread-action').click());await page.waitForSelector('#followUpThreadDialog[open]');assert.match(await page.$eval('#followUpThreadMessages',e=>e.textContent),/вернёмся позже/);await page.evaluate(()=>document.getElementById('followUpThreadClose').click());
  await page.evaluate(()=>document.querySelector('.followup-date-action').click());
  await page.evaluate(()=>{followUpHarness.holdPatch=true;document.getElementById('followUpDateInput').value='2026-12-20';document.getElementById('followUpDateForm').requestSubmit(document.querySelector('#followUpDateForm [type=submit]'));});
  await page.waitForFunction(()=>followUpHarness.pendingPatches?.length===1);
  await page.evaluate(()=>{document.getElementById('followUpDateCancel').click();document.querySelector('.followup-date-action').click();document.getElementById('followUpNote').value='Несохранённая новая заметка';followUpHarness.holdPatch=false;followUpHarness.pendingPatches.splice(0).forEach(r=>r());});
  await page.waitForFunction(()=>!document.getElementById('followUpRefresh').disabled);
  assert.equal(await page.$eval('#followUpDateDialog',e=>e.open),true);
  assert.equal(await page.$eval('#followUpNote',e=>e.value),'Несохранённая новая заметка');
  await page.evaluate(()=>document.getElementById('followUpDateCancel').click());
  await page.evaluate(()=>{followUpHarness.hold=true;document.getElementById('followUpRefresh').click();});await page.waitForFunction(()=>followUpHarness.pending.length===1);
  await page.evaluate(()=>followUpHarness.module.select('b'));assert.equal(await page.$eval('#followUpRows',e=>e.textContent),'');await page.evaluate(()=>{followUpHarness.hold=false;followUpHarness.pending.splice(0).forEach(r=>r());});await page.waitForFunction(()=>document.getElementById('followUpRows').textContent.includes('Другой клиент'));
  await page.setViewport({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.equal(await page.$eval('.followup-date-action',e=>e.getBoundingClientRect().left>=0&&e.getBoundingClientRect().right<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
