import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  createUsageAlerts,
  createUsageStore,
  formatUsage,
  fromClaudeStatus,
  levelOf,
  readCodexUsage,
} from '../src/usage.js';

const CLAUDE = { source: 'claude', id: '05946130-03c8-41ef-b1fc-001a34cd6c5c' };
const CODEX = { source: 'codex', id: '01a1158f-199e-71e3-97b4-cb71474ff6a3' };
const NOW = Date.UTC(2026, 9, 15, 6, 0, 0);
const RESET = NOW / 1000 + 3600;
const WEEK_RESET = NOW / 1000 + 5 * 24 * 3600;

const tokenCount = (rateLimits) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: rateLimits } });

let root;
let store;
let notified;
let peer;

const alertsFor = () =>
  createUsageAlerts({
    store,
    findPeer: async () => peer,
    notify: (title, text) => {
      notified = [...notified, { title, text }];
    },
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-usage-'));
  store = createUsageStore(root, () => NOW);
  notified = [];
  peer = CODEX;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('reading usage', () => {
  test('takes the latest rate_limits from the codex rollout tail', async () => {
    const file = path.join(root, 'rollout.jsonl');
    fs.writeFileSync(
      file,
      [
        tokenCount({ primary: { used_percent: 10, window_minutes: 300, resets_at: RESET } }),
        JSON.stringify({ type: 'response_item', payload: {} }),
        tokenCount({
          primary: { used_percent: 85, window_minutes: 300, resets_at: RESET },
          secondary: { used_percent: 40, window_minutes: 10080, resets_at: WEEK_RESET },
        }),
        '{"type":"event_msg","payload":{"rate_limits"',
      ].join('\n'),
    );

    assert.deepEqual(await readCodexUsage(file), [
      { name: '5h', usedPercent: 85, resetsAt: RESET },
      { name: '7d', usedPercent: 40, resetsAt: WEEK_RESET },
    ]);
  });

  test('handles a weekly-only window and a rollout without rate_limits', async () => {
    const weekly = path.join(root, 'weekly.jsonl');
    const empty = path.join(root, 'empty.jsonl');
    fs.writeFileSync(weekly, tokenCount({ primary: { used_percent: 2, window_minutes: 10080, resets_at: WEEK_RESET }, secondary: null }));
    fs.writeFileSync(empty, JSON.stringify({ type: 'session_meta', payload: {} }));

    assert.deepEqual(await readCodexUsage(weekly), [{ name: '7d', usedPercent: 2, resetsAt: WEEK_RESET }]);
    assert.deepEqual(await readCodexUsage(empty), []);
  });

  test('converts the claude statusline input and formats it', () => {
    const windows = fromClaudeStatus({
      rate_limits: { five_hour: { used_percentage: 42.4, resets_at: RESET }, seven_day: { used_percentage: 18, resets_at: WEEK_RESET } },
    });

    assert.equal(formatUsage(windows), '5h 42% · 7d 18%');
    assert.deepEqual(fromClaudeStatus({}), []);
  });

  test('ignores stale snapshots and windows that already reset', async () => {
    await store.saveSnapshot('claude', [
      { name: '5h', usedPercent: 95, resetsAt: NOW / 1000 - 1 },
      { name: '7d', usedPercent: 50, resetsAt: WEEK_RESET },
    ]);

    assert.deepEqual(await store.loadSnapshot('claude'), [{ name: '7d', usedPercent: 50, resetsAt: WEEK_RESET }]);
    assert.deepEqual(await createUsageStore(root, () => NOW + 11 * 60 * 1000).loadSnapshot('claude'), []);
  });
});

describe('alerts', () => {
  test('uses 80% and 90% thresholds', () => {
    assert.equal(levelOf({ usedPercent: 79.9 }), null);
    assert.equal(levelOf({ usedPercent: 80 }), 'warn');
    assert.equal(levelOf({ usedPercent: 90 }), 'urgent');
  });

  test('warns once per window and level, then escalates to urgent', async () => {
    const alerts = alertsFor();
    const warn = await alerts.check(CLAUDE, [{ name: '5h', usedPercent: 82, resetsAt: RESET }]);

    assert.match(warn, /5h 用量已達 82%/);
    assert.match(warn, /收尾/);
    assert.equal(await alerts.check(CLAUDE, [{ name: '5h', usedPercent: 86, resetsAt: RESET }]), null);

    const urgent = await alerts.check(CLAUDE, [{ name: '5h', usedPercent: 91, resetsAt: RESET }]);
    assert.match(urgent, /安全點/);
    assert.match(urgent, new RegExp(`to_source=codex、to_id=${CODEX.id}`));
    assert.equal(notified.length, 2);
  });

  test('alerts again after the window resets', async () => {
    const alerts = alertsFor();
    await alerts.check(CLAUDE, [{ name: '7d', usedPercent: 81, resetsAt: RESET }]);

    assert.notEqual(await alerts.check(CLAUDE, [{ name: '7d', usedPercent: 81, resetsAt: WEEK_RESET }]), null);
  });

  test('jumping straight to urgent does not send a late warning', async () => {
    const alerts = alertsFor();
    await alerts.check(CLAUDE, [{ name: '5h', usedPercent: 95, resetsAt: RESET }]);

    assert.equal(await alerts.check(CLAUDE, [{ name: '5h', usedPercent: 95, resetsAt: RESET }]), null);
  });

  test('each session gets its own reminder but the desktop notification is sent once', async () => {
    const alerts = alertsFor();
    const other = { source: 'claude', id: '15946130-03c8-41ef-b1fc-001a34cd6c5c' };
    await alerts.check(CLAUDE, [{ name: '5h', usedPercent: 82, resetsAt: RESET }]);

    assert.notEqual(await alerts.check(other, [{ name: '5h', usedPercent: 82, resetsAt: RESET }]), null);
    assert.equal(notified.length, 1);
  });

  test('does not hand off when there is no peer session', async () => {
    peer = null;
    const alert = await alertsFor().check(CODEX, [{ name: '5h', usedPercent: 92, resetsAt: RESET }]);

    assert.match(alert, /找不到另一邊（Claude Code）的 session/);
    assert.doesNotMatch(alert, /send_message/);
  });

  test('does not hand off when the peer is also near its limit', async () => {
    await store.saveSnapshot('codex', [{ name: '7d', usedPercent: 93, resetsAt: WEEK_RESET }]);
    const alert = await alertsFor().check(CLAUDE, [{ name: '5h', usedPercent: 92, resetsAt: RESET }]);

    assert.match(alert, /另一邊（Codex CLI）的用量也已達 90%/);
    assert.doesNotMatch(alert, /send_message/);
  });

  test('stays quiet below the threshold', async () => {
    assert.equal(await alertsFor().check(CLAUDE, [{ name: '5h', usedPercent: 50, resetsAt: RESET }]), null);
    assert.equal(notified.length, 0);
  });
});

describe('statusline and hook', () => {
  const run = (script, args, input) =>
    spawnSync(process.execPath, [path.join('src', script), ...args], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, SESSION_BRIDGE_HOME: root, SESSION_BRIDGE_NOTIFY: '0', CODEX_HOME: root, CLAUDE_CONFIG_DIR: root },
    });

  test('the statusline snapshot drives the claude PostToolUse reminder', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const status = run('statusline.js', [], { rate_limits: { five_hour: { used_percentage: 83, resets_at: resetsAt } } });
    assert.equal(status.stdout, '5h 83%');

    const hook = run('hook.js', ['claude'], { session_id: CLAUDE.id, hook_event_name: 'PostToolUse', cwd: root });
    const output = JSON.parse(hook.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /5h 用量已達 83%/);

    assert.equal(run('hook.js', ['claude'], { session_id: CLAUDE.id, hook_event_name: 'PostToolUse', cwd: root }).stdout, '');
  });

  test('the codex hook reads its own rollout', () => {
    const file = path.join(root, 'rollout.jsonl');
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(file, tokenCount({ primary: { used_percent: 96, window_minutes: 300, resets_at: resetsAt } }));

    const hook = run('hook.js', ['codex'], { session_id: CODEX.id, hook_event_name: 'PostToolUse', cwd: root, transcript_path: file });
    assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /5h 用量已達 96%/);
    assert.ok(fs.existsSync(path.join(root, 'usage', 'codex.json')));
  });
});
