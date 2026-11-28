const kinds={voice:'Голосовое сообщение',audio:'Аудиофайл',video:'Видео',video_note:'Видеосообщение'};
const states={queued:'Ожидает сохранения',downloading:'Сохраняется на сервере',ready:'Сохранено на сервере',waiting_storage:'Ожидает свободного места',too_large:'Размер превышает лимит архива',failed:'Ошибка сохранения',unavailable:'Файл недоступен'};
const safeUrl=url=>typeof url==='string'&&/^\/api\/cabinet\/campaigns\/[a-f0-9-]{36}\/media\/[a-f0-9-]{36}$/.test(url);
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
export function renderCabinetMessage(message,{at,evidenceIds=[]}={}){
 const card=el('article',undefined,'conversion-message'+(evidenceIds.includes(String(message.telegram_message_id))?' is-evidence':''));
 const header=el('small'),time=el('time',at?at(message.sent_at):message.sent_at||'');if(message.sent_at)time.dateTime=message.sent_at;header.append(document.createTextNode((message.direction==='inbound'?'Клиент':'Вы')+' · '),time);card.append(header);
 if(message.body)card.append(el('p',message.body));
 const media=message.media;
 if(media&&kinds[media.kind]){
  const detail={media_size_unknown:'Размер файла пока не определён',media_storage_unavailable:'Хранилище временно недоступно',telegram_rate_limit:'Загрузка отложена Telegram'}[media.error_code];
  const box=el('div',undefined,'conversation-media'),title=el('strong',kinds[media.kind]),status=el('small',detail||states[media.status]||'Статус сохранения неизвестен');box.append(title,status);
  const bytes=Number(media.size_bytes);if(Number.isFinite(bytes)&&bytes>0)box.append(el('small',bytes>=1048576?(bytes/1048576).toFixed(1)+' МБ':Math.ceil(bytes/1024)+' КБ','conversation-media-size'));
  if(media.status==='ready'&&safeUrl(media.download_url)){
   const player=el(media.kind==='voice'||media.kind==='audio'?'audio':'video');player.controls=true;player.preload='none';player.src=media.download_url;if(player.tagName==='VIDEO')player.setAttribute('playsinline','');player.setAttribute('aria-label',kinds[media.kind]);box.append(player);
   const download=el('a','Скачать файл');download.href=media.download_url+'?download=1';download.setAttribute('download','');box.append(download);
  }
  card.append(box);
 }else if(!message.body)card.append(el('p','Сообщение без текста'));
 if(message.timestamp_source==='service_receipt')card.append(el('small','Время фиксации отправки сервером','conversation-time-note'));
 if(message.media_check_error&&!media)card.append(el('small','Не удалось проверить вложения','conversation-time-note'));
 return card;
}
