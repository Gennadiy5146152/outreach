import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
const browserModule=process.env.PUPPETEER_MODULE;
let browser,server,origin;
before(async()=>{
 if(!browserModule)return;
 const {default:puppeteer}=await import(browserModule);
 server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  try{
   let source,type;
   if(path==='/'){
    source=`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/cabinet.css"><link rel="stylesheet" href="/response.css"><body class="cabinet-page"><main style="max-width:1240px;margin:24px auto;padding:16px">${await fs.readFile(new URL('../docs/superpowers/briefs/2026-11-28-response-ui-fragment.html',import.meta.url),'utf8')}</main></body></html>`;type='text/html';
   }else{
    const files={'/cabinet.css':'../public/cabinet.css','/response.css':'../docs/superpowers/briefs/2026-11-28-response-ui-styles.css','/cabinet-response.js':'../public/cabinet-response.js'};
    if(!files[path]){res.writeHead(404).end();return;}
    source=await fs.readFile(new URL(files[path],import.meta.url),'utf8');type=path.endsWith('.css')?'text/css':'text/javascript';
   }
   res.setHeader('content-type',type);res.end(source);
  }catch(e){res.writeHead(404).end(e.message);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 browser=await puppeteer.launch({headless:true});
});
after(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
async function open(){
 const page=await browser.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
 await page.setViewport({width:1400,height:1000});await page.goto(origin+'/#response');
 await page.evaluate(async()=>{
  const {createCabinetResponse}=await import('/cabinet-response.js');
  document.getElementById('response').hidden=false;
  const h=window.h={requests:[],patches:[],pending:[],pendingPatches:[],hold:false,holdPatch:false,failPatch:false,empty:false};
  h.api=async(path,body,method)=>{
   if(method==='PATCH'){
    h.patches.push({path,body});if(h.holdPatch)await new Promise((resolve,reject)=>h.pendingPatches.push({resolve,reject}));
    if(h.failPatch)throw new Error('response_schedule_changed');h.savedSchedule={timezone:'Europe/Moscow',weekdays:body.weekdays,start:body.start,end:body.end,revision:5,updated_at:'2026-11-27T10:03:00Z'};return h.savedSchedule;
   }
   h.requests.push(path);const q=new URL(path,location.origin).searchParams;
   const summary={answered:1,pending:1,anomalies:1,median_seconds:null,p90_seconds:null,oldest_pending_seconds:3671};
   const person=path.includes('/b/')?'Контакт Б':q.get('page')==='2'?'Вторая страница':'Первый контакт';
   const row={id:'e1',recipient_id:'1',connection_id:'conn',job_id:'j1',job_ids:['j1'],address:'https://t.me/recipient',name:person,group_username:'source_a',source_url:'https://t.me/source_a/22',side:q.get('side'),state:'pending',started_at:'2026-11-27T09:01:02Z',answered_at:null,start_message_id:'101',end_message_id:null,message_count:2,elapsed_seconds:3671,working_seconds:71,duration_seconds:q.get('mode')==='working'?71:3671,start_time_source:'service_receipt',end_time_source:null};
   const result={mode:q.get('mode'),side:q.get('side'),time_zone:'Europe/Moscow',date_basis:'episode_started_moscow_day',as_of:'2026-11-27T10:02:13Z',schedule:h.savedSchedule||{timezone:'Europe/Moscow',weekdays:[1,2,3,4,5],start:'09:00',end:'18:00',revision:4,updated_at:null},filters:{},available_groups:h.empty?[]:['source_a','source_b'],summary:{artem:summary,client:{...summary,median_seconds:95,p90_seconds:110}},by_day:h.empty?[]:[{day:'2026-11-26',...summary,median_seconds:60,p90_seconds:80},{day:'2026-11-27',...summary,median_seconds:90,p90_seconds:120}],by_group:[{group_username:'source_a',...summary}],episodes:{items:h.empty?[]:[row,{...row,id:'e2',name:'Сбой времени',state:'anomaly',duration_seconds:null,anomaly_reason:'negative_duration'},{...row,id:'e3',name:'Ответ получен',state:'answered',answered_at:'2026-11-27T09:02:37Z',end_time_source:'telegram',elapsed_seconds:95,working_seconds:95,duration_seconds:95}],total:h.empty?0:23,page:Number(q.get('page')),page_size:20}};
   if(h.hold)await new Promise(resolve=>h.pending.push(resolve));return result;
  };
  h.controller=createCabinetResponse({api:h.api,at:x=>'ТОЧНО '+x,onCampaignChange:id=>h.controller.select(id)});
  h.controller.setCampaigns([{id:'a',name:'Москва'},{id:'b',name:'Петербург'}]);await h.controller.select('a');
 });
 return page;
}
const options={skip:!browserModule};
test('response panel keeps missing answered metrics empty, shows exact times/provenance and real trend without overflow',options,async()=>{
 const page=await open();try{
  assert.equal(await page.$eval('#responseMedian',e=>e.textContent),'—');assert.equal(await page.$eval('#responseP90',e=>e.textContent),'—');
  assert.equal(await page.$eval('#responsePending',e=>e.textContent),'1');
  const rows=await page.$eval('#responseRows',e=>e.textContent);
  assert.match(rows,/Без следующего ответа/);assert.match(rows,/Пока нет/);assert.match(rows,/ТОЧНО 2026-11-27T09:01:02Z/);assert.match(rows,/Время фиксации сервисом/);assert.match(rows,/negative_duration/);assert.match(rows,/1 ч 1 мин 11 с/);
  assert.equal(await page.$$eval('#responseTrend circle',e=>e.length),4);
  for(const width of [1400,390]){await page.setViewport({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);if(process.env.RESPONSE_SCREENSHOT_DIR)await page.screenshot({path:process.env.RESPONSE_SCREENSHOT_DIR+'/response-'+width+'.png',fullPage:true});}
  assert.deepEqual(page.errors,[]);
 }finally{await page.close();}
});
test('response controls send selected mode/side/date/source/status and paginate without resetting filters',options,async()=>{
 const page=await open();try{
  await page.select('#responseMode','working');await page.waitForFunction(()=>h.requests.at(-1).includes('mode=working')&&!document.getElementById('responseRefresh').disabled);
  await page.select('#responseSide','client');await page.waitForFunction(()=>document.getElementById('responseMedian').textContent==='1 мин 35 с');
  await page.evaluate(()=>{document.getElementById('responseFrom').value='2026-11-01';document.getElementById('responseTo').value='2026-11-28';document.getElementById('responseGroup').value='source_a';document.getElementById('responseStatus').value='pending';document.getElementById('responseFilters').requestSubmit();});
  await page.waitForFunction(()=>h.requests.at(-1).includes('from=2026-11-01')&&!document.getElementById('responseRefresh').disabled);
  await page.click('#responseNext');await page.waitForFunction(()=>document.getElementById('responseRows').textContent.includes('Вторая страница'));
  const q=new URL(await page.evaluate(()=>h.requests.at(-1)),origin).searchParams;
  assert.deepEqual(Object.fromEntries(q),{mode:'working',side:'client',status:'pending',page:'2',page_size:'20',from:'2026-11-01',to:'2026-11-28',group_username:'source_a'});
 }finally{await page.close();}
});
test('response refresh queues latest filters, keeps selected missing source and clears old campaign data',options,async()=>{
 const page=await open();try{
  await page.select('#responseGroup','source_a');await page.evaluate(()=>{h.hold=true;document.getElementById('responseFilters').requestSubmit();});await page.waitForFunction(()=>h.pending.length===1);
  await page.select('#responseMode','working');await page.evaluate(()=>{h.empty=true;h.hold=false;h.pending.splice(0).forEach(r=>r());});
  await page.waitForFunction(()=>h.requests.at(-1).includes('mode=working')&&!document.getElementById('responseRefresh').disabled);
  assert.equal(await page.$eval('#responseGroup',e=>e.value),'source_a');assert.doesNotMatch(await page.$eval('#responseRows',e=>e.textContent),/Первый контакт/);
  await page.evaluate(()=>{h.empty=false;h.hold=true;void h.controller.refresh();});await page.waitForFunction(()=>h.pending.length===1);
  await page.evaluate(()=>h.controller.select('b'));assert.equal(await page.$eval('#responseRows',e=>e.textContent),'');
  await page.evaluate(()=>{h.hold=false;h.pending.splice(0).forEach(r=>r());});await page.waitForFunction(()=>document.getElementById('responseRows').textContent.includes('Контакт Б'));
  await page.evaluate(()=>h.controller.select(''));assert.equal(await page.$eval('#responseRows',e=>e.textContent),'');assert.equal(await page.$eval('#responseCalendar',e=>e.textContent),'');
 }finally{await page.close();}
});
test('calendar validates weekdays and times, sends CAS revision, keeps conflict visible and isolates delayed saves',options,async()=>{
 const page=await open();try{
  await page.click('#responseScheduleEdit');
  await page.evaluate(()=>{document.querySelectorAll('#responseWeekdays input').forEach(e=>e.checked=false);document.getElementById('responseScheduleForm').requestSubmit();});
  assert.equal(await page.evaluate(()=>h.patches.length),0);assert.match(await page.$eval('#responseScheduleError',e=>e.textContent),/день/);
  await page.evaluate(()=>{document.querySelector('#responseWeekdays input[value="6"]').checked=true;document.getElementById('responseScheduleStart').value='18:00';document.getElementById('responseScheduleEnd').value='09:00';document.getElementById('responseScheduleForm').requestSubmit();});assert.equal(await page.evaluate(()=>h.patches.length),0);
  await page.evaluate(()=>{h.failPatch=true;document.getElementById('responseScheduleStart').value='10:00';document.getElementById('responseScheduleEnd').value='17:00';document.getElementById('responseScheduleForm').requestSubmit();});
  await page.waitForFunction(()=>h.patches.length===1&&!document.getElementById('responseScheduleSave').disabled);
  assert.deepEqual(await page.evaluate(()=>h.patches[0]),{path:'/campaigns/a/response-schedule',body:{weekdays:[6],start:'10:00',end:'17:00',expected_revision:4}});
  assert.equal(await page.$eval('#responseScheduleDialog',e=>e.open),true);assert.match(await page.$eval('#responseScheduleError',e=>e.textContent),/обнов/i);
  await page.evaluate(()=>{h.failPatch=false;h.holdPatch=true;document.getElementById('responseScheduleForm').requestSubmit();});await page.waitForFunction(()=>h.pendingPatches.length===1);
  await page.click('#responseScheduleCancel');await page.click('#responseScheduleEdit');
  await page.evaluate(()=>{document.getElementById('responseScheduleStart').value='11:00';h.pendingPatches.splice(0).forEach(p=>p.resolve());});
  await page.waitForFunction(()=>!document.getElementById('responseRefresh').disabled);
  assert.equal(await page.$eval('#responseScheduleDialog',e=>e.open),true);assert.equal(await page.$eval('#responseScheduleStart',e=>e.value),'11:00');assert.equal(await page.$eval('#responseScheduleSave',e=>e.disabled),false);
  await page.setViewport({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(page.errors,[]);
 }finally{await page.close();}
});

test('successful calendar save closes the current editor and refreshes the persisted calendar',options,async()=>{
 const page=await open();try{
  await page.click('#responseScheduleEdit');
  await page.evaluate(()=>{document.getElementById('responseScheduleStart').value='10:00';document.getElementById('responseScheduleForm').requestSubmit();});
  await page.waitForFunction(()=>!document.getElementById('responseScheduleDialog').open&&document.getElementById('responseCalendar').textContent.includes('10:00–18:00'));
  assert.match(await page.$eval('#responseCalendar',e=>e.textContent),/10:00–18:00/);
  await page.click('#responseScheduleEdit');assert.equal(await page.$eval('#responseScheduleStart',e=>e.value),'10:00');
 }finally{await page.close();}
});
