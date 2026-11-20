import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_ID = '01a1158f-199e-71e3-97b4-cb71474ff6a3';
export const CODEX_SUBAGENT_ID = '01a1158f-199e-71e3-97b4-cb71474ff6a4';
export const CLAUDE_ID = '05946130-03c8-41ef-b1fc-001a34cd6c5c';
export const CLAUDE_OTHER_ID = '15946130-03c8-41ef-b1fc-001a34cd6c5d';
export const AGY_ID = '16cf5210-3c2a-4a69-8699-0869d0bfd438';
export const UNREADABLE_ID = '25946130-03c8-41ef-b1fc-001a34cd6c5e';
export const PROJECT_CWD = 'C:\\work\\demo';
export const OTHER_CWD = 'C:\\work\\other';

const toJsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

const completed = (timestamp, item) => ({
  timestamp,
  type: 'event_msg',
  payload: { type: 'item_completed', item },
});

const codexRecords = [
  {
    timestamp: '2026-10-07T08:51:15.303Z',
    type: 'session_meta',
    payload: { id: CODEX_ID, cwd: PROJECT_CWD, timestamp: '2026-10-07T08:51:02.346Z', source: 'cli' },
  },
  {
    timestamp: '2026-10-07T08:51:15.500Z',
    type: 'turn_context',
    payload: { model: 'gpt-5.4' },
  },
  { timestamp: '2026-10-07T08:51:15.627Z', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'injected instructions' }] } },
  completed('2026-10-07T08:51:16.000Z', { type: 'UserMessage', content: [{ type: 'text', text: '請修好登入的 bug' }] }),
  completed('2026-10-07T08:51:17.000Z', { type: 'Reasoning', summary_text: [], raw_content: [] }),
  completed('2026-10-07T08:51:18.000Z', { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'Text', text: '我先看一下 auth 模組。' }] }),
  completed('2026-10-07T08:51:19.000Z', {
    type: 'CommandExecution',
    command: ['pwsh.exe', '-Command', 'Get-Content src/auth.js'],
    aggregated_output: 'SECRET_TOOL_OUTPUT',
  }),
  completed('2026-10-07T08:51:20.000Z', {
    type: 'FileChange',
    changes: { 'C:\\work\\demo\\src\\auth.js': { type: 'update', unified_diff: '@@ -1 +1 @@' } },
  }),
  completed('2026-10-07T08:51:21.000Z', { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: '已修正 token 過期判斷。' }] }),
  {
    timestamp: '2026-10-07T08:51:22.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 1200, output_tokens: 300, cached_input_tokens: 800 } },
      rate_limits: { primary: { used_percent: 12 } },
    },
  },
  'not json',
];

const codexSubagentRecords = [
  {
    timestamp: '2026-10-08T08:51:15.303Z',
    type: 'session_meta',
    payload: { id: CODEX_SUBAGENT_ID, cwd: PROJECT_CWD, timestamp: '2026-10-08T08:51:02.346Z', source: { subagent: { other: 'guardian' } } },
  },
];

const claudeBase = { cwd: PROJECT_CWD, sessionId: CLAUDE_ID, isSidechain: false };

const claudeRecords = [
  { type: 'mode', mode: 'normal', sessionId: CLAUDE_ID },
  { ...claudeBase, type: 'user', isMeta: true, timestamp: '2026-10-09T06:24:00.000Z', message: { role: 'user', content: '<system-reminder>meta</system-reminder>' } },
  { ...claudeBase, type: 'user', timestamp: '2026-10-09T06:24:03.980Z', message: { role: 'user', content: '幫我加上深色模式' } },
  {
    ...claudeBase,
    type: 'assistant',
    timestamp: '2026-10-09T06:24:09.142Z',
    message: {
      id: 'msg_1',
      model: 'claude-sonnet-4-6',
      role: 'assistant',
      usage: { input_tokens: 500, output_tokens: 120, cache_read_input_tokens: 400, cache_creation_input_tokens: 100 },
      content: [
        { type: 'thinking', thinking: 'hidden thoughts' },
        { type: 'text', text: '我先讀取樣式檔。' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\work\\demo\\style.css' } },
      ],
    },
  },
  {
    ...claudeBase,
    type: 'user',
    timestamp: '2026-10-09T06:24:10.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'body { color: black }' }] }] },
  },
  { ...claudeBase, type: 'assistant', timestamp: '2026-10-09T06:24:10.500Z', message: { role: 'assistant', content: [null] } },
  { ...claudeBase, isSidechain: true, type: 'assistant', timestamp: '2026-10-09T06:24:11.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sidechain noise' }] } },
  {
    ...claudeBase,
    type: 'assistant',
    timestamp: '2026-10-09T06:24:12.000Z',
    message: {
      id: 'msg_2',
      model: 'claude-sonnet-4-6',
      role: 'assistant',
      usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 300 },
      content: [{ type: 'text', text: '深色模式已完成。' }],
    },
  },
  { type: 'ai-title', aiTitle: '加入深色模式', sessionId: CLAUDE_ID },
];

