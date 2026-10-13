import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { createTaskStore } from '../src/task-store.js';
import { createTaskRunner, limitInfo } from '../src/task-runner.js';
import { createTaskTools } from '../src/tasks.js';
import { createApprovals, autoAllows } from '../src/approvals.js';

let root;
let store;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-tasks-')); store = createTaskStore(root); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const make = (options = {}) => store.create({ provider: 'codex', cwd: root, prompt: '修改文件並驗證', ...options });
const until = async (check) => {
  for (let n = 0; n < 200; n += 1) { if (check()) return; await sleep(10); }
  throw new Error('test condition timed out');
};

test('starts either provider without an existing target session', async () => {
  const woken = [];
  const tools = createTaskTools({ store, defaultCwd: root, wake: async (_, id) => woken.push(id) });
  for (const provider of ['codex', 'claude']) {
    const task = await tools.start({ provider, prompt: 'hello' });
    assert.equal(task.status, 'queued');
    assert.deepEqual(task.sessions, {});
    assert.equal((await store.read(task.id)).provider, provider);
  }
  assert.equal(woken.length, 2);
  assert.equal((await tools.list()).length, 2);
});

test('validates task input and path traversal', async () => {
  await assert.rejects(make({ provider: 'other' }), /provider/);
  await assert.rejects(make({ fallback: 'codex' }), /fallback/);
  await assert.rejects(make({ cwd: '..' }), /cwd/);
  await assert.rejects(make({ prompt: '' }), /任務/);
  assert.throws(() => store.dir('../secrets'), /task id/);
});

test('only one worker can claim a task, and releasing allows the next one', async () => {
  const task = await make();
  const claims = await Promise.all(Array.from({ length: 10 }, () => store.claim(task.id)));
  assert.equal(claims.filter(Boolean).length, 1);
  await claims.find(Boolean)();
  const next = await store.claim(task.id);
  assert.ok(next);
  await next();
});

