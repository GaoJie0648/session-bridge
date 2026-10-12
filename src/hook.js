#!/usr/bin/env node
import { readClaudeEntries } from './claude.js';
import { createCodexQueue } from './codex-queue.js';
import { SOURCES, createMailbox, defaultMailboxRoot } from './mailbox.js';
import { createMessaging } from './messaging.js';
import { SESSION_ID, orElse, parseJson } from './util.js';
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
