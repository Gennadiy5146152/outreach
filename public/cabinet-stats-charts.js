const DAY=86400000;
const iso=d=>new Date(d).toISOString().slice(0,10);
export function buildChartBuckets(rows,from,to){
 const sorted=[...rows].sort((a,b)=>a.cohort_day.localeCompare(b.cohort_day));
 if(!from&&!to&&!sorted.length)return [];
 const start=Date.parse((from||sorted[0]?.cohort_day||to)+'T00:00:00Z');
 const end=Date.parse((to||sorted.at(-1)?.cohort_day||from)+'T00:00:00Z');
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return [];
 const span=Math.round((end-start)/DAY)+1,step=Math.max(1,Math.ceil(span/28));
 const buckets=Array.from({length:Math.ceil(span/step)},(_,i)=>({day:iso(start+i*step*DAY),end:iso(Math.min(end,start+((i+1)*step-1)*DAY)),sent:0,replied:0,interested:0,booked:0}));
 for(const r of sorted){const at=Date.parse(r.cohort_day+'T00:00:00Z');if(at<start||at>end)continue;const bucket=buckets[Math.floor((at-start)/(step*DAY))];for(const k of ['sent','replied','interested','booked'])bucket[k]+=Number(r[k]||0);}
 return buckets;
}
const NS='http://www.w3.org/2000/svg';
function svg(tag,attrs={},text){const e=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
const shortDate=d=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(d+'T00:00:00Z')).replace('.','');
const pct=n=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(n)+'%';
export function drawActivityChart(target,rows,from,to,onSelect){
 const buckets=buildChartBuckets(rows,from,to),w=Math.max(260,target.clientWidth||640),h=224,left=30,right=12,top=24,bottom=35,pw=w-left-right,ph=h-top-bottom;
 const chart=svg('svg',{viewBox:`0 0 ${w} ${h}`,role:'img','aria-label':'Отправленные сообщения, ответы и интерес по дате первого обращения',class:'dashboard-chart-svg'});
 const highest=Math.max(1,...buckets.map(r=>r.sent)),rough=highest/4,magnitude=10**Math.floor(Math.log10(rough)),step=Math.max(1,Math.ceil(rough/magnitude)*magnitude),max=step*4;
 for(let i=0;i<=4;i++){const y=top+ph-i*ph/4;chart.append(svg('line',{x1:left,x2:w-right,y1:y,y2:y,class:'chart-grid'}),svg('text',{x:left-10,y:y+4,'text-anchor':'end',class:'chart-axis'},String(step*i)));}
 if(!buckets.some(r=>r.sent)){chart.append(svg('text',{x:w/2,y:top+ph/2,'text-anchor':'middle',class:'chart-empty'},'За период нет отправлений'));target.replaceChildren(chart);return;}
 const slot=pw/Math.max(buckets.length,1),bar=Math.min(16,Math.max(3,(slot-12)/3)),ticks=Math.max(1,Math.floor(w/74));
 buckets.forEach((r,i)=>{
  const x=left+slot*i+slot/2,group=svg('g',{tabindex:'0',role:'button','aria-label':`${shortDate(r.day)}: написали ${r.sent}, ответили ${r.replied}, интерес ${r.interested}`});
  group.append(svg('title',{},`${r.day}${r.end!==r.day?' – '+r.end:''}\nНаписали: ${r.sent}\nОтветили: ${r.replied}\nИнтерес: ${r.interested}`));
  group.append(svg('rect',{x:left+slot*i,y:top,width:slot,height:ph,fill:'transparent',class:'chart-hit'}));
  ['sent','replied','interested'].forEach((key,n)=>{const height=r[key]/max*ph,bx=x+(n-1)*bar-bar/2;group.append(svg('rect',{x:bx,y:top+ph-height,width:bar-1,height,rx:3,class:'chart-bar chart-'+key}));if(r[key]&&slot>64)group.append(svg('text',{x:bx+(bar-1)/2,y:top+ph-height-7,'text-anchor':'middle',class:'chart-value'},String(r[key])));});
  if(i===0||i===buckets.length-1||i%Math.ceil(buckets.length/ticks)===0)chart.append(svg('text',{x,y:h-9,'text-anchor':'middle',class:'chart-axis'},shortDate(r.day)));
  const select=()=>onSelect?.(r.day,r.end);group.addEventListener('click',select);group.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select();}});chart.append(group);
 });
 target.replaceChildren(chart);
}
export function drawFunnel(target,t){
 const rows=[['Написали',t.sent,'sent'],['Получили ответ',t.replied,'replied'],['Есть интерес',t.interested,'interested'],['Записались',t.booked,'booked']];
 target.replaceChildren(...rows.map(([label,count,key],i)=>{const row=node('div',undefined,'funnel-row');const text=node('div',undefined,'funnel-row-label');text.append(node('span',String(i+1).padStart(2,'0'),'funnel-index'),node('span',label),node('strong',String(count)),node('small',t.sent?pct(count/t.sent*100):'—'));const track=node('div',undefined,'funnel-track'),fill=node('div',undefined,'funnel-fill funnel-'+key);fill.style.width=(t.sent?Math.min(100,count/t.sent*100):0)+'%';track.append(fill);row.append(text,track);return row;}));
}
export function drawSourceRanking(target,rows,onSelect){
 target.replaceChildren();if(!rows.length){target.append(node('p','Группы появятся после первых отправлений.','chart-empty-note'));return;}
 for(const r of [...rows].sort((a,b)=>b.sent-a.sent).slice(0,8)){
  const row=node('button',undefined,'source-rank');row.type='button';const head=node('span',undefined,'source-rank-head');head.append(node('strong',r.group_username==='unknown'?'Источник не указан':'@'+r.group_username),node('span',r.reply_rate===null?'—':pct(r.reply_rate)));
  const track=node('span',undefined,'source-rank-track'),fill=node('span');fill.style.width=(r.reply_rate??0)+'%';track.append(fill);row.append(head,track,node('small',`${r.replied} ответов из ${r.sent} · интерес ${r.interested}`));
  row.title='Показать получателей из этой группы';if(r.group_username==='unknown')row.disabled=true;else row.onclick=()=>onSelect(r.group_username);target.append(row);
 }
}
export function drawReplyOutcomes(target,counts){
 const definitions=[['interested','Есть интерес','var(--chart-interest)'],['booked','Записались','var(--chart-booked)'],['later','Отложили','var(--chart-later)'],['declined','Отказались','var(--chart-declined)'],['not_target','Не подходит','var(--chart-muted)'],['needs_review','Нужен разбор','var(--chart-review)']];
 const total=definitions.reduce((n,[key])=>n+Number(counts[key]||0),0),circumference=2*Math.PI*58;
 const chart=svg('svg',{viewBox:'0 0 160 160',role:'img','aria-label':`Результаты ${total} ответивших получателей`,class:'outcomes-donut'});
 chart.append(svg('circle',{cx:80,cy:80,r:58,fill:'none',stroke:'var(--chart-track)','stroke-width':18}));
 let offset=0;for(const [key,label,color]of definitions){const value=Number(counts[key]||0);if(!value||!total)continue;const length=value/total*circumference,segment=svg('circle',{cx:80,cy:80,r:58,fill:'none',stroke:color,'stroke-width':18,'stroke-dasharray':`${length} ${circumference-length}`,'stroke-dashoffset':-offset,transform:'rotate(-90 80 80)',tabindex:0,'aria-label':`${label}: ${value}`});segment.append(svg('title',{},`${label}: ${value} (${pct(value/total*100)})`));chart.append(segment);offset+=length;}
 chart.append(svg('text',{x:80,y:79,'text-anchor':'middle',class:'donut-number'},String(total)),svg('text',{x:80,y:101,'text-anchor':'middle',class:'donut-caption'},'ответили'));
 const legend=node('div',undefined,'outcomes-legend');for(const [key,label,color]of definitions){const row=node('div'),dot=node('i');dot.style.background=color;row.append(dot,node('span',label),node('strong',String(counts[key]||0)));legend.append(row);}target.replaceChildren(chart,legend);
}