for (const provider of ['codex', 'claude']) {
  test(`${provider}: persists progress, awaits approval and completes with a report`, async () => {
    const task = await make({ provider });
    const reports = [];
    const runner = createTaskRunner({ task, store, notify: async (_, text) => reports.push(text), drivers: {
      [provider]: async (_, context) => {
        await context.event({ type: 'session', id: '11111111-1111-4111-8111-111111111111' });
        await context.event({ type: 'text', text: '已讀取檔案' });
        const response = await context.approve({ kind: 'command', details: { command: 'npm test' } });
        assert.equal(response.decision, 'approve');
        return { status: 'completed', output: '完成' };
      },
    } });
    runner.launch();
    await until(() => task.status === 'waiting_approval');
    await runner.save();
    assert.equal((await store.read(task.id)).output, '已讀取檔案');
    const id = task.approvals[0].id;
    await runner.handle({ action: 'approve', approvalId: id });
    await runner.settled();
    assert.equal(task.status, 'completed');
    assert.equal(task.output, '完成');
    assert.ok(reports.some((text) => text.includes('任務完成')));
    assert.match(await fs.readFile(path.join(store.dir(task.id), 'events.jsonl'), 'utf8'), /已讀取檔案/);
    await assert.rejects(runner.handle({ action: 'approve', approvalId: id }), /已結束/);
  });

  test(`${provider}: automode handles current and later requests then clears on completion`, async () => {
    const task = await make({ provider });
    const runner = createTaskRunner({ task, store, drivers: {
      [provider]: async (_, context) => {
        assert.equal((await context.approve({ kind: 'file', details: {} })).decision, 'approve');
        assert.equal((await context.approve({ kind: 'command', details: {} })).decision, 'approve');
        return { status: 'completed' };
      },
    } });
    runner.launch();
    await until(() => task.status === 'waiting_approval');
    await runner.handle({ action: 'auto', enabled: true, minutes: 10 });
    await runner.settled();
    assert.equal(task.status, 'completed');
    assert.equal(task.automode, null);
    assert.deepEqual(task.approvals.map((approval) => approval.actor), ['automode', 'automode']);
  });

  test(`${provider}: cancel revokes approval, stops the run and prevents stale approvals`, async () => {
    const task = await make({ provider });
    const runner = createTaskRunner({ task, store, drivers: {
      [provider]: async (_, context) => {
        const result = await context.approve({ kind: 'command', details: {} }, context.signal);
        assert.equal(result.decision, 'deny');
        return { status: 'completed' };
      },
    } });
    runner.launch();
    await until(() => task.status === 'waiting_approval');
    await runner.handle({ action: 'cancel' });
    await runner.settled();
    assert.equal(task.status, 'cancelled');
    assert.equal(task.automode, null);
    await assert.rejects(runner.handle({ action: 'approve', approvalId: task.approvals[0].id }), /已結束/);
  });

  test(`${provider}: unknown quota reset pauses without guessing or repeated retries`, async () => {
    const task = await make({ provider });
    let calls = 0;
    const runner = createTaskRunner({ task, store, drivers: {
      [provider]: async () => { calls += 1; return { status: 'failed', error: { message: 'Usage limit exceeded', codexErrorInfo: 'UsageLimitExceeded' } }; },
    } });
    runner.launch();
    await runner.settled();
    await runner.tick();
    assert.equal(task.status, 'waiting_quota');
    assert.equal(task.nextRetryAt, null);
    assert.equal(calls, 1);
  });

  test(`${provider}: explicit fallback carries checkpoints to the other provider once`, async () => {
    const other = provider === 'codex' ? 'claude' : 'codex';
    const task = await make({ provider, fallback: other });
    task.automode = { provider, expiresAt: Date.now() + 10000, kinds: ['command'] };
    const runner = createTaskRunner({ task, store, drivers: {
      [provider]: async (_, context) => {
        await context.event({ type: 'text', text: '已完成第一步' });
        return { status: 'failed', error: { message: 'usage_limit_reached' } };
      },
      [other]: async (current, context) => {
        assert.match(context.prompt, /已完成第一步/);
        assert.match(context.prompt, /不要直接重做/);
        assert.equal(current.automode, null);
        return { status: 'failed', error: { message: 'usage_limit_reached' } };
      },
    } });
    runner.launch();
    await runner.settled();
    assert.equal(task.provider, other);
    assert.equal(task.attempts, 2);
    assert.equal(task.status, 'waiting_quota');
  });
}

test('automode is scoped to provider, kinds and expiry; input and manual-only requests stay manual', () => {
  const policy = { provider: 'codex', expiresAt: 200, kinds: ['command', 'input'] };
  assert.equal(autoAllows(policy, { provider: 'codex', kind: 'command' }, 100), true);
  for (const request of [{ provider: 'claude', kind: 'command' }, { provider: 'codex', kind: 'file' },
    { provider: 'codex', kind: 'input' }, { provider: 'codex', kind: 'command', manualOnly: true }]) {
    assert.equal(autoAllows(policy, request, 100), false);
  }
  assert.equal(autoAllows(policy, { provider: 'codex', kind: 'command' }, 200), false);
});

test('questions need structured answers, expired approvals deny, and cancellation invalidates them', async () => {
  let time = 100;
  const task = await make();
  const approvals = createApprovals({ task, save: async () => {}, now: () => time });
  const response = approvals.request({ kind: 'input', method: 'item/tool/requestUserInput', details: { questions: [{ id: 'q' }] } });
  await until(() => task.approvals.length === 1);
  const id = task.approvals[0].id;
  await assert.rejects(approvals.resolve(id, 'approve'), /answer JSON/);
  await assert.rejects(approvals.resolve(id, 'approve', {}), /answers/);
  const answer = { answers: { q: { answers: ['yes'] } } };
  await approvals.resolve(id, 'approve', answer);
  assert.deepEqual(await response, { decision: 'approve', answer });
  const second = approvals.request({ kind: 'command', details: {} });
  time += 3600001;
  await approvals.tick();
  assert.equal((await second).decision, 'deny');
  assert.equal(task.approvals[1].actor, 'expired');
});

