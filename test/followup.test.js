import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { saveConfig } from '../src/config.js';
import { runHook } from '../src/hook.js';
import { MESSAGE_ID, createMailbox } from '../src/mailbox.js';
import { openManagedRpc, UserActionRequired } from '../src/managed-rpc.js';
import { permissionApprover } from '../src/managed-task.js';
import { createMessaging, renderMessage } from '../src/messaging.js';
import { readAgyPendingBackground } from '../src/providers/agy.js';
import { createDefaultRegistry } from '../src/providers/registry.js';
import { createTaskStore } from '../src/task-store.js';
import { buildTaskPrompt, createTaskTools } from '../src/tasks.js';
import { createTools } from '../src/tools.js';
import { AGY_ID, CLAUDE_ID, createFixture } from './fixtures.js';

const BG = `${AGY_ID}/task-7`;
const toJsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
const reply = (content) => ({ type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: '2026-11-21T09:00:00Z', content });
const bgStarted = (id) => ({ type: 'GENERIC', source: 'MODEL', content: `Tool is running as a background task with task id: ${id}\nTask Description: gpu.ps1` });
const bgFinished = (id, verb = 'finished') => ({
  type: 'SYSTEM_MESSAGE', source: 'SYSTEM',
  content: `<SYSTEM_MESSAGE> [Message] content=Task id "${id}" ${verb} with result: Command exited with code 0.`,
});

let fixture;
let home;
let workdir;
let transcript;

beforeEach(async () => {
  fixture = createFixture();
  home = fixture.bridgeHome;
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-bridge-cwd-'));
  transcript = path.join(workdir, 'transcript.jsonl');
});

