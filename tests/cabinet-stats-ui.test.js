import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Optional real-browser boundary check: PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/cjs/puppeteer/puppeteer.js
const browserModule=process.env.PUPPETEER_MODULE;
test('analytics navigation preserves the latest page/campaign and correction evidence is explicit',{skip:!browserModule},async()=>{
 const {default:puppeteer}=await import(browserModule);
 const publicRoot=new URL('../public/',import.meta.url);
 const server=http.createServer(async(req,res)=>{
  try{const pathname=new URL(req.url,'http://localhost').pathname;
   if(pathname==='/'){const html=(await fs.readFile(new URL('cabinet.html',publicRoot),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.setHeader('content-type','text/html');res.end(html);return;}
   if(!['/cabinet.css','/cabinet-stats.js','/cabinet-stats-charts.js'].includes(pathname)){res.writeHead(404);res.end();return;}
   res.setHeader('content-type',pathname.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(fileURLToPath(new URL('.'+pathname,publicRoot))));
  }catch(e){res.writeHead(500);res.end(e.message);}
 });
 server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await puppeteer.launch({headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
   document.getElementById('workspace').hidden=false;document.getElementById('analytics').hidden=false;document.getElementById('overview').hidden=true;
   const {createCabinetStats}=await import('/cabinet-stats.js');
   const h=window.harness={hold:false,pending:[],requests:[],patches:[]};
   h.api=async(path,body,method)=>{
    h.requests.push(path);const url=new URL(path,location.origin),id=path.split('/')[2];
    if(method==='PATCH'){h.patches.push(body);return {};}
    if(path.includes('/threads/'))return [{telegram_message_id:'201',direction:'inbound',body:'Сколько стоит?',sent_at:'2026-11-27T09:10:00Z'},{telegram_message_id:'202',direction:'outbound',body:'Стоимость 100',sent_at:'2026-11-27T09:12:00Z'}];
    if(h.hold)await new Promise(resolve=>h.pending.push(resolve));
    const totals={sent:35,replied:1,interested:1,booked:0,later:0,declined:0,needs_review:0,reply_rate:2.86,interested_rate:2.86,interested_reply_rate:100,booking_rate:0,pending_review:0};
    if(path.includes('/stats?'))return {totals,filters:{from:null,to:null},available_groups:h.noSources?[]:['liauto'],by_day:[{cohort_day:'2026-11-27',...totals}],by_group:[],reply_outcomes:{interested:1},last_reviewed_at:null};
    const current=Number(url.searchParams.get('page')),start=(current-1)*20;
    return {total:35,items:Array.from({length:Math.min(20,35-start)},(_,i)=>({job_id:'job'+(start+i),job_ids:['job'+(start+i)],recipient_id:String(start+i+1),name:id+' person '+(start+i+1),address:'https://t.me/person_'+(start+i),group_username:'liauto',source_url:'https://t.me/liauto/123',status:'interested',assessed_status:'interested',reason:'Спросил цену',inbound_count:1,first_sent_at:'2026-11-27T09:00:00Z',last_inbound_at:'2026-11-27T09:10:00Z',evidence_message_ids:['201'],snapshot:'a'.repeat(32)}))};
   };
   h.stats=createCabinetStats({api:h.api,at:x=>x,onCampaignChange:id=>h.stats.select(id)});
   h.stats.setCampaigns([{id:'a',name:'First'},{id:'b',name:'Second'}]);await h.stats.select('a');
  });
  await page.evaluate(()=>{harness.hold=true;document.getElementById('statsRefresh').click();});
  await page.waitForFunction(()=>harness.pending.length===2);
  await page.evaluate(()=>document.getElementById('statsNext').click());
  await page.evaluate(()=>{harness.hold=false;harness.pending.splice(0).forEach(resolve=>resolve());});
  await page.waitForFunction(()=>document.getElementById('statsPage').textContent==='21–35 из 35 контактов');
  assert.equal(await page.$eval('#statsReviews tbody tr strong',e=>e.textContent),'a person 21');
  await page.evaluate(()=>{harness.hold=true;document.getElementById('statsRefresh').click();});
  await page.waitForFunction(()=>harness.pending.length===2);
  await page.evaluate(()=>harness.stats.select('b'));
  assert.equal(await page.$eval('#statsReviews',e=>e.textContent),'');
  await page.evaluate(()=>{harness.hold=false;harness.pending.splice(0).forEach(resolve=>resolve());});
  await page.waitForFunction(()=>document.querySelector('#statsReviews tbody tr strong')?.textContent==='b person 1');
  await page.evaluate(()=>document.querySelector('#statsReviews .dashboard-more').click());
  await page.waitForFunction(()=>document.getElementById('statsEditEvidence').options.length===2);
  assert.deepEqual(await page.$eval('#statsEditEvidence',e=>[...e.selectedOptions].map(o=>o.value)),['201']);
  await page.select('#statsEditStatus','later');
  assert.deepEqual(await page.$eval('#statsEditEvidence',e=>[...e.selectedOptions].map(o=>o.value)),[]);
  await page.select('#statsEditEvidence','202');
  await page.evaluate(()=>{document.getElementById('statsEditReason').value='Договорились вернуться позже';document.getElementById('statsEditForm').requestSubmit(document.querySelector('#statsEditForm button[type=submit]'));});
  await page.waitForFunction(()=>harness.patches.length===1);
  assert.deepEqual(await page.evaluate(()=>harness.patches[0].evidence_message_ids),['202']);assert.deepEqual(errors,[]);
  await page.select('#statsGroup','liauto');
  await page.evaluate(()=>{harness.noSources=true;document.getElementById('statsFilters').requestSubmit();});
  await page.waitForFunction(()=>!document.getElementById('statsRefresh').disabled);
  assert.equal(await page.$eval('#statsGroup',e=>e.value),'liauto');
  await page.evaluate(()=>document.getElementById('statsRefresh').click());
  await page.waitForFunction(()=>!document.getElementById('statsRefresh').disabled);
  assert.ok(await page.evaluate(()=>harness.requests.at(-1).includes('group_username=liauto')));
  await page.evaluate(async()=>{const {drawActivityChart}=await import('/cabinet-stats-charts.js');drawActivityChart(document.getElementById('statsTrend'),[{cohort_day:'2026-11-27',sent:1,replied:0,interested:0}],null,null);});
  assert.deepEqual(await page.$$eval('#statsTrend .chart-axis',nodes=>nodes.slice(0,5).map(n=>n.textContent)),['0','1','2','3','4']);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
