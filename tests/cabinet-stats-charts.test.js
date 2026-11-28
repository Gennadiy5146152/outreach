import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChartBuckets} from '../public/cabinet-stats-charts.js';
test('chart uses real cohorts, fills zero-activity days and keeps exact totals',()=>{
 const rows=buildChartBuckets([{cohort_day:'2026-11-27',sent:16,replied:6,interested:4,booked:0}], '2026-11-22','2026-11-28');
 assert.equal(rows.length,7);assert.deepEqual(rows[5],{day:'2026-11-27',end:'2026-11-27',sent:16,replied:6,interested:4,booked:0});
 assert.equal(rows[0].sent,0);assert.equal(rows[6].sent,0);assert.equal(rows.reduce((n,r)=>n+r.replied,0),6);
});
test('long chart periods aggregate without inventing data or losing boundaries',()=>{
 const rows=buildChartBuckets([{cohort_day:'2025-01-01',sent:3,replied:1,interested:0,booked:0},{cohort_day:'2026-11-27',sent:16,replied:6,interested:4,booked:0}], '2025-01-01','2026-11-28');
 assert.ok(rows.length<=32);assert.equal(rows.reduce((n,r)=>n+r.sent,0),19);assert.equal(rows.reduce((n,r)=>n+r.replied,0),7);
});
test('unfiltered single observed cohort stays a single observation; empty remains empty',()=>{
 assert.equal(buildChartBuckets([{cohort_day:'2026-11-27',sent:16,replied:6,interested:4,booked:0}],null,null).length,1);
 assert.deepEqual(buildChartBuckets([],null,null),[]);
});