afterEach(async () => {
  fixture.cleanup();
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('agy background tasks', () => {
  test('counts background tasks that have started but not finished, canceled or been reset', async () => {
    await fs.writeFile(transcript, toJsonl([
      bgStarted(`${AGY_ID}/task-1`), bgStarted(`${AGY_ID}/task-2`), bgStarted(`${AGY_ID}/task-3`),
      bgFinished(`${AGY_ID}/task-1`), bgFinished(`${AGY_ID}/task-2`, 'was canceled'),
      reply(`Tool is running as a background task with task id: ${AGY_ID}/task-9`),
    ]));
    assert.equal(await readAgyPendingBackground(transcript), 1);

    await fs.appendFile(transcript, toJsonl([{
      type: 'SYSTEM_MESSAGE', content: 'All background tasks have been stopped due to server restart.',
    }]));
    assert.equal(await readAgyPendingBackground(transcript), 0);
  });
});

describe('terminal task tracks every turn of the session', () => {
  const setup = async () => {
    const store = createTaskStore(home);
    const mailbox = createMailbox(home);
    const registry = createDefaultRegistry({
      claudeRoot: fixture.claudeRoot, agyRoot: fixture.agyRoot, codexRoot: fixture.codexRoot, home,
      env: { ...process.env, SESSION_BRIDGE_AGY: 'agy.exe' },
    });
    const messaging = createMessaging({ mailbox, registry });
    const tasks = createTaskTools({
      store, registry, defaultCwd: workdir, launcher: async () => ({ launcher: 'wt:tab' }),
    });
    const task = await tasks.start({
      provider: 'agy', prompt: '跑 QA', execution_mode: 'terminal', from_source: 'claude', from_id: CLAUDE_ID,
    });
    const env = { ...process.env, SESSION_BRIDGE_TASK_ID: task.id, SESSION_BRIDGE_TASK_RUN_ID: task.runId };
    const hook = (hookEventName) => runHook({
      source: 'agy',
      rawInput: { hookEventName, conversationId: AGY_ID, transcriptPath: transcript },
      env, home, registry, mailbox, taskStore: store, messaging,
    });
    const coordinator = { source: 'claude', id: CLAUDE_ID };
    const inbox = async () => (await mailbox.list(coordinator, 'new')).map(({ text }) => text);
    return { store, mailbox, task, hook, inbox };
  };

  test('waits for background work, then reports the final reply once', async () => {
    const { store, mailbox, task, hook, inbox } = await setup();
    await hook('SessionStart');

    await fs.writeFile(transcript, toJsonl([bgStarted(BG), reply('正在執行 GPU 腳本')]));
    await hook('Stop');
    let current = await store.read(task.id);
    assert.equal(current.status, 'waiting_background');
    assert.equal(current.pendingBackground, 1);
    assert.equal(current.output, '正在執行 GPU 腳本');
    assert.deepEqual(await inbox(), []);

    // 等待期間協調端追加交辦：訊息保持處理中，不轉寄中途回覆
    await mailbox.add({ from: { source: 'claude', id: CLAUDE_ID }, to: { source: 'agy', id: AGY_ID }, text: '跑完記得寫報告' });
    await hook('PreInvocation');
    assert.equal((await store.read(task.id)).status, 'running');
    await fs.appendFile(transcript, toJsonl([reply('收到，等腳本跑完')]));
    await hook('Stop');
    assert.deepEqual(await inbox(), []);
    assert.equal((await mailbox.list({ source: 'agy', id: AGY_ID }, 'active')).length, 1);

    await fs.appendFile(transcript, toJsonl([bgFinished(BG), reply('第四輪報告已寫好')]));
    await hook('PreInvocation');
    await hook('Stop');
    current = await store.read(task.id);
    assert.equal(current.status, 'completed');
    assert.equal(current.pendingBackground, 0);
    assert.equal(current.output, '第四輪報告已寫好');
    const reports = await inbox();
    assert.equal(reports.length, 1);
    assert.match(reports[0], /第四輪報告已寫好/);
  });

  test('reports a later turn that no bridge message triggered', async () => {
    const { store, task, hook, inbox } = await setup();
    await fs.writeFile(transcript, toJsonl([reply('第一回合完成')]));
    await hook('Stop');
    await fs.appendFile(transcript, toJsonl([reply('使用者在分頁追問後的回覆')]));
    await hook('PreInvocation');
    assert.equal((await store.read(task.id)).status, 'running');
    await hook('Stop');

    const reports = await inbox();
    assert.equal(reports.length, 2);
    assert.match(reports[1], /使用者在分頁追問後的回覆/);
    assert.equal((await store.read(task.id)).output, '使用者在分頁追問後的回覆');
  });
});

describe('verification hint wording', () => {
  test('points to read_session without telling the recipient to skip asking the user', () => {
    const from = { source: 'claude', id: CLAUDE_ID };
    const rendered = renderMessage({ id: '1-abcdef12', from, to: { source: 'agy', id: AGY_ID }, text: 'hi' });
    const prompt = buildTaskPrompt({ id: 'x', cwd: 'C:\\w', prompt: 'p', from });
    for (const text of [rendered, prompt]) {
      assert.match(text, /read_session\(source="claude"/);
      assert.doesNotMatch(text, /無需再詢問使用者|直接執行/);
    }
  });

  test('claude wake output says it is a collaboration notice, not an error', () => {
    const registry = createDefaultRegistry({ home });
    const out = registry.get('claude').formatHookOutput({ event: 'Stop', wakeMessages: ['msg'] });
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr.split('\n')[0], /session-bridge.*不是錯誤/);
  });
});

describe('message status', () => {
  test('reports whether the recipient has taken, is handling, or has closed a message', async () => {
    const mailbox = createMailbox(home);
    const tools = createTools({
      claudeRoot: fixture.claudeRoot, agyRoot: fixture.agyRoot, codexRoot: fixture.codexRoot,
      defaultCwd: workdir, mailbox,
    });
    const messaging = createMessaging({ mailbox });
    const to = { source: 'agy', id: AGY_ID };
    const sent = await tools.sendMessage({
      from_source: 'claude', from_id: CLAUDE_ID, to_source: 'agy', to_id: AGY_ID, text: '請回報',
    });
    const messageId = sent.match(/已送出 (\S+) /)[1];
    assert.match(messageId, MESSAGE_ID);
    const status = () => tools.messageStatus({ to_source: 'agy', to_id: AGY_ID, message_id: messageId });

    assert.match(await status(), /尚未讀取/);
    await messaging.takeNew(to);
    assert.match(await status(), /處理中/);
    await messaging.onStop({ ...to, lastMessage: 'ok' });
    assert.match(await status(), /已結案/);
    await assert.rejects(tools.messageStatus({ to_source: 'agy', to_id: AGY_ID, message_id: '1-00000000' }), /找不到/);
  });
});

describe('managed permission auto-approval', () => {
  const permission = (kind) => ({
    sessionId: 's', toolCall: { toolCallId: 't', kind },
    options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
  });

  test('approves only allowed tool kinds, once', () => {
    const approve = permissionApprover(['read', 'edit']);
    assert.equal(approve(permission('read')), 'once');
    assert.equal(approve(permission('execute')), null);
    assert.equal(permissionApprover([])(permission('read')), null);
    assert.equal(permissionApprover(['other'])(undefined), null);
  });

  test('rpc answers an approved permission request without failing the turn', async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const sent = [];
    child.stdin.on('data', (data) => sent.push(JSON.parse(data)));
    const rpc = openManagedRpc({ kind: 'acp' }, { spawnFn: () => child, approve: permissionApprover(['read']) });
    try {
      const pending = rpc.request('session/prompt', {});
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: permission('read') })}\n`);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', id: 3, result: { outcome: { outcome: 'selected', optionId: 'once' } } });
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'session/request_permission', params: permission('execute') })}\n`);
      await assert.rejects(pending, UserActionRequired);
    } finally {
      rpc.close();
      child.emit('close', 0);
    }
  });

  test('task auto_approve is limited to the kinds allowed in config', async () => {
    await saveConfig({ managed: { autoApprove: ['read', 'search'] } }, home);
    const store = createTaskStore(home);
    const registry = createDefaultRegistry({ home, env: { ...process.env, SESSION_BRIDGE_AGY: 'agy.exe' } });
    const tasks = createTaskTools({ store, registry, defaultCwd: workdir, managedLauncher: async () => {} });

    const byConfig = await tasks.start({ provider: 'agy', prompt: 'a' });
    assert.deepEqual(byConfig.autoApprove, ['read', 'search']);
    const narrowed = await tasks.start({ provider: 'agy', prompt: 'b', auto_approve: ['read', 'execute'] });
    assert.deepEqual(narrowed.autoApprove, ['read']);
  });
});
