"""Scoped private audio/video archive; no inbox scans, session exports or sends."""
import asyncio
import hashlib
import math
import os
from pathlib import Path
import shutil
import stat
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from telethon import errors, types

UTC = timezone.utc
MIMES = {'audio/ogg':'ogg', 'audio/opus':'ogg', 'audio/mpeg':'mp3', 'audio/mp4':'m4a',
         'audio/x-m4a':'m4a', 'audio/wav':'wav', 'audio/x-wav':'wav', 'audio/flac':'flac',
         'audio/webm':'webm', 'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov',
         'application/octet-stream':'bin'}


def extract_media(message):
    document = getattr(getattr(message, 'media', None), 'document', None)
    if not isinstance(document, types.Document):
        return None
    audio = next((a for a in document.attributes if isinstance(a, types.DocumentAttributeAudio)), None)
    video = next((a for a in document.attributes if isinstance(a, types.DocumentAttributeVideo)), None)
    mime = document.mime_type if document.mime_type in MIMES else 'application/octet-stream'
    if audio:
        kind, duration = ('voice' if audio.voice else 'audio'), audio.duration
    elif video:
        kind, duration = ('video_note' if video.round_message else 'video'), video.duration
    elif mime.startswith(('audio/', 'video/')):
        kind, duration = mime.split('/')[0], None
    else:
        return None
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration < 0:
        duration = None
    size = document.size if type(document.size) is int and document.size > 0 else None
    return {'kind': kind, 'mime_type': mime, 'size_bytes': size, 'duration_seconds': duration}


async def enqueue_message(db, job, message):
    """Caller already holds the verified-message transaction; never performs RPCs."""
    info = extract_media(message)
    args = (job['owner_id'], job['id'], job['connection_id'], job['recipient_id'], message.id)
    await db.execute("""UPDATE cabinet_messages SET media_checked_at=now(),media_check_error=NULL,media_check_attempts=0,
        body=CASE WHEN body='' THEN %s ELSE body END
        WHERE owner_id=%s AND job_id=%s AND connection_id=%s AND recipient_id=%s AND telegram_message_id=%s""",
        ((message.message or '')[:16000], *args))
    if info:
        await db.execute("""INSERT INTO cabinet_media(owner_id,job_id,connection_id,recipient_id,telegram_message_id,
            connection_generation,kind,mime_type,size_bytes,duration_seconds)
            SELECT m.owner_id,m.job_id,m.connection_id,m.recipient_id,m.telegram_message_id,c.generation,%s,%s,%s,%s
            FROM cabinet_messages m JOIN cabinet_connections c ON c.id=m.connection_id AND c.owner_id=m.owner_id
            WHERE m.owner_id=%s AND m.job_id=%s AND m.connection_id=%s AND m.recipient_id=%s AND m.telegram_message_id=%s
            ON CONFLICT(connection_id,telegram_message_id) DO NOTHING""",
            (info['kind'],info['mime_type'],info['size_bytes'],info['duration_seconds'], *args))


async def rpc_allowed(db, connection_id):
    row = await (await db.execute("SELECT NOT EXISTS(SELECT 1 FROM cabinet_media_rpc_state WHERE connection_id=%s AND blocked_until>now()) AS allowed", (connection_id,))).fetchone()
    return row['allowed']


async def block_rpc(db, connection_id, seconds):
    until = datetime.now(UTC) + timedelta(seconds=max(1, int(seconds)))
    await db.execute("""INSERT INTO cabinet_media_rpc_state(connection_id,blocked_until) VALUES(%s,%s)
        ON CONFLICT(connection_id) DO UPDATE SET blocked_until=greatest(cabinet_media_rpc_state.blocked_until,EXCLUDED.blocked_until)""", (connection_id,until))


# Every read, lease refresh and finalization uses the same exact imported scope.
SCOPE = """FROM cabinet_messages m
 JOIN cabinet_jobs j ON j.id=m.job_id AND j.owner_id=m.owner_id AND j.connection_id=m.connection_id AND j.recipient_id=m.recipient_id
 JOIN cabinet_connections c ON c.id=m.connection_id AND c.owner_id=m.owner_id
 JOIN cabinet_accounts a ON a.id=m.owner_id
 JOIN cabinet_messages anchor ON anchor.job_id=j.id AND anchor.owner_id=j.owner_id AND anchor.connection_id=j.connection_id
  AND anchor.recipient_id=j.recipient_id AND anchor.telegram_message_id=j.telegram_message_id AND anchor.direction='outbound'
 WHERE c.id=%s AND c.owner_id=%s AND c.generation=%s AND c.status='connected' AND a.active AND j.status='sent'
  AND m.telegram_message_id>=anchor.telegram_message_id"""


