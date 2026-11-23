import assert from 'node:assert/strict';
import test from 'node:test';
import { telegramSender, telegramSettings, telegramRecipient, telegramSlots } from '../src/services/telegram-profiles.js';
import { createToolHandlers } from '../src/mcp/tool-handlers.js';
import { createConfirmationStore } from '../src/mcp/confirmation-store.js';

test('profile validation keeps identity separate and requires a usable schedule', () => {
  assert.equal(telegramSender('@Example_Account'), 'example_account');
  for (const value of ['../../other','https://t.me/account', '', true]) assert.throws(() => telegramSender(value));
  const settings = { label: 'Рабочий', paused: true, daily_limit: 20, window_start: '16:00', window_end: '18:00' };
  assert.deepEqual(telegramSettings(settings), settings);
  for (const change of [{ daily_limit: 0 }, { daily_limit: 100 }, { window_end: '15:00' }, { window_start: '24:00' }, { paused: 'false' }]) {
    assert.throws(() => telegramSettings({ ...settings, ...change }));
  }
});

test('per-profile random slots fit different windows and preserve two-minute spacing', () => {
  for (const p of [{ daily_limit: 10, window_start:'09:30',window_end:'11:30' }, { daily_limit:20,window_start:'16:00',window_end:'18:00' }]) {
    const slots = telegramSlots('2026-11-23', p);
    assert.equal(slots.length, p.daily_limit);
    assert.ok(slots[0] > new Date(`2026-11-23T${p.window_start}:00+03:00`));
    assert.ok(slots.at(-1) < new Date(`2026-11-23T${p.window_end}:00+03:00`));
    for (let i=1;i<slots.length;i++) assert.ok(slots[i]-slots[i-1]>=120000);
  }
});

test('a numeric identity and documented permission are required', () => {
  const row = { draft_id:'5f801448-abcc-4b67-aa4a-108c8302f30f',recipient_id:'4271',permission_kind:'request',permission_evidence:'Incoming request 48' };
  assert.deepEqual(telegramRecipient(row),row);
  for (const change of [{recipient_id:true},{recipient_id:'@recipient'},{recipient_id:'9223372036854775808'},{permission_kind:'public_profile'},{permission_evidence:' '}]) {
    assert.throws(() => telegramRecipient({...row,...change}));
  }
});

test('MCP passes the selected sender and requires fresh one-use confirmation for settings and delivery', async () => {
  const calls = [];
  const client = { async post(path, input) {
    calls.push({path,input});
    return path.endsWith('/prepare') ? { confirmation_token:'server-token',summary:'Exact plan',preview:{sender:input.sender,jobs:[]}} : {queued:1};
  }};
  const handlers = createToolHandlers({client, confirmations:createConfirmationStore()});
  for (const type of ['settings','launch','resume']) {
    const prefix = type === 'settings' ? 'telegram_profile_settings' : type === 'resume' ? 'telegram_queue_resume' : 'telegram_launch';
    const prepared = await handlers[`${prefix}_prepare`]({sender:'second_account',settings:{},recipients:[]});
    const token = prepared.structuredContent.data.confirmation_token;
    assert.equal(calls.at(-1).path.endsWith('/prepare'),true);
    const failed = await handlers[`${prefix}_execute`]({confirmation_token:token,confirm:false});
    assert.equal(failed.isError,true);
    const fresh = await handlers[`${prefix}_prepare`]({sender:'second_account',settings:{},recipients:[]});
    const freshToken = fresh.structuredContent.data.confirmation_token;
    const sent = await handlers[`${prefix}_execute`]({confirmation_token:freshToken,confirm:true});
    assert.equal(sent.isError,undefined);
    assert.deepEqual(calls.at(-1).input,{confirmation_token:'server-token',confirm:true});
    const replay = await handlers[`${prefix}_execute`]({confirmation_token:freshToken,confirm:true});
    assert.equal(replay.isError,true);
  }
});
