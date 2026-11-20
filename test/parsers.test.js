import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { listAgySessions, readAgyEntries, readAgyUsage } from '../src/providers/agy.js';
import { listClaudeSessions, readClaudeEntries, readClaudeUsage } from '../src/providers/claude.js';
import { listCodexSessions, readCodexEntries, readCodexUsage } from '../src/providers/codex.js';
import { AGY_ID, CLAUDE_ID, CLAUDE_OTHER_ID, CODEX_ID, PROJECT_CWD, createFixture } from './fixtures.js';

let fixture;
before(() => {
  fixture = createFixture();
});
after(() => fixture.cleanup());

describe('codex provider parser', () => {
  test('lists user sessions with latest title from index and skips subagents', async () => {
    const sessions = await listCodexSessions(fixture.codexRoot);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, CODEX_ID);
    assert.equal(sessions[0].title, '修正登入 bug');
    assert.equal(sessions[0].cwd, PROJECT_CWD);
  });

  test('reads entries, omits reasoning and tool outputs unless detailIndex is set', async () => {
    const entries = await readCodexEntries(fixture.codexFile);

    assert.equal(entries.length, 5);
    assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
    assert.doesNotMatch(entries[2].text, /SECRET_TOOL_OUTPUT/);

    const detailed = await readCodexEntries(fixture.codexFile, { detailIndex: 2 });
    assert.match(detailed[2].detail, /SECRET_TOOL_OUTPUT/);
  });

  test('extracts model, token usage, and rate limits', async () => {
    const usage = await readCodexUsage(fixture.codexFile);

    assert.equal(usage.model, 'gpt-5.4');
    assert.equal(usage.inputTokens, 1200);
    assert.equal(usage.outputTokens, 300);
    assert.equal(usage.cacheReadTokens, 800);
    assert.equal(usage.rateLimits.primary.used_percent, 12);
  });
});

describe('claude provider parser', () => {
  test('lists sessions, prefers ai-title, and skips unreadable files and subagents', async () => {
    const sessions = await listClaudeSessions(fixture.claudeRoot);

    assert.equal(sessions.length, 2);
    const main = sessions.find((s) => s.id === CLAUDE_ID);
    const other = sessions.find((s) => s.id === CLAUDE_OTHER_ID);
    assert.equal(main.title, '加入深色模式');
    assert.equal(other.title, '另一個專案的問題');
  });

  test('reads entries, skips meta and sidechain, attaches tool detail on demand', async () => {
    const entries = await readClaudeEntries(fixture.claudeFile);

    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'tool', 'assistant']);

    const detailed = await readClaudeEntries(fixture.claudeFile, { detailIndex: 2 });
    assert.match(detailed[2].detail, /body \{ color: black \}/);
  });

  test('aggregates token usage from assistant messages', async () => {
    const usage = await readClaudeUsage(fixture.claudeFile);

    assert.equal(usage.model, 'claude-sonnet-4-6');
    assert.equal(usage.inputTokens, 700);
    assert.equal(usage.outputTokens, 200);
    assert.equal(usage.cacheReadTokens, 700);
    assert.equal(usage.turns, 2);
  });
});

describe('agy provider parser', () => {
  test('lists Antigravity CLI sessions and attaches recorded cwd metadata', async () => {
    const sessions = await listAgySessions(fixture.agyRoot, fixture.bridgeHome);

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, AGY_ID);
    assert.equal(sessions[0].title, '幫我檢查 Antigravity 整合');
    assert.equal(sessions[0].cwd, PROJECT_CWD);
  });

  test('extracts clean user request, assistant text, and tool call details', async () => {
    const entries = await readAgyEntries(fixture.agyFile);

    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map((e) => e.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(entries[0].text, '幫我檢查 Antigravity 整合');
    assert.match(entries[2].text, /read_file/);

    const detailed = await readAgyEntries(fixture.agyFile, { detailIndex: 2 });
    assert.match(detailed[2].detail, /"name":"demo"/);
  });

  test('aggregates model and token usage from PLANNER_RESPONSE steps', async () => {
    const usage = await readAgyUsage(fixture.agyFile);

    assert.equal(usage.model, 'gemini-4-neon-medium');
    assert.equal(usage.inputTokens, 1400);
    assert.equal(usage.outputTokens, 400);
    assert.equal(usage.cacheReadTokens, 1500);
    assert.equal(usage.turns, 2);
  });
});