class MediaDeferred(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


class MediaArchive:
    def __init__(self, worker, *, root=None, floor_bytes=None, cap_bytes=None):
        self.worker = worker
        self.root = Path(root if root is not None else os.environ.get('CABINET_MEDIA_DIR','/var/lib/cabinet-media'))
        self.floor_bytes = int(floor_bytes if floor_bytes is not None else os.environ.get('CABINET_MEDIA_FREE_FLOOR_BYTES',2*1024**3))
        self.cap_bytes = int(cap_bytes if cap_bytes is not None else os.environ.get('CABINET_MEDIA_MAX_FILE_BYTES',4*1024**3))
        if self.floor_bytes < 0 or self.cap_bytes <= 0:
            raise ValueError('media_storage_config_invalid')

    def directory(self, owner):
        if self.root.is_symlink():
            raise OSError('media_root_symlink')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o2750)
        self.root.chmod(0o2750)
        path = self.root / str(UUID(str(owner)))
        if path.is_symlink():
            raise OSError('media_owner_symlink')
        path.mkdir(exist_ok=True, mode=0o2750)
        path.chmod(0o2750)
        return path

    def free_bytes(self):
        return shutil.disk_usage(self.root).free

    def paths(self, item):
        directory = self.directory(item['owner_id'])
        stem = str(UUID(str(item['id'])))
        final = directory / (stem + '.' + MIMES.get(item['mime_type'],'bin'))
        part = directory / (stem + '.' + str(UUID(str(item['lease_token']))) + '.part')
        return final, part

    async def scope(self, db, row, item=None):
        suffix, args = '', (row['id'],row['owner_id'],row['generation'])
        if item:
            suffix = " AND m.job_id=%s AND m.recipient_id=%s AND m.telegram_message_id=%s"
            args += (item['job_id'],item['recipient_id'],item['telegram_message_id'])
        return await (await db.execute('SELECT m.*,j.address,j.recipient_source '+SCOPE+suffix+' LIMIT 1',args)).fetchone()

    async def lease_valid(self, db, row, item):
        if not await self.scope(db,row,item) or not await rpc_allowed(db,row['id']):
            raise MediaDeferred('queued','media_scope_changed')
        result = await db.execute("""UPDATE cabinet_media SET lease_until=now()+interval '2 minutes',updated_at=now()
            WHERE id=%s AND lease_token=%s AND connection_generation=%s AND status='downloading' AND lease_until>now()""",
            (item['id'],item['lease_token'],row['generation']))
        if result.rowcount != 1:
            raise MediaDeferred('queued','media_lease_lost')

    async def finish(self, db, row, item, final, digest, *, part=None):
        async with db.transaction():
            # Short scope locks cover only rename+metadata commit, never a network wait.
            scoped = await (await db.execute('SELECT m.id '+SCOPE+" AND m.job_id=%s AND m.recipient_id=%s AND m.telegram_message_id=%s FOR SHARE OF c,a,j,m",
                (row['id'],row['owner_id'],row['generation'],item['job_id'],item['recipient_id'],item['telegram_message_id']))).fetchone()
            if not scoped:
                raise MediaDeferred('queued','media_scope_changed')
            locked = await (await db.execute("SELECT id FROM cabinet_media WHERE id=%s AND lease_token=%s AND status='downloading' AND lease_until>now() FOR UPDATE",(item['id'],item['lease_token']))).fetchone()
            if not locked:
                raise MediaDeferred('queued','media_lease_lost')
            if part is not None:
                os.replace(part,final)
                directory_fd=os.open(final.parent,os.O_RDONLY|os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            await db.execute("""UPDATE cabinet_media SET status='ready',storage_key=%s,sha256=%s,stored_bytes=size_bytes,
                error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=%s AND lease_token=%s""",
                (str(final.relative_to(self.root)),digest,item['id'],item['lease_token']))

    async def defer(self, db, item, status, code, *, failed_attempt=False, seconds=300):
        attempts = item['attempts'] + int(failed_attempt)
        if failed_attempt and attempts >= 5:
            status = 'failed'
        await db.execute("""UPDATE cabinet_media SET status=%s,error_code=%s,attempts=%s,stored_bytes=0,
            next_attempt_at=now()+(%s*interval '1 second'),lease_token=NULL,lease_until=NULL,updated_at=now()
            WHERE id=%s AND lease_token=%s AND status='downloading'""",
            (status,code,attempts,seconds,item['id'],item['lease_token']))

    def cleanup_part(self, item):
        if not item.get('lease_token'):
            return
        _, path = self.paths(item)
        # Never glob/unlink arbitrary files, follow links or delete ready media.
        try:
            if stat.S_ISREG(path.lstat().st_mode):
                path.unlink()
        except FileNotFoundError:
            pass

    async def run_once(self, row, client):
        async with await self.worker.db() as db:
            lock = await (await db.execute("SELECT pg_try_advisory_lock(hashtext('cabinet-media-download')) AS acquired")).fetchone()
            if not lock['acquired']:
                return False
            try:
                if not await rpc_allowed(db,row['id']) or not await self.scope(db,row):
                    return False
                async with db.transaction():
                    item = await (await db.execute("""SELECT * FROM cabinet_media WHERE connection_id=%s AND owner_id=%s
                        AND ((status IN ('queued','waiting_storage') AND next_attempt_at<=now())
                            OR (status='downloading' AND lease_until<=now()))
                        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED""",(row['id'],row['owner_id']))).fetchone()
                    if not item:
                        return False
                    old = dict(item)
                    item = await (await db.execute("""UPDATE cabinet_media SET status='downloading',connection_generation=%s,
                        lease_token=%s,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=%s RETURNING *""",
                        (row['generation'],uuid4(),item['id']))).fetchone()
                try:
                    self.cleanup_part(old)
                except OSError:
                    await self.defer(db,item,'waiting_storage','media_storage_unavailable')
                    return True
                await self.download(db,row,client,item)
                return True
            finally:
                await db.execute("SELECT pg_advisory_unlock(hashtext('cabinet-media-download'))")

    async def download(self, db, row, client, item):
        part, stream = None, None
        try:
            final, part = self.paths(item)
            size = item['size_bytes']
            if size is None:
                raise MediaDeferred('waiting_storage','media_size_unknown')
            if size > self.cap_bytes:
                raise MediaDeferred('too_large','media_too_large')
            await self.lease_valid(db,row,item)
            # An earlier process can crash after atomic rename but before its DB commit.
            if final.exists() or final.is_symlink():
                fd = os.open(final,os.O_RDONLY|os.O_NOFOLLOW)
                with os.fdopen(fd,'rb') as existing:
                    if not stat.S_ISREG(os.fstat(existing.fileno()).st_mode) or os.fstat(existing.fileno()).st_size != size:
                        raise MediaDeferred('failed','media_storage_conflict')
                    digest = hashlib.sha256()
                    while True:
                        chunk = existing.read(512*1024)
                        if not chunk: break
                        digest.update(chunk)
                await self.finish(db,row,item,final,digest.hexdigest())
                return
            if self.free_bytes() - size < self.floor_bytes:
                raise MediaDeferred('waiting_storage','media_storage_low')
            peer = await asyncio.wait_for(client.get_input_entity(types.PeerUser(item['recipient_id'])),25)
            if not isinstance(peer,(types.InputPeerUser,types.InputPeerUserFromMessage)) or peer.user_id != item['recipient_id']:
                raise MediaDeferred('unavailable','media_peer_mismatch')
            await self.lease_valid(db,row,item)
            message = await asyncio.wait_for(client.get_messages(peer,ids=item['telegram_message_id']),25)
            if not self.valid_message(message,item):
                raise MediaDeferred('unavailable','media_message_unavailable')
            info = extract_media(message)
            if not info or any(info[key] != item[key] for key in ('kind','mime_type','size_bytes')):
                raise MediaDeferred('unavailable','media_document_changed')
            await self.lease_valid(db,row,item)
            digest, stored = hashlib.sha256(), 0
            fd = os.open(part,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
            with os.fdopen(fd,'wb') as output:
                os.fchmod(output.fileno(),0o640)
                stream = client.iter_download(message.media,request_size=512*1024,file_size=size)
                iterator = stream.__aiter__()
                while True:
                    await self.lease_valid(db,row,item)
                    if self.free_bytes() - (size-stored) < self.floor_bytes:
                        raise MediaDeferred('waiting_storage','media_storage_low')
                    try:
                        chunk = await asyncio.wait_for(iterator.__anext__(),35)
                    except StopAsyncIteration:
                        break
                    if stored+len(chunk)>size or stored+len(chunk)>self.cap_bytes:
                        raise MediaDeferred('failed','media_size_mismatch')
                    # Other disk writers can consume space while this RPC was in flight.
                    if self.free_bytes()-len(chunk)<self.floor_bytes:
                        raise MediaDeferred('waiting_storage','media_storage_low')
                    output.write(chunk)
                    digest.update(chunk); stored += len(chunk)
                    await db.execute('UPDATE cabinet_media SET stored_bytes=%s,updated_at=now() WHERE id=%s AND lease_token=%s',(stored,item['id'],item['lease_token']))
                if stored != size:
                    raise MediaDeferred('queued','media_size_mismatch')
                output.flush();os.fsync(output.fileno())
            await self.lease_valid(db,row,item)
            # Scope locks cover rename+commit only. Restart reconciles a rename whose DB commit failed.
            await self.finish(db,row,item,final,digest.hexdigest(),part=part)
        except MediaDeferred as exc:
            await self.defer(db,item,exc.status,exc.code,failed_attempt=exc.code=='media_size_mismatch',seconds=300)
        except errors.FloodWaitError as exc:
            await block_rpc(db,row['id'],exc.seconds)
            await self.defer(db,item,'queued','telegram_rate_limit',seconds=exc.seconds)
        except errors.PeerFloodError:
            await block_rpc(db,row['id'],3600)
            await self.defer(db,item,'queued','telegram_rate_limit',seconds=3600)
        except (errors.MessageIdInvalidError,errors.MsgIdInvalidError,errors.UserIdInvalidError,errors.ChannelPrivateError):
            await self.defer(db,item,'unavailable','media_message_unavailable')
        except OSError as exc:
            storage = exc.errno in (28,122,13,30)
            await self.defer(db,item,'waiting_storage' if storage else 'queued',
                'media_storage_unavailable' if storage else 'media_network_error',failed_attempt=not storage,
                seconds=min(3600,30*2**item['attempts']))
        except (asyncio.TimeoutError,errors.RPCError,ValueError):
            await self.defer(db,item,'queued','media_network_error',failed_attempt=True,seconds=min(3600,30*2**item['attempts']))
        except Exception:
            await self.defer(db,item,'failed','media_internal_error',failed_attempt=True)
        finally:
            if stream:
                close = getattr(stream,'close',None) or getattr(stream,'aclose',None)
                if close:
                    try: await close()
                    except Exception: pass
            if part:
                self.cleanup_part(item)

    @staticmethod
    def valid_message(message, item):
        return (isinstance(message,types.Message) and message.id==item['telegram_message_id']
            and isinstance(message.peer_id,types.PeerUser) and message.peer_id.user_id==item['recipient_id']
            and (message.out or message.from_id is None or isinstance(message.from_id,types.PeerUser) and message.from_id.user_id==item['recipient_id']))

    async def discover_once(self, row, client):
        """One bounded exact-ID batch for a single already imported private recipient."""
        async with await self.worker.db() as db:
            if not await rpc_allowed(db,row['id']): return False
            pending = await (await db.execute('SELECT m.*,j.address,j.recipient_source '+SCOPE+
                " AND m.media_checked_at IS NULL AND m.media_check_attempts<5 AND m.media_check_next_attempt_at<=now() ORDER BY m.recipient_id,m.telegram_message_id LIMIT 20",
                (row['id'],row['owner_id'],row['generation']))).fetchall()
            if not pending: return False
            pending = [item for item in pending if item['recipient_id']==pending[0]['recipient_id']]
            try:
                peer=await asyncio.wait_for(client.get_input_entity(types.PeerUser(pending[0]['recipient_id'])),25)
                if not isinstance(peer,(types.InputPeerUser,types.InputPeerUserFromMessage)) or peer.user_id!=pending[0]['recipient_id']:
                    raise ValueError('media_peer_mismatch')
                if not await self.scope(db,row,pending[0]) or not await rpc_allowed(db,row['id']): return False
                messages=await asyncio.wait_for(client.get_messages(peer,ids=[item['telegram_message_id'] for item in pending]),25)
                async with db.transaction():
                    for item in pending:
                        if not await self.scope(db,row,item): continue
                        message=next((msg for msg in messages if self.valid_message(msg,item)),None)
                        if message:
                            await enqueue_message(db,{'id':item['job_id'],**{k:item[k] for k in ('owner_id','connection_id','recipient_id')}},message)
                        else:
                            await db.execute("UPDATE cabinet_messages SET media_checked_at=now(),media_check_error='media_message_unavailable' WHERE id=%s",(item['id'],))
                return True
            except (errors.FloodWaitError,errors.PeerFloodError) as exc:
                await block_rpc(db,row['id'],getattr(exc,'seconds',3600))
            except (OSError,asyncio.TimeoutError,errors.RPCError,ValueError):
                # Retry discovery later; never invent that an unknown empty body is audio.
                await db.execute("""UPDATE cabinet_messages SET
                    media_check_error=CASE WHEN media_check_attempts>=4 THEN 'media_discovery_failed' ELSE 'media_discovery_deferred' END,
                    media_check_attempts=media_check_attempts+1,
                    media_check_next_attempt_at=now()+(least(3600,30*power(2,media_check_attempts))*interval '1 second')
                    WHERE id=ANY(%s)""",([item['id'] for item in pending],))
            return False

    async def run(self, row, client):
        next_discovery = 0
        while True:
            try:
                await self.run_once(row,client)
                now=asyncio.get_running_loop().time()
                if now>=next_discovery:
                    await self.discover_once(row,client)
                    next_discovery=now+30
            except asyncio.CancelledError:
                raise
            except Exception:
                # Archive failure must never cancel jobs, pause campaigns or break live updates.
                pass
            await asyncio.sleep(3)