const claudeOtherRecords = [
  { cwd: OTHER_CWD, sessionId: CLAUDE_OTHER_ID, isSidechain: false, type: 'user', timestamp: '2026-10-01T01:00:00.000Z', message: { role: 'user', content: '另一個專案的問題' } },
];

const agyRecords = [
  {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-10-10T06:00:00Z',
    content: '<USER_REQUEST>\n幫我檢查 Antigravity 整合\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>',
  },
  {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-10-10T06:00:05Z',
    model: 'gemini-4-neon-medium',
    input_tokens: 1000,
    cache_read_tokens: 600,
    output_tokens: 250,
    content: '我先讀一下設定檔。',
    tool_calls: [{ name: 'read_file', args: { Path: 'C:\\work\\demo\\package.json' } }],
  },
  {
    step_index: 2,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-10-10T06:00:06Z',
    content: '{"name":"demo"}',
  },
  {
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-10-10T06:00:10Z',
    model: 'gemini-4-neon-medium',
    input_tokens: 400,
    cache_read_tokens: 900,
    output_tokens: 150,
    content: 'Antigravity 整合已確認完成。',
  },
];

const writeFile = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

export const createFixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bridge-'));
  const codexRoot = path.join(dir, 'codex');
  const claudeRoot = path.join(dir, 'claude-projects');
  const agyRoot = path.join(dir, 'agy-brain');
  const bridgeHome = path.join(dir, 'bridge-home');

  const codexFile = writeFile(
    path.join(codexRoot, 'sessions', '2026', '10', '07', `rollout-2026-10-07T16-51-02-${CODEX_ID}.jsonl`),
    toJsonl(codexRecords).replace('"not json"', 'not json'),
  );
  writeFile(
    path.join(codexRoot, 'sessions', '2026', '10', '08', `rollout-2026-10-08T16-51-02-${CODEX_SUBAGENT_ID}.jsonl`),
    toJsonl(codexSubagentRecords),
  );
  writeFile(
    path.join(codexRoot, 'session_index.jsonl'),
    toJsonl([
      { id: CODEX_ID, thread_name: '舊標題', updated_at: '2026-10-07T08:51:00Z' },
      { id: CODEX_ID, thread_name: '修正登入 bug', updated_at: '2026-10-07T08:52:00Z' },
    ]),
  );

  const claudeFile = writeFile(path.join(claudeRoot, 'C--work-demo', `${CLAUDE_ID}.jsonl`), toJsonl(claudeRecords));
  writeFile(path.join(claudeRoot, 'C--work-other', `${CLAUDE_OTHER_ID}.jsonl`), toJsonl(claudeOtherRecords));
  writeFile(path.join(claudeRoot, 'C--work-demo', CLAUDE_ID, 'subagents', 'agent-1.jsonl'), toJsonl(claudeOtherRecords));
  fs.mkdirSync(path.join(claudeRoot, 'C--work-demo', `${UNREADABLE_ID}.jsonl`));

  const agyFile = writeFile(
    path.join(agyRoot, AGY_ID, '.system_generated', 'logs', 'transcript.jsonl'),
    toJsonl(agyRecords),
  );
  writeFile(
    path.join(bridgeHome, 'meta', `agy-${AGY_ID}.json`),
    JSON.stringify({ id: AGY_ID, cwd: PROJECT_CWD }),
  );

  fs.utimesSync(codexFile, new Date('2026-10-07T09:00:00Z'), new Date('2026-10-07T09:00:00Z'));
  fs.utimesSync(claudeFile, new Date('2026-10-09T07:00:00Z'), new Date('2026-10-09T07:00:00Z'));
  fs.utimesSync(agyFile, new Date('2026-10-10T07:00:00Z'), new Date('2026-10-10T07:00:00Z'));

  return {
    dir,
    bridgeHome,
    codexRoot,
    claudeRoot,
    agyRoot,
    codexFile,
    claudeFile,
    agyFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};