test('bounded automatic retries respect reset time and stop after three retries', async () => {
  let time = 100000;
  const task = await make();
  const runner = createTaskRunner({ task, store, now: () => time, drivers: {
    codex: async () => ({ status: 'failed', error: { message: 'rate_limit' } }),
  } });
  runner.launch();
  await runner.settled();
  for (let i = 0; i < 3; i += 1) {
    assert.ok(task.nextRetryAt > time);
    await runner.tick();
    assert.equal(task.attempts, i + 1);
    time = task.nextRetryAt;
    await runner.tick();
    await runner.settled();
  }
  assert.equal(task.attempts, 4);
  assert.equal(task.nextRetryAt, null);
  assert.equal(task.status, 'waiting_quota');
  assert.deepEqual(limitInfo({ codexErrorInfo: 'UsageLimitExceeded' }, {
    rateLimits: { primary: { usedPercent: 100, resetsAt: 200 }, secondary: { usedPercent: 100, resetsAt: 300 } },
  }, 100000), { resetAt: 300000, transient: false });
});

test('notification failure preserves successful result and can be inspected', async () => {
  const task = await make();
  const runner = createTaskRunner({ task, store, drivers: { codex: async () => ({ status: 'completed', output: 'done' }) },
    notify: async () => { throw new Error('queue unavailable'); } });
  runner.launch();
  await runner.settled();
  assert.equal(task.status, 'completed');
  assert.equal(task.notificationError, 'queue unavailable');
});

test('commands get receipts and expired approval commands cannot turn on automode', async () => {
  const task = await make();
  const commandId = await store.submit(task.id, { action: 'auto', enabled: true });
  const runner = createTaskRunner({ task, store, drivers: {}, now: () => Date.now() + 61000 });
  await runner.tick();
  assert.equal((await store.receipt(task.id, commandId)).ok, false);
  assert.match((await store.receipt(task.id, commandId)).error, /過期/);
  assert.deepEqual(await store.commands(task.id), []);
});

test('resume keeps the native session and rejects concurrent runs', async () => {
  const task = await make();
  let finish;
  const runner = createTaskRunner({ task, store, drivers: { codex: async (current) => {
    assert.equal(current.sessions.codex, 'existing');
    await new Promise((resolve) => { finish = resolve; });
    return { status: 'completed' };
  } } });
  task.sessions.codex = 'existing';
  task.status = 'failed';
  await runner.handle({ action: 'resume' });
  await until(() => Boolean(finish));
  await assert.rejects(runner.handle({ action: 'resume' }), /仍在執行/);
  finish();
  await runner.settled();
});

test('does not replay a control command interrupted after durable claim', async () => {
  const task = await make();
  const commandId = await store.submit(task.id, { action: 'resume' });
  const [command] = await store.commands(task.id);
  await store.beginCommand(task.id, command);
  let ran = false;
  const runner = createTaskRunner({ task, store, drivers: { codex: async () => { ran = true; return { status: 'completed' }; } } });
  await runner.tick();
  assert.equal(ran, false);
  assert.equal((await store.receipt(task.id, commandId)).ok, false);
  assert.match((await store.receipt(task.id, commandId)).error, /處理曾中斷/);
});

test('refuses resume while an orphaned agent PID is still alive', async () => {
  const task = await make();
  task.status = 'interrupted'; task.agentPid = process.pid;
  const runner = createTaskRunner({ task, store, drivers: {} });
  await assert.rejects(runner.handle({ action: 'resume' }), /先前 agent 行程/);
  await assert.rejects(runner.handle({ action: 'cancel' }), /無法確認取消/);
});

test('failed process termination is not reported as successful cancellation', async () => {
  const task = await make();
  const runner = createTaskRunner({ task, store, drivers: { codex: async (_, context) => {
    await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('cannot stop process'), { code: 'STOP_FAILED' });
  } } });
  runner.launch();
  await sleep(20);
  await runner.handle({ action: 'cancel' });
  await runner.settled();
  assert.equal(task.status, 'recovery_required');
});
