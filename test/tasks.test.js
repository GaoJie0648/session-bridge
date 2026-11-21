import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { pruneStorage } from '../src/cleanup.js';
import { runCli } from '../src/cli.js';
import { saveConfig } from '../src/config.js';
import { runHook } from '../src/hook.js';
import { createMailbox } from '../src/mailbox.js';
import { openManagedRpc, UserActionRequired } from '../src/managed-rpc.js';
import { launchManaged, runManagedTask } from '../src/managed-task.js';
import { createMessaging } from '../src/messaging.js';
import { createDefaultRegistry } from '../src/providers/registry.js';
import { createTaskStore } from '../src/task-store.js';
import { createTaskTools } from '../src/tasks.js';
import { buildTerminalCommand } from '../src/terminal.js';
import { createUsageTools } from '../src/usage.js';
import { AGY_ID, CLAUDE_ID, CODEX_ID, createFixture } from './fixtures.js';

let fixture;
let home;
let workdir;

beforeEach(async () => {
  fixture = createFixture();
  home = fixture.bridgeHome;
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-bridge-cwd-'));
});

afterEach(async () => {
  fixture.cleanup();
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('terminal launcher commands', () => {
  test('uses Windows Terminal tab, split, and window modes when wt is available', () => {
    const base = { scriptPath: 'C:\\tmp\\launch.ps1', cwd: 'C:\\work', title: 'bridge:claude', wtPath: 'C:\\wt.exe', shellPath: 'pwsh.exe', platform: 'win32' };

    const tab = buildTerminalCommand({ ...base, mode: 'tab' });
    assert.equal(tab.launcher, 'wt:tab');
    assert.deepEqual(tab.args.slice(0, 3), ['-w', '0', 'new-tab']);

    const split = buildTerminalCommand({ ...base, mode: 'split', splitDirection: 'vertical' });
    assert.equal(split.launcher, 'wt:split');
    assert.ok(split.args.includes('split-pane'));
    assert.ok(split.args.includes('-V'));

    const win = buildTerminalCommand({ ...base, mode: 'window' });
    assert.equal(win.launcher, 'wt:window');
    assert.equal(win.args[0], 'new-tab');
  });

  test('falls back to cmd start when wt is not installed on Windows', () => {
    const spec = buildTerminalCommand({
      scriptPath: 'C:\\tmp\\launch.ps1',
      cwd: 'C:\\work',
      title: 'bridge:codex',
      wtPath: null,
      shellPath: 'powershell.exe',
      platform: 'win32',
    });

    assert.equal(spec.launcher, 'cmd:start');
    assert.equal(spec.command, 'cmd.exe');
    assert.ok(spec.args.includes('start'));
  });
});

describe('foreground task dispatch, model/effort, and hook lifecycle', () => {
  test('dispatches tasks with model/effort overrides and config defaults across all 3 providers', async () => {
    await saveConfig({
      terminal: { mode: 'split', splitDirection: 'horizontal' },
      defaults: {
        claude: { model: 'claude-sonnet-4-6', effort: 'medium' },
        codex: { model: 'gpt-5.4', effort: 'high' },
        agy: { model: 'gemini-4-neon', effort: 'high' },
      },
    }, home);

    const launched = [];
    const store = createTaskStore(home);
    const registry = createDefaultRegistry({
      codexRoot: fixture.codexRoot,
      claudeRoot: fixture.claudeRoot,
      agyRoot: fixture.agyRoot,
      home,
      env: {
        ...process.env,
        SESSION_BRIDGE_CLAUDE: 'claude.exe',
        SESSION_BRIDGE_CODEX: 'codex.exe',
        SESSION_BRIDGE_AGY: 'agy.exe',
      },
    });
    const tasks = createTaskTools({
      store,
      registry,
      defaultCwd: workdir,
      launcher: async (opts) => {
        launched.push(opts);
        return { launcher: `wt:${opts.mode}`, pid: 1234 };
      },
    });
    registry.get('claude').workspaceTrust = async () => false;

    const claudeTask = await tasks.start({
      provider: 'claude',
      cwd: workdir,
      prompt: '檢查 auth 模組',
      model: 'claude-opus-4-6',
      effort: 'max',
      from_source: 'agy',
      from_id: AGY_ID,
    });
    assert.equal(claudeTask.model, 'claude-opus-4-6');
    assert.equal(claudeTask.effort, 'max');
    assert.equal(claudeTask.launcher, 'wt:split');
    assert.equal(claudeTask.status, 'waiting_for_workspace_trust');
    assert.match(claudeTask.startupHint, /Accessing workspace/);
    assert.deepEqual(launched[0].args, ['--model', 'claude-opus-4-6', '--effort', 'max']);
    assert.match(launched[0].prompt, /read_session\(source="agy"/);

    const codexTask = await tasks.start({
      provider: 'codex',
      cwd: workdir,
      prompt: '補上測試',
      terminal_mode: 'tab',
    });
    assert.equal(codexTask.model, 'gpt-5.4');
    assert.equal(codexTask.effort, 'high');
    assert.ok(launched[1].args.includes('-m'));
    assert.ok(launched[1].args.includes('gpt-5.4'));
    assert.ok(launched[1].args.includes('model_reasoning_effort="high"'));

    const agyTask = await tasks.start({
      provider: 'agy',
      cwd: workdir,
      prompt: '整理架構',
      execution_mode: 'terminal',
    });
    assert.equal(agyTask.provider, 'agy');
    assert.equal(launched[2].promptFlag, '-i');
    assert.deepEqual(launched[2].args, ['--model', 'gemini-4-neon', '--effort', 'high']);

    // 模擬目標終端觸發 SessionStart 與 Stop hook，回寫 session、結果、用量並通知發起端
    const mailbox = createMailbox(home);
    const messaging = createMessaging({ mailbox, registry });
    await runHook({
      source: 'claude',
      rawInput: { hook_event_name: 'SessionStart', session_id: CLAUDE_ID, cwd: workdir },
      env: { ...process.env, SESSION_BRIDGE_TASK_ID: claudeTask.id, SESSION_BRIDGE_TASK_RUN_ID: claudeTask.runId },
      home,
      registry,
      mailbox,
      taskStore: store,
      messaging,
    });
    assert.equal((await store.read(claudeTask.id)).status, 'running');
    assert.equal((await store.read(claudeTask.id)).sessions.claude, CLAUDE_ID);

    await runHook({
      source: 'claude',
      rawInput: {
        hook_event_name: 'Stop',
        session_id: CLAUDE_ID,
        transcript_path: fixture.claudeFile,
        last_assistant_message: 'auth 模組檢查完成，無異常。',
      },
      env: { ...process.env, SESSION_BRIDGE_TASK_ID: claudeTask.id, SESSION_BRIDGE_TASK_RUN_ID: claudeTask.runId },
      home,
      registry,
      mailbox,
      taskStore: store,
      messaging,
      isAbandoned: () => true,
    });

    const finished = await store.read(claudeTask.id);
    assert.equal(finished.status, 'completed');
    assert.match(finished.output, /auth 模組檢查完成/);
    assert.equal(finished.usage.inputTokens, 700);

    // 發起端 agy 信箱應收到自動完成回報
    const reports = await messaging.takeNew({ source: 'agy', id: AGY_ID });
    assert.equal(reports.length, 1);
    assert.match(reports[0], /auth 模組檢查完成/);

    // 測試 resume_task（沿用原原生 session id 並調整 effort）
    await tasks.resume({ id: claudeTask.id, effort: 'low', prompt: '補跑一次 lint' });
    assert.ok(launched[3].args.includes('--resume'));
    assert.ok(launched[3].args.includes(CLAUDE_ID));
    assert.ok(launched[3].args.includes('low'));
  });
});

describe('managed task lifecycle', () => {
  for (const [provider, sessionId] of [['agy', AGY_ID], ['codex', CODEX_ID]]) {
    test(`${provider} uses native session ID for cold start, completion and resume`, async () => {
      const store = createTaskStore(home);
      const registry = createDefaultRegistry({ home, env: {
        ...process.env, SESSION_BRIDGE_CODEX: 'codex.exe', SESSION_BRIDGE_AGY: 'agy.exe',
      } });
      const requests = [];
      const prompts = [];
      const fakeRpc = () => {
        let listener;
        let completed;
        return {
          notify() {},
          close() {},
          onNotification(fn) { listener = fn; },
          waitFor() { return new Promise((resolve) => { completed = resolve; }); },
          async request(method, params) {
            requests.push({ method, params });
            if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
            if (method.startsWith('thread/')) return { thread: { id: sessionId } };
            if (method === 'session/load' || method === 'session/new') return { sessionId };
            const prompt = params.input?.[0]?.text ?? params.prompt?.[0]?.text;
            prompts.push(prompt);
            if (method === 'session/prompt') {
              if (prompt === 'needs approval') throw new UserActionRequired('Native tool approval required');
              listener('session/update', { sessionId, update: {
                sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'finished' },
              } });
              return { stopReason: 'end_turn' };
            }
            queueMicrotask(() => {
              listener('item/completed', { threadId: sessionId, item: { type: 'agentMessage', text: 'finished' } });
              completed({ threadId: sessionId, turn: { id: 'turn-1', status: 'completed' } });
            });
            return { turn: { id: 'turn-1' } };
          },
        };
      };
      const tasks = createTaskTools({
        store, registry, defaultCwd: workdir,
        launcher: () => assert.fail('managed tasks must not open a terminal'),
        managedLauncher: async (options) => {
          await launchManaged({ ...options, spawnFn: (executable, args, launchOptions) => {
            assert.equal(launchOptions.windowsHide, true);
            assert.equal(launchOptions.detached, true);
            const child = new EventEmitter();
            child.unref = () => {};
            queueMicrotask(() => child.emit('spawn'));
            return child;
          } });
          await runManagedTask({ id: options.task.id, runId: options.task.runId, store, registry, connect: fakeRpc });
        },
      });

      const first = await tasks.start({ provider, prompt: 'first', from_source: 'claude', from_id: CLAUDE_ID });
      assert.equal(first.status, 'completed');
      assert.equal(first.launcher, `managed:${provider}`);
      assert.equal(first.sessions[provider], sessionId);
      assert.equal(first.output, 'finished');
      const second = await tasks.resume({ id: first.id, prompt: 'second' });
      assert.equal(second.status, 'completed');
      assert.equal(second.sessions[provider], sessionId);
      assert.match(prompts[0], /first$/);
      assert.equal(prompts[1], 'second');
      const load = requests.find(({ method }) => ['thread/resume', 'session/load'].includes(method));
      assert.equal(load.params.sessionId ?? load.params.threadId, sessionId);
      const mailbox = createMailbox(home);
      const reports = await mailbox.list({ source: 'claude', id: CLAUDE_ID }, 'new');
      assert.equal(reports.length, 2);
      assert.ok(reports.every(({ text }) => text.endsWith('finished')));
      if (provider === 'agy') {
        const blocked = await tasks.resume({ id: first.id, prompt: 'needs approval' });
        assert.equal(blocked.status, 'needs_user_action');
        assert.equal(blocked.sessions.agy, sessionId);
        assert.match(blocked.error, /Native tool approval/);
      }
    });
  }

  test('cancels a native ACP approval request and signals that the user is required', async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const sent = [];
    child.stdin.on('data', (data) => sent.push(JSON.parse(data)));
    const rpc = openManagedRpc({ kind: 'acp' }, { spawnFn: () => child });
    try {
      const pending = rpc.request('session/prompt', {});
      child.stdout.write('{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}}\n');
      await assert.rejects(pending, UserActionRequired);
      assert.deepEqual(sent.at(-1), { jsonrpc: '2.0', id: 9, result: { outcome: { outcome: 'cancelled' } } });
    } finally {
      rpc.close();
      child.emit('close', 0);
    }
  });
});

describe('usage summary and storage cleanup', () => {
  test('aggregates recent usage across codex, claude, and agy', async () => {
    const store = createTaskStore(home);
    const registry = createDefaultRegistry({
      codexRoot: fixture.codexRoot,
      claudeRoot: fixture.claudeRoot,
      agyRoot: fixture.agyRoot,
      home,
      deliverToCodex: async () => {},
    });
    const usage = createUsageTools({ registry, taskStore: store });

    const single = await usage.getUsage({ source: 'agy', id: AGY_ID });
    assert.equal(single.usage.inputTokens, 1400);
    assert.equal(single.usage.model, 'gemini-4-neon-medium');

    const codexSingle = await usage.getUsage({ source: 'codex', id: CODEX_ID });
    assert.equal(codexSingle.usage.rateLimits.primary.used_percent, 12);
  });

  test('prunes expired tasks, old done messages, and stale empty mailbox directories', async () => {
    const store = createTaskStore(home);
    const oldTask = await store.create({
      provider: 'claude',
      cwd: workdir,
      prompt: 'old task',
      validProviders: ['claude', 'codex', 'agy'],
    });
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await store.write({ ...oldTask, updatedAt: oldDate });

    const mailbox = createMailbox(home);
    const staleAddr = { source: 'claude', id: CLAUDE_ID };
    await mailbox.claimWaiter(staleAddr);
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(home, `claude-${CLAUDE_ID}`, 'waiter'), oldTime, oldTime);

    const stats = await pruneStorage({ home, tasksDays: 14, doneMessagesDays: 7 });
    assert.equal(stats.tasksRemoved, 1);
    assert.equal(stats.mailboxesRemoved, 1);
  });

  test('cli init registers both MCP server and hooks for agy into isolated config dir', async () => {
    const geminiConfigDir = path.join(workdir, 'gemini-config');
    const output = await runCli(['init', '--providers', 'agy', '--json'], {
      home,
      env: { ...process.env, GEMINI_CONFIG_DIR: geminiConfigDir },
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].errors.length, 0);

    const mcpConfig = JSON.parse(await fs.readFile(path.join(geminiConfigDir, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpConfig.mcpServers['session-bridge'].command, 'node');
    assert.match(mcpConfig.mcpServers['session-bridge'].args[0], /src\/server\.js$/);

    const hooksConfig = JSON.parse(await fs.readFile(path.join(geminiConfigDir, 'hooks.json'), 'utf8'));
    assert.equal(hooksConfig['session-bridge'].enabled, true);
    assert.ok(Array.isArray(hooksConfig['session-bridge'].PreInvocation));
  });

  test('agy hooks deliver unread messages synchronously on PreInvocation and Stop, and cli wait wakes on arrival', async () => {
    const store = createTaskStore(home);
    const mailbox = createMailbox(home);
    const registry = createDefaultRegistry({
      codexRoot: fixture.codexRoot,
      claudeRoot: fixture.claudeRoot,
      agyRoot: fixture.agyRoot,
      home,
      deliverToCodex: async () => {},
    });
    const messaging = createMessaging({ mailbox, registry });

    await mailbox.add({ from: { source: 'codex', id: CODEX_ID }, to: { source: 'agy', id: AGY_ID }, text: 'PreInvocation 測試訊息' });
    const preOut = await runHook({
      source: 'agy',
      rawInput: { hookEventName: 'PreInvocation', conversationId: AGY_ID },
      home,
      registry,
      mailbox,
      taskStore: store,
      messaging,
    });
    const preJson = JSON.parse(preOut.stdout);
    assert.match(preJson.injectSteps[0].systemMessage.systemMessage, /PreInvocation 測試訊息/);

    await mailbox.add({ from: { source: 'claude', id: CLAUDE_ID }, to: { source: 'agy', id: AGY_ID }, text: 'Stop 續跑測試訊息' });
    const stopOut = await runHook({
      source: 'agy',
      rawInput: { hookEventName: 'Stop', conversationId: AGY_ID },
      home,
      registry,
      mailbox,
      taskStore: store,
      messaging,
    });
    const stopJson = JSON.parse(stopOut.stdout);
    assert.equal(stopJson.decision, 'continue');
    assert.match(stopJson.reason, /Stop 續跑測試訊息/);

    await mailbox.add({ from: { source: 'codex', id: CODEX_ID }, to: { source: 'agy', id: AGY_ID }, text: 'wait 喚醒測試' });
    const waited = await runCli(['wait', 'agy', AGY_ID, '--timeout', '2', '--poll-ms', '50'], { home });
    assert.match(waited, /wait 喚醒測試/);
  });
});
