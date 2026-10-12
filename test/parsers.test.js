import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { listClaudeSessions, readClaudeEntries } from '../src/claude.js';
import { listCodexSessions, readCodexEntries } from '../src/codex.js';
import { isWithin, truncate } from '../src/util.js';
import { CLAUDE_ID, CLAUDE_OTHER_ID, CODEX_ID, OTHER_CWD, PROJECT_CWD, createFixture } from './fixtures.js';

let fixture;
before(() => { fixture = createFixture(); });
after(() => fixture.cleanup());

describe('util', () => {
  test('isWithin matches the same directory regardless of case and separators', () => {
    assert.equal(isWithin('c:/Work/Demo/', 'C:\\work\\demo'), true);
  });

  test('isWithin matches subdirectories but not sibling prefixes', () => {
    assert.equal(isWithin('C:\\work\\demo\\src', 'C:\\work\\demo'), true);
    assert.equal(isWithin('C:\\work\\demo-2', 'C:\\work\\demo'), false);
  });

  test('truncate reports the original length when cutting text', () => {
    assert.equal(truncate('abcdef', 3), 'abc…(共 6 字)');
    assert.equal(truncate('abc', 3), 'abc');
  });
});

describe('codex parser', () => {
  test('lists user sessions with title from the index and skips subagent sessions', async () => {
    const sessions = await listCodexSessions(fixture.codexRoot);

    assert.equal(sessions.length, 1);
    assert.deepEqual(
      { ...sessions[0], updatedAt: undefined },
      {
        source: 'codex',
        id: CODEX_ID,
        title: '修正登入 bug',
        cwd: PROJECT_CWD,
        startedAt: '2026-10-07T08:51:02.346Z',
        updatedAt: undefined,
        file: fixture.codexFile,
      },
    );
    assert.match(sessions[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns an empty list when the sessions directory is missing', async () => {
    assert.deepEqual(await listCodexSessions(`${fixture.codexRoot}-missing`), []);
  });

  test('reads user and agent messages plus one-line tool summaries in order', async () => {
    const entries = await readCodexEntries(fixture.codexFile);

    assert.deepEqual(
      entries.map(({ index, role, text }) => [index, role, text]),
      [
        [0, 'user', '請修好登入的 bug'],
        [1, 'assistant', '我先看一下 auth 模組。'],
        [2, 'tool', 'exec: Get-Content src/auth.js'],
        [3, 'tool', 'file_change: update C:\\work\\demo\\src\\auth.js'],
        [4, 'assistant', '已修正 token 過期判斷。'],
      ],
    );
    assert.equal(entries[0].timestamp, '2026-10-07T08:51:16.000Z');
    assert.equal(entries.some((entry) => 'detail' in entry), false);
  });

  test('attaches full tool detail only to the requested entry', async () => {
    const entries = await readCodexEntries(fixture.codexFile, { detailIndex: 2 });

    assert.match(entries[2].detail, /SECRET_TOOL_OUTPUT/);
    assert.equal('detail' in entries[3], false);
  });
});

describe('claude parser', () => {
  test('lists top-level sessions with ai title, cwd and start time', async () => {
    const sessions = await listClaudeSessions(fixture.claudeRoot);
    const byId = Object.fromEntries(sessions.map((session) => [session.id, session]));

    assert.deepEqual(Object.keys(byId).sort(), [CLAUDE_ID, CLAUDE_OTHER_ID].sort());
    assert.equal(byId[CLAUDE_ID].source, 'claude');
    assert.equal(byId[CLAUDE_ID].title, '加入深色模式');
    assert.equal(byId[CLAUDE_ID].cwd, PROJECT_CWD);
    assert.equal(byId[CLAUDE_ID].startedAt, '2026-10-09T06:24:00.000Z');
    assert.equal(byId[CLAUDE_ID].file, fixture.claudeFile);
  });

  test('falls back to the first prompt when a session has no ai title', async () => {
    const sessions = await listClaudeSessions(fixture.claudeRoot);
    const other = sessions.find((session) => session.id === CLAUDE_OTHER_ID);

    assert.equal(other.title, '另一個專案的問題');
    assert.equal(other.cwd, OTHER_CWD);
  });

  test('reads conversation text and tool summaries while skipping meta, thinking and sidechains', async () => {
    const entries = await readClaudeEntries(fixture.claudeFile);

    assert.deepEqual(
      entries.map(({ index, role, text }) => [index, role, text]),
      [
        [0, 'user', '幫我加上深色模式'],
        [1, 'assistant', '我先讀取樣式檔。'],
        [2, 'tool', 'Read: {"file_path":"C:\\\\work\\\\demo\\\\style.css"}'],
        [3, 'assistant', '深色模式已完成。'],
      ],
    );
    assert.equal(entries.some((entry) => 'detail' in entry), false);
  });

  test('attaches tool input and matching result to the requested entry', async () => {
    const entries = await readClaudeEntries(fixture.claudeFile, { detailIndex: 2 });

    assert.match(entries[2].detail, /style\.css/);
    assert.match(entries[2].detail, /body \{ color: black \}/);
  });
});
