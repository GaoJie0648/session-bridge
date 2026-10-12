import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createMailbox } from '../src/mailbox.js';
import { createTools } from '../src/tools.js';
import { CLAUDE_ID, CLAUDE_OTHER_ID, CODEX_ID, OTHER_CWD, PROJECT_CWD, createFixture } from './fixtures.js';

let fixture;
let tools;
let queued = [];
before(() => {
  fixture = createFixture();
  tools = createTools({
    codexRoot: fixture.codexRoot,
    claudeRoot: fixture.claudeRoot,
    defaultCwd: PROJECT_CWD,
    mailbox: createMailbox(path.join(fixture.codexRoot, '..', 'mailbox')),
    deliverToCodex: async (threadId, text) => {
      queued = [...queued, { threadId, text }];
    },
  });
});
after(() => fixture.cleanup());

describe('send_message and check_inbox', () => {
  const claudeToCodex = { from_source: 'claude', from_id: CLAUDE_ID, to_source: 'codex', to_id: CODEX_ID };

  test('delivers to an existing codex session and tells the sender what happens next', async () => {
    const output = await tools.sendMessage({ ...claudeToCodex, text: '請接手登入修正' });

    assert.equal(queued.at(-1).threadId, CODEX_ID);
    assert.match(queued.at(-1).text, /請接手登入修正/);
    assert.match(output, /已送出/);
  });

  test('refuses a sender that is not a session on this machine', async () => {
    const forged = { ...claudeToCodex, from_id: '00000000-0000-0000-0000-000000000000' };

    await assert.rejects(tools.sendMessage({ ...forged, text: 'hi' }), /找不到/);
  });

  test('hands a claude session its unread messages', async () => {
    await tools.sendMessage({ from_source: 'codex', from_id: CODEX_ID, to_source: 'claude', to_id: CLAUDE_ID, text: '修好了，請驗收' });

    assert.match(await tools.checkInbox({ id: CLAUDE_ID }), /修好了，請驗收/);
    assert.match(await tools.checkInbox({ id: CLAUDE_ID }), /沒有新訊息/);
  });

  test('refuses an inbox id that is not a session id', async () => {
    await assert.rejects(tools.checkInbox({ id: '..\\..\\secrets' }), /找不到/);
  });
});

describe('list_sessions', () => {
  test('defaults to sessions of the current project from both tools, newest first', async () => {
    const output = await tools.listSessions({});

    assert.match(output, new RegExp(`claude ${CLAUDE_ID}`));
    assert.match(output, new RegExp(`codex ${CODEX_ID}`));
    assert.doesNotMatch(output, new RegExp(CLAUDE_OTHER_ID));
    assert.ok(output.indexOf(CLAUDE_ID) < output.indexOf(CODEX_ID));
    assert.match(output, /修正登入 bug/);
  });

  test('filters by source', async () => {
    const output = await tools.listSessions({ source: 'codex' });

    assert.match(output, new RegExp(CODEX_ID));
    assert.doesNotMatch(output, new RegExp(CLAUDE_ID));
  });

  test('includes other projects when all is set', async () => {
    const output = await tools.listSessions({ all: true });

    assert.match(output, new RegExp(CLAUDE_OTHER_ID));
  });

  test('uses an explicit cwd over the default', async () => {
    const output = await tools.listSessions({ cwd: OTHER_CWD });

    assert.match(output, new RegExp(CLAUDE_OTHER_ID));
    assert.doesNotMatch(output, new RegExp(CODEX_ID));
  });

  test('explains how to widen the scope when nothing matches', async () => {
    const output = await tools.listSessions({ cwd: 'C:\\nowhere' });

    assert.match(output, /all=true/);
  });
});

describe('read_session', () => {
  test('returns the last entries by default with indexes and roles', async () => {
    const output = await tools.readSession({ source: 'codex', id: CODEX_ID, limit: 2 });

    assert.match(output, /\[3\] .*tool\nfile_change: update/);
    assert.match(output, /\[4\] .*assistant\n已修正 token 過期判斷。/);
    assert.doesNotMatch(output, /請修好登入的 bug/);
    assert.match(output, /共 5 則/);
  });

  test('pages from the start when offset is given', async () => {
    const output = await tools.readSession({ source: 'claude', id: CLAUDE_ID, offset: 0, limit: 1 });

    assert.match(output, /\[0\] .*user\n幫我加上深色模式/);
    assert.doesNotMatch(output, /深色模式已完成/);
  });

  test('points to the next page when more entries follow', async () => {
    const output = await tools.readSession({ source: 'claude', id: CLAUDE_ID, offset: 0, limit: 1 });

    assert.match(output, /較新的內容請用 offset=1/);
  });

  test('rejects an offset beyond the last entry', async () => {
    await assert.rejects(tools.readSession({ source: 'codex', id: CODEX_ID, offset: 99 }), /0–4/);
  });

  test('never includes tool output in the transcript', async () => {
    const output = await tools.readSession({ source: 'codex', id: CODEX_ID });

    assert.doesNotMatch(output, /SECRET_TOOL_OUTPUT/);
  });

  test('truncates long messages to maxChars', async () => {
    const output = await tools.readSession({ source: 'codex', id: CODEX_ID, offset: 0, limit: 1, maxChars: 3 });

    assert.match(output, /請修好…\(共 \d+ 字\)/);
  });

  test('rejects ids that are not session ids', async () => {
    await assert.rejects(tools.readSession({ source: 'codex', id: '..\\..\\secrets' }), /找不到/);
  });

  test('rejects unknown sessions', async () => {
    await assert.rejects(
      tools.readSession({ source: 'claude', id: '00000000-0000-0000-0000-000000000000' }),
      /找不到/,
    );
  });
});

describe('get_entry', () => {
  test('returns the full detail of a tool entry', async () => {
    const output = await tools.getEntry({ source: 'codex', id: CODEX_ID, index: 2 });

    assert.match(output, /SECRET_TOOL_OUTPUT/);
  });

  test('returns the full text of a message entry', async () => {
    const output = await tools.getEntry({ source: 'claude', id: CLAUDE_ID, index: 3 });

    assert.match(output, /深色模式已完成。/);
  });

  test('rejects an out-of-range index', async () => {
    await assert.rejects(tools.getEntry({ source: 'codex', id: CODEX_ID, index: 99 }), /0–4/);
  });
});

describe('search_sessions', () => {
  test('finds matches in conversation text across both tools within the project', async () => {
    const output = await tools.searchSessions({ query: '模式' });

    assert.match(output, new RegExp(`claude ${CLAUDE_ID} \\[0\\]`));
    assert.doesNotMatch(output, new RegExp(CODEX_ID));
  });

  test('is case-insensitive and skips tool entries', async () => {
    assert.match(await tools.searchSessions({ query: 'TOKEN' }), new RegExp(`codex ${CODEX_ID} \\[4\\]`));
    assert.match(await tools.searchSessions({ query: 'Get-Content' }), /沒有符合/);
  });

  test('searches other projects only when all is set', async () => {
    assert.match(await tools.searchSessions({ query: '另一個專案' }), /沒有符合/);
    assert.match(await tools.searchSessions({ query: '另一個專案', all: true }), new RegExp(CLAUDE_OTHER_ID));
  });
});
