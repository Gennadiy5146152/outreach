const $=id=>document.getElementById(id);
function el(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
const dayLabel=day=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(day+'T00:00:00Z'));
export function createCabinetFollowUps({api,at,onCampaignChange}){
 let campaign='',page=1,total=0,generation=0,loading=false,queued=false,editing=null;
 function error(text){$('followUpError').hidden=!text;$('followUpError').textContent=text||'';}
 function clear(){total=0;editing=null;$('followUpRows').replaceChildren();$('followUpCounts').replaceChildren();$('followUpPage').textContent='';$('followUpPrev').disabled=true;$('followUpNext').disabled=true;for(const id of ['followUpDateDialog','followUpThreadDialog'])if($(id).open)$(id).close();error('');}
 async function showThread(row){
  const id=campaign,messages=[];
  try{
   for(const job of row.job_ids){for(let p=1;p<=20;p++){const block=await api(`/campaigns/${id}/threads/${job}?page=${p}`);messages.push(...block);if(block.length<500)break;if(p===20)throw new Error('Не удалось прочитать диалог целиком.');}}
   if(id!==campaign||location.hash!=='#followups')return;
   $('followUpThreadTitle').textContent=row.name||row.address;$('followUpThreadMessages').replaceChildren();
   messages.sort((a,b)=>BigInt(a.telegram_message_id)<BigInt(b.telegram_message_id)?-1:1);
   for(const m of messages){const card=el('article',undefined,'conversion-message');card.append(el('small',(m.direction==='inbound'?'Получатель':'Вы')+' · '+at(m.sent_at)),el('p',m.body||'Сообщение без текста'));$('followUpThreadMessages').append(card);}
   $('followUpThreadDialog').showModal();
  }catch(e){if(id===campaign)error(e.message);}
 }
 function edit(row){editing={row,campaign,saving:false};$('followUpDateForm').querySelector('[type=submit]').disabled=false;$('followUpDatePerson').textContent=row.name||row.address;$('followUpDateInput').value=row.follow_up_on||'';$('followUpNote').value=row.follow_up_note||'';$('followUpEditError').hidden=true;$('followUpDateDialog').showModal();}
 function render(list,currentPage){
  total=list.total;$('followUpCounts').replaceChildren(...[['Всего',list.totals.total,'all'],['Нужно назначить',list.totals.undated,'undated'],['Пора вернуться',list.totals.due,'due'],['Запланировано',list.totals.upcoming,'upcoming']].map(([label,count,view])=>{
   const button=el('button',undefined,'followup-count'+($('followUpView').value===view?' is-active':''));button.type='button';button.append(el('span',label),el('strong',String(count)));button.onclick=()=>{$('followUpView').value=view;page=1;void refresh();};return button;
  }));
  const table=el('table',undefined,'dashboard-dialog-table followup-table'),head=el('thead'),tr=el('tr');for(const title of ['Контакт','Почему вернуться','Дата разбора',''])tr.append(el('th',title));head.append(tr);table.append(head);const body=el('tbody');
  for(const row of list.items){
   const tr=el('tr'),person=el('td'),identity=row.address.startsWith('https://t.me/')?'@'+row.address.split('/').at(-1):'Без username';person.append(el('strong',row.name||identity),el('small',identity));
   if(row.group_username){const label='@'+row.group_username;if(/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/[0-9]+$/.test(row.source_url)){const link=el('a',label,'followup-source');link.href=row.source_url;link.target='_blank';link.rel='noopener noreferrer';person.append(link);}else person.append(el('small',label));}
   const reason=el('td');reason.append(el('p',row.reason||'Клиент отложил решение','followup-reason'));if(row.follow_up_note)reason.append(el('small',row.follow_up_note,'followup-note'));if(row.stale)reason.append(el('span','Есть новые сообщения','stage-chip status-needs_review'));
   const date=el('td');if(!row.follow_up_on)date.append(el('span','Нужно назначить','stage-chip status-needs_review'));else{date.append(el('strong',dayLabel(row.follow_up_on)));date.append(el('small',row.follow_up_on<=list.today?'Пора вернуться':'Назначено вручную',row.follow_up_on<=list.today?'followup-due':''));}
   const actions=el('td'),view=el('button','Переписка','dashboard-table-action followup-thread-action'),schedule=el('button',row.follow_up_on?'Изменить дату':'Назначить дату','dashboard-table-action followup-date-action');view.type=schedule.type='button';view.onclick=()=>void showThread(row);schedule.onclick=()=>edit(row);actions.append(view,schedule);tr.append(person,reason,date,actions);body.append(tr);
  }
  if(!list.items.length){const tr=el('tr'),cell=el('td',list.totals.total?'В этом списке пока нет контактов.':'Отложенные обращения появятся здесь после разбора ответов.','dashboard-table-empty');cell.colSpan=4;tr.append(cell);body.append(tr);}table.append(body);$('followUpRows').replaceChildren(table);
  $('followUpPage').textContent=total?`${(currentPage-1)*20+1}–${Math.min(currentPage*20,total)} из ${total} контактов`:'Нет контактов';$('followUpPrev').disabled=currentPage<=1;$('followUpNext').disabled=currentPage*20>=total;
 }
 async function refresh(){
  if(!campaign)return;if(loading){queued=true;generation++;return;}loading=true;const request=++generation,id=campaign,currentPage=page,view=$('followUpView').value;$('followUpRefresh').disabled=true;
  try{const q=new URLSearchParams({view,page:String(currentPage),page_size:'20'}),list=await api(`/campaigns/${id}/followups?${q}`);if(request!==generation||id!==campaign)return;error('');render(list,currentPage);}catch(e){if(request===generation&&id===campaign)error(e.message);}finally{loading=false;$('followUpRefresh').disabled=false;if(queued){queued=false;void refresh();}}
 }
 $('followUpCampaign').onchange=()=>void onCampaignChange?.($('followUpCampaign').value);
 $('followUpView').onchange=()=>{page=1;void refresh();};$('followUpRefresh').onclick=()=>void refresh();$('followUpPrev').onclick=()=>{page=Math.max(1,page-1);void refresh();};$('followUpNext').onclick=()=>{page=Math.min(Math.max(1,Math.ceil(total/20)),page+1);void refresh();};
 $('followUpDateCancel').onclick=()=>{$('followUpDateDialog').close();editing=null;};$('followUpThreadClose').onclick=()=>$('followUpThreadDialog').close();
 $('followUpDateForm').onsubmit=async e=>{
  e.preventDefault();if(!editing||editing.saving)return;const editRequest=editing,{row,campaign:id}=editRequest,button=e.submitter||$('followUpDateForm').querySelector('[type=submit]');editRequest.saving=true;button.disabled=true;
  try{await api(`/campaigns/${id}/followups/${row.job_id}`,{follow_up_on:$('followUpDateInput').value||null,follow_up_note:$('followUpNote').value,expected_snapshot:row.snapshot},'PATCH');if(campaign===id){if(editing===editRequest){$('followUpDateDialog').close();editing=null;}await refresh();}}catch(error){if(campaign===id&&editing===editRequest){$('followUpEditError').textContent=error.message;$('followUpEditError').hidden=false;}}finally{if(editing===editRequest){editRequest.saving=false;button.disabled=false;}}
 };
 setInterval(()=>{if(!document.hidden&&location.hash==='#followups'&&!$('followUpDateDialog').open&&!$('followUpThreadDialog').open)void refresh();},30000);
 return {refresh,setCampaigns(list){$('followUpCampaign').replaceChildren(...list.map(c=>{const option=el('option',c.name);option.value=c.id;return option;}));},async select(id){if(campaign!==id){campaign=id;page=1;generation++;clear();}$('followUpCampaign').value=id;$('followUpEmpty').hidden=!!id;$('followUpContent').hidden=!id;if(id&&location.hash==='#followups')await refresh();}};
}
