const $=id=>document.getElementById(id);
const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function duration(value){if(!Number.isFinite(value)||value<0)return '—';const seconds=Math.floor(value),days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;return [[days,'д'],[hours,'ч'],[minutes,'мин'],[rest,'с']].filter(([n],i)=>n||i===3).map(([n,u])=>`${n} ${u}`).join(' ');}
function setKpiDuration(id,value){const node=$(id),text=duration(value),parts=text.match(/\d+ (?:мин|д|ч|с)/g);node.title=text;if(!parts){node.textContent=text;return;}node.replaceChildren();parts.forEach((part,index)=>{if(index)node.append(document.createTextNode(' '));node.append(el('span',part));});}
function friendly(error,fallback){const message=error?.message||'';if(message.includes('response_schedule_changed')||error?.status===409)return 'Рабочие часы уже изменились. Закройте окно, обновите данные и откройте настройки снова.';if(message.includes('response_schedule_invalid'))return 'Проверьте рабочие дни и время начала и окончания.';return message&&!/^[a-z_]+$/.test(message)?message:fallback;}
function svg(tag,attrs,text){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;return node;}
function trend(rows){
 const container=$('responseTrend');container.replaceChildren();
 const valid=rows.filter(row=>Number.isFinite(row.median_seconds)||Number.isFinite(row.p90_seconds));
 if(!valid.length){container.append(el('p','Нет завершённых эпизодов за выбранный период.','response-empty'));return;}
 const chart=svg('svg',{viewBox:'0 0 620 190',class:'response-chart',role:'img','aria-label':'Медиана и p90 ответа по московскому дню начала эпизода'}),maximum=Math.max(1,...valid.flatMap(row=>[row.median_seconds,row.p90_seconds].filter(Number.isFinite)));
 for(const [ratio,label]of [[0,'0 с'],[1,duration(maximum)]]){const y=151-ratio*125;chart.append(svg('line',{x1:70,x2:605,y1:y,y2:y,stroke:'#edf1f6'}),svg('text',{x:2,y:y-5},label));}
 const x=index=>valid.length===1?335:80+index/(valid.length-1)*505,y=value=>151-value/maximum*125;
 for(const [key,color]of [['median_seconds','#3063ce'],['p90_seconds','#18a4ad']]){
  let previous=null;
  valid.forEach((row,index)=>{if(!Number.isFinite(row[key])){previous=null;return;}const point={x:x(index),y:y(row[key])};if(previous)chart.append(svg('line',{x1:previous.x,x2:point.x,y1:previous.y,y2:point.y,stroke:color,'stroke-width':2}));const circle=svg('circle',{cx:point.x,cy:point.y,r:3.5,fill:color,tabindex:0});circle.append(svg('title',{},`${row.day} · ${key==='median_seconds'?'Медиана':'p90'}: ${duration(row[key])}`));chart.append(circle);previous=point;});
 }
 const indices=[...new Set([0,Math.floor((valid.length-1)/2),valid.length-1])];for(const index of indices)chart.append(svg('text',{x:x(index),y:177,'text-anchor':'middle'},valid[index].day.slice(8,10)+'.'+valid[index].day.slice(5,7)));
 container.append(chart);
}
export function createCabinetResponse({api,at,onCampaignChange}){
 let campaign='',page=1,total=0,generation=0,loading=false,queued=false,schedule=null,editing=null;
 const exact=value=>value?(at?at(value):value):'Пока нет';
 function error(message){$('responseError').textContent=message||'';$('responseError').hidden=!message;}
 function editError(message){$('responseScheduleError').textContent=message||'';$('responseScheduleError').hidden=!message;}
 function clear(){
  total=0;schedule=null;editing=null;error('');
  for(const id of ['responseRows','responseTrend','responseSources'])$(id).replaceChildren();
  for(const id of ['responseCalendar','responsePage','responseUpdatedAt'])$(id).textContent='';
  for(const id of ['responseMedian','responseP90','responsePending','responseOldest'])$(id).textContent='—';
  $('responsePrev').disabled=$('responseNext').disabled=$('responseScheduleEdit').disabled=true;
  $('responseGroup').replaceChildren(new Option('Все группы',''));
  if($('responseScheduleDialog').open)$('responseScheduleDialog').close();
 }
 function render(data,currentPage,side){
  const metrics=data.summary[side];schedule=data.schedule;
  setKpiDuration('responseMedian',metrics.median_seconds);setKpiDuration('responseP90',metrics.p90_seconds);setKpiDuration('responseOldest',metrics.oldest_pending_seconds);$('responsePending').textContent=String(metrics.pending);
  document.querySelector('#response .response-answered-note').textContent=`Завершённых эпизодов: ${metrics.answered}`;
  $('responseCalendar').textContent=`Рабочее время: ${schedule.weekdays.map(day=>weekdays[day-1]).join(', ')} · ${schedule.start}–${schedule.end} · Москва`;
  $('responseScheduleEdit').disabled=false;$('responseUpdatedAt').textContent='Данные на '+exact(data.as_of);
  const selected=$('responseGroup').value,groups=data.available_groups.map(group=>typeof group==='string'?group:group.group_username).filter(Boolean);if(selected&&!groups.includes(selected))groups.push(selected);
  $('responseGroup').replaceChildren(new Option('Все группы',''),...groups.map(group=>new Option('@'+group,group)));$('responseGroup').value=selected;
  trend(data.by_day);
  $('responseSources').replaceChildren(...data.by_group.map(row=>{const node=el('div',undefined,'response-source');node.append(el('span',row.group_username?'@'+row.group_username:'Без группы'),el('strong',duration(row.median_seconds)),el('small',`Ответов: ${row.answered} · без следующего: ${row.pending} · p90: ${duration(row.p90_seconds)}`));return node;}));
  if(!data.by_group.length)$('responseSources').append(el('p','За этот период нет эпизодов.','response-empty'));
  const table=el('table'),head=el('thead'),heading=el('tr'),titles=['Контакт / источник','Начало эпизода','Следующий ответ','Время','Состояние'];for(const title of titles)heading.append(el('th',title));head.append(heading);table.append(head);const body=el('tbody');
  for(const row of data.episodes.items){
   const tr=el('tr'),person=el('td');person.append(el('strong',row.name||row.address),el('small',row.address));
   if(row.group_username){const source=el('small');if(/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/\d+$/.test(row.source_url)){const link=el('a','@'+row.group_username);link.href=row.source_url;link.target='_blank';link.rel='noopener noreferrer';source.append(link);}else source.textContent='@'+row.group_username;person.append(source);}
   const start=el('td',exact(row.started_at)),end=el('td',exact(row.answered_at));start.dataset.label=titles[1];end.dataset.label=titles[2];
   if(row.start_time_source==='service_receipt')start.append(el('small','Время фиксации сервисом'));
   if(row.end_time_source==='service_receipt'&&row.answered_at)end.append(el('small','Время фиксации сервисом'));
   const timing=el('td',row.state==='anomaly'?'—':duration(row.duration_seconds));timing.dataset.label=titles[3];if(row.state!=='anomaly')timing.title=`Прошедшее: ${duration(row.elapsed_seconds)}; рабочее: ${duration(row.working_seconds)}`;
   const state=el('td'),label=row.state==='answered'?'Ответ получен':row.state==='pending'?'Без следующего ответа':'Ошибка времени';state.append(el('span',label,'response-state response-state-'+row.state));if(row.state==='anomaly')state.append(el('small',row.anomaly_reason||'Некорректные временные метки'));tr.append(person,start,end,timing,state);body.append(tr);
  }
  if(!data.episodes.items.length){const row=el('tr'),cell=el('td','За выбранный период и фильтры эпизодов нет.','response-empty');cell.colSpan=5;row.append(cell);body.append(row);}
  table.append(body);$('responseRows').replaceChildren(table);total=data.episodes.total;
  $('responsePage').textContent=total?`${(currentPage-1)*20+1}–${Math.min(currentPage*20,total)} из ${total} эпизодов`:'Нет эпизодов';$('responsePrev').disabled=currentPage<=1;$('responseNext').disabled=currentPage*20>=total;
 }
 async function refresh(){
  if(!campaign)return;if(loading){queued=true;generation++;return;}
  const from=$('responseFrom').value,to=$('responseTo').value;if(from&&to&&from>to){error('Дата начала должна быть не позже даты окончания.');return;}
  loading=true;const request=++generation,id=campaign,currentPage=page,side=$('responseSide').value,mode=$('responseMode').value;
  const q=new URLSearchParams({mode,side,status:$('responseStatus').value,page:String(currentPage),page_size:'20'});if(from)q.set('from',from);if(to)q.set('to',to);if($('responseGroup').value)q.set('group_username',$('responseGroup').value);
  $('responseRefresh').disabled=true;$('responseContent').setAttribute('aria-busy','true');
  try{const data=await api(`/campaigns/${encodeURIComponent(id)}/response-analytics?${q}`);if(request!==generation||id!==campaign||location.hash!=='#response')return;error('');render(data,currentPage,side);}catch(e){if(request===generation&&id===campaign)error(friendly(e,'Не удалось загрузить скорость ответа. Попробуйте обновить данные.'));}finally{loading=false;$('responseRefresh').disabled=false;$('responseContent').removeAttribute('aria-busy');if(queued){queued=false;void refresh();}}
 }
 $('responseCampaign').onchange=()=>void onCampaignChange?.($('responseCampaign').value);
 $('responseFilters').onsubmit=e=>{e.preventDefault();page=1;void refresh();};
 for(const id of ['responseMode','responseSide','responseStatus'])$(id).onchange=()=>{page=1;void refresh();};
 $('responseRefresh').onclick=()=>void refresh();$('responsePrev').onclick=()=>{page=Math.max(1,page-1);void refresh();};$('responseNext').onclick=()=>{page=Math.min(Math.max(1,Math.ceil(total/20)),page+1);void refresh();};
 $('responseScheduleEdit').onclick=()=>{
  if(!schedule||!campaign)return;editing={campaign,revision:schedule.revision,saving:false};editError('');$('responseScheduleSave').disabled=false;
  for(const input of $('responseWeekdays').querySelectorAll('input'))input.checked=schedule.weekdays.includes(Number(input.value));
  $('responseScheduleStart').value=schedule.start;$('responseScheduleEnd').value=schedule.end;$('responseScheduleDialog').showModal();
 };
 $('responseScheduleCancel').onclick=()=>{editing=null;$('responseScheduleDialog').close();};$('responseScheduleDialog').addEventListener('cancel',()=>{editing=null;});
 $('responseScheduleForm').onsubmit=async e=>{
  e.preventDefault();if(!editing||editing.saving)return;const current=editing,days=[...$('responseWeekdays').querySelectorAll('input:checked')].map(input=>Number(input.value)),start=$('responseScheduleStart').value,end=$('responseScheduleEnd').value;
  if(!days.length){editError('Выберите хотя бы один рабочий день.');return;}if(!start||!end||start>=end){editError('Начало рабочего дня должно быть раньше окончания.');return;}
  current.saving=true;editError('');$('responseScheduleSave').disabled=true;
  try{await api(`/campaigns/${encodeURIComponent(current.campaign)}/response-schedule`,{weekdays:days,start,end,expected_revision:current.revision},'PATCH');if(campaign===current.campaign){if(editing===current){editing=null;$('responseScheduleDialog').close();}await refresh();}}catch(e){if(campaign===current.campaign&&editing===current)editError(friendly(e,'Не удалось сохранить рабочие часы. Попробуйте ещё раз.'));}finally{if(editing===current){current.saving=false;$('responseScheduleSave').disabled=false;}}
 };
 clear();
 return {refresh,setCampaigns(list){$('responseCampaign').replaceChildren(...list.map(item=>new Option(item.name,item.id)));$('responseCampaign').value=campaign;},async select(id){id=id||'';if(campaign!==id){campaign=id;page=1;generation++;clear();}$('responseCampaign').value=id;$('responseEmpty').hidden=!!id;$('responseContent').hidden=!id;if(id&&location.hash==='#response')await refresh();}};
}
