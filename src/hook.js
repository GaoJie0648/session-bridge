#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';

import { listClaudeSessions, readClaudeEntries } from './claude.js';
import { listCodexSessions } from './codex.js';
import { createCodexQueue } from './codex-queue.js';
import { SOURCES, createMailbox, defaultMailboxRoot } from './mailbox.js';
import { createMessaging } from './messaging.js';
import { createUsageAlerts, createUsageStore, notifyDesktop, readCodexUsage } from './usage.js';
import { SESSION_ID, isWithin, orElse, parseJson } from './util.js';
import { waitForMessages } from './waiter.js';

const POLL_MS = 2000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// Claude Code 的 asyncRewake hook 以結束碼 2 喚醒模型，stderr 內容會交給它
const WAKE_EXIT_CODE = 2;

const readStdin = async () => {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return parseJson(data) ?? {};
};

const parentGone = () => {
  try {
    process.kill(process.ppid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};

const lastReply = async (source, input, mailbox, self) => {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
  if (source !== 'claude' || !input.transcript_path) return undefined;
  // 逐字稿可能有數百 MB，只有確實要回報時才讀
  if ((await mailbox.list(self, 'active')).length === 0) return undefined;
  const entries = await orElse(readClaudeEntries, [])(input.transcript_path);
  return entries.findLast((entry) => entry.role === 'assistant')?.text;
};

const listSessions = {
  codex: () => listCodexSessions(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')),
  claude: () => listClaudeSessions(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')),
};

// 交接對象：同專案中最近有動靜的另一邊 session
const findPeer = (cwd) => async (self) => {
  if (!cwd) return null;
  const other = self.source === 'codex' ? 'claude' : 'codex';
  const sessions = (await orElse(listSessions[other], [])()).filter((session) => isWithin(session.cwd, cwd));
  return sessions.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
};

// Claude Code 的用量由 statusline 寫入快照；Codex 直接從自己的 rollout 檔讀取，並存成快照給另一邊判斷能否交接
const currentUsage = async (source, input, store) => {
  if (source === 'claude') return store.loadSnapshot('claude');
  if (!input.transcript_path) return [];
  const windows = await readCodexUsage(input.transcript_path);
  if (windows.length > 0) await store.saveSnapshot('codex', windows);
  return windows;
};

/** 用量達門檻時回傳要注入給 agent 的 hook 輸出，否則回傳 undefined */
const checkUsage = async ({ source, input, self }) => {
  const store = createUsageStore(defaultMailboxRoot());
  const alerts = createUsageAlerts({ store, findPeer: findPeer(input.cwd), notify: notifyDesktop });
  const alert = await alerts.check(self, await currentUsage(source, input, store));
  if (!alert) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: alert } });
};

// 用量提醒只是輔助，讀不到用量時不該影響原本的 hook
const writeUsageAlert = async (args) => {
  const output = await orElse(checkUsage, undefined)(args);
  if (output) process.stdout.write(output);
};

const onStop = async ({ source, input, self, mailbox, messaging }) => {
  // 回報失敗不該連帶讓這個 session 停止收信
  await orElse(async () => messaging.onStop({ ...self, lastMessage: await lastReply(source, input, mailbox, self) }))();
  // Codex 由 codex queue 直接收訊，只有 Claude Code 需要留下來等信
  if (source !== 'claude') return 0;
  const messages = await waitForMessages({
    messaging,
    mailbox,
    address: self,
    isAbandoned: parentGone,
    sleep: () => new Promise((resolve) => setTimeout(resolve, POLL_MS)),
    maxPolls: MAX_WAIT_MS / POLL_MS,
  });
  if (messages.length === 0) return 0;
  process.stderr.write(messages.join('\n\n---\n\n'));
  return WAKE_EXIT_CODE;
};

const main = async () => {
  if (process.env.SESSION_BRIDGE_MANAGED === '1') return 0;
  const source = process.argv[2];
  const input = await readStdin();
  if (!SOURCES.includes(source) || !SESSION_ID.test(input.session_id ?? '')) return 0;
  const self = { source, id: input.session_id };
  const mailbox = createMailbox(defaultMailboxRoot());
  const messaging = createMessaging({ mailbox, deliverToCodex: createCodexQueue() });

  switch (input.hook_event_name) {
    case 'SessionStart':
      process.stdout.write(
        `session-bridge：這個 session 的位址是 ${source} ${self.id}。要傳訊息給其他 Codex CLI 或 Claude Code session 時，使用 send_message 並以此作為 from_source 與 from_id。`,
      );
      return 0;
    case 'UserPromptSubmit':
      await messaging.onPromptSubmit({ ...self, prompt: input.prompt });
      await writeUsageAlert({ source, input, self });
      return 0;
    case 'PostToolUse':
      await writeUsageAlert({ source, input, self });
      return 0;
    case 'Stop':
      return onStop({ source, input, self, mailbox, messaging });
    default:
      return 0;
  }
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`[session-bridge] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
