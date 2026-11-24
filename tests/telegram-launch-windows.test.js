import test from 'node:test';
import assert from 'node:assert/strict';
import * as profiles from '../src/services/telegram-profiles.js';
test('dated windows produce exactly ten morning and ten evening slots with hard deadlines',()=>{
 const fn=profiles.telegramLaunchWindows;
 assert.equal(typeof fn,'function');
 const result=fn({day:'2026-11-25',limit:20,count:20,now:new Date('2026-11-24T10:00:00Z'),windows:[{start:'09:30',end:'11:30',count:10},{start:'17:00',end:'19:00',count:10}]});
 assert.equal(result.slots.length,20);
 assert.deepEqual(result.override,{daily_limit:20,window_start:'09:30',window_end:'19:00'});
 for(let i=0;i<20;i++){
  const j=result.slots[i],morning=i<10;
  assert.ok(new Date(j.scheduled_at)>=new Date(`2026-11-25T${morning?'09:30':'17:00'}:00+03:00`));
  assert.ok(new Date(j.scheduled_at)<new Date(j.send_before));
  assert.equal(j.send_before,new Date(`2026-11-25T${morning?'11:30':'19:00'}:00+03:00`).toISOString());
  if(i>0)assert.ok(new Date(j.scheduled_at)-new Date(result.slots[i-1].scheduled_at)>=120000);
 }
 for(const windows of [[{start:'09:30',end:'11:30',count:21}],[{start:'09:30',end:'11:30',count:10},{start:'10:00',end:'12:00',count:10}],[{start:'09:30',end:'09:40',count:20}],[{start:'25:30',end:'27:00',count:20}],[]])
 assert.throws(()=>fn({day:'2026-11-25',limit:20,count:20,now:new Date('2026-11-24T10:00:00Z'),windows}));
 assert.throws(()=>fn({day:'2026-11-24',limit:20,count:20,now:new Date('2026-11-24T18:00:00Z'),windows:[{start:'09:30',end:'11:30',count:20}]}));
});
