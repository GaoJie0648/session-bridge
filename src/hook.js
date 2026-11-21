#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { defaultHome } from './config.js';
import { createMailbox } from './mailbox.js';
import { createMessaging } from './messaging.js';
import { recordAgySessionMeta } from './providers/agy.js';
import { createDefaultRegistry } from './providers/registry.js';
import { createTaskStore } from './task-store.js';
import { orElse, parseJson, truncate } from './util.js';
import { waitForMessages } from './waiter.js';

const POLL_MS = 2000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;

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

const extractLastReply = async ({ provider, parsed, mailbox, self, forceRead = false }) => {
  if (typeof parsed.lastMessage === 'string' && parsed.lastMessage.trim()) return parsed.lastMessage;
  if (!parsed.transcriptPath) return undefined;
  if (!forceRead && (await mailbox.list(self, 'active')).length === 0) return undefined;
  const entries = await orElse(provider.readEntries, [])(parsed.transcriptPath);
  return entries.findLast((entry) => entry.role === 'assistant')?.text;
};

const sameAddress = (a, b) => a.source === b.source && a.id.toLowerCase() === b.id.toLowerCase();

// 回合結束後仍可能被後續訊息、背景工作或使用者喚醒，新回合開始時改回 running
const markTaskRunning = async ({ taskStore, taskId, matchesTask }) => {
  if (!taskId) return;
  const resumable = (task) => matchesTask(task) && ['completed', 'waiting_background'].includes(task.status);
  if (!resumable(await taskStore.read(taskId))) return;
  await taskStore.update(taskId, (current) => (resumable(current) ? { status: 'running' } : {}));
};

const readPendingBackground = async (provider, transcriptPath) =>
  transcriptPath && provider.readPendingBackground
    ? orElse(provider.readPendingBackground, 0)(transcriptPath)
    : 0;

/** 回報給派工端；這回合的回覆已經轉寄給它時不重複寄送 */
const notifyTaskOwner = async ({ task, self, lastMessage, messaging, forwarded }) => {
  if (!task.from || forwarded.some((to) => sameAddress(to, task.from))) return null;
  try {
    const text = `[任務 ${task.id} 完成] (${self.source} ${self.id})\n${truncate(lastMessage || '（沒有文字回覆）', 7000)}`;
    await messaging.post({ from: self, to: task.from, text, auto: true, expectsReply: false });
    return null;
  } catch (error) {
    return error.message;
  }
};

const recordTaskTurn = async ({ taskStore, task, provider, parsed, self, lastMessage, pendingBackground, notificationError }) => {
  const usage = parsed.transcriptPath && provider.readUsage
    ? await orElse(provider.readUsage, null)(parsed.transcriptPath)
    : null;
  const waiting = pendingBackground > 0;
  await taskStore.update(task.id, (current) => ({
    status: waiting ? 'waiting_background' : 'completed',
    sessions: { ...current.sessions, [self.source]: self.id },
    output: lastMessage ? lastMessage.slice(-20000) : current.output,
    usage: usage ?? current.usage,
    pendingBackground,
    ...(waiting ? {} : { reportedAt: new Date().toISOString(), notificationError }),
  }));
};

const handleStop = async ({ provider, parsed, self, taskId, matchesTask, taskStore, mailbox, messaging, waitOptions }) => {
  const record = taskId ? await orElse(taskStore.read, null)(taskId) : null;
  const task = matchesTask(record) ? record : null;
  const pendingBackground = await readPendingBackground(provider, parsed.transcriptPath);
  const lastMessage = await extractLastReply({ provider, parsed, mailbox, self, forceRead: Boolean(task) });

  // 背景工作還沒跑完時這回合只是中途進度：訊息保持處理中，等最後一回合再轉寄
  const forwarded = pendingBackground > 0 ? [] : await orElse(messaging.onStop, [])({ ...self, lastMessage });
  if (task) {
    await orElse(async () => {
      const notificationError = pendingBackground > 0
        ? null
        : await notifyTaskOwner({ task, self, lastMessage, messaging, forwarded });
      await recordTaskTurn({ taskStore, task, provider, parsed, self, lastMessage, pendingBackground, notificationError });
    })();
  }

  if (!provider.supportsInboxWaiter) {
    const wakeMessages = provider.supportsSyncInboxCheck ? await orElse(messaging.takeNew, [])(self) : [];
    return provider.formatHookOutput({ event: 'Stop', wakeMessages });
  }
  const wakeMessages = await waitForMessages({ messaging, mailbox, address: self, ...waitOptions });
  return provider.formatHookOutput({ event: 'Stop', wakeMessages });
};

const handleSessionStart = async ({ provider, parsed, self, home, taskId, matchesTask, taskStore }) => {
  if (self.source === 'agy' && parsed.cwd) {
    await orElse(recordAgySessionMeta)(self.id, { cwd: parsed.cwd }, home);
  }
  if (taskId) {
    await orElse(async () => {
      const task = await taskStore.read(taskId);
      if (matchesTask(task)) {
        await taskStore.update(taskId, (current) => ({
          status: ['launched', 'waiting_for_workspace_trust'].includes(current.status) ? 'running' : current.status,
          sessions: { ...current.sessions, [self.source]: self.id },
          startupHint: null,
        }));
      }
    })();
  }
  const injectText = `session-bridge：這個 session 的位址是 ${self.source} ${self.id}。要傳訊息給其他 session 時，使用 send_message 並以此作為 from_source 與 from_id。`;
  return provider.formatHookOutput({ event: 'SessionStart', injectText });
};

/** 處理單次 hook 呼叫（抽成純函式以便整合測試） */
export const runHook = async ({
  source,
  rawInput,
  env = process.env,
  home = defaultHome(),
  registry = createDefaultRegistry({ home, env }),
  mailbox = createMailbox(home),
  taskStore = createTaskStore(home),
  messaging = createMessaging({ mailbox, registry }),
  isAbandoned = parentGone,
  sleep = () => new Promise((resolve) => setTimeout(resolve, POLL_MS)),
  maxPolls = MAX_WAIT_MS / POLL_MS,
}) => {
  if (!registry.has(source)) return { stdout: '', stderr: '', exitCode: 0 };
  const provider = registry.get(source);
  const parsed = provider.parseHookInput(rawInput);
  if (!registry.isValidSessionId(source, parsed.sessionId)) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  const self = { source, id: parsed.sessionId };
  const taskId = env.SESSION_BRIDGE_TASK_ID;
  const runId = env.SESSION_BRIDGE_TASK_RUN_ID ?? null;
  const matchesTask = (task) => task && task.provider === source && task.executionMode !== 'managed'
    && (task.runId ?? null) === runId;
  const taskContext = { taskStore, taskId, matchesTask };

  if (parsed.event === 'SessionStart') {
    return handleSessionStart({ provider, parsed, self, home, ...taskContext });
  }

  if (parsed.event === 'UserPromptSubmit') {
    await orElse(messaging.onPromptSubmit)({ ...self, prompt: parsed.prompt });
    await orElse(markTaskRunning)(taskContext);
    return provider.formatHookOutput({ event: 'UserPromptSubmit' });
  }

  if (parsed.event === 'PreInvocation') {
    await orElse(markTaskRunning)(taskContext);
    if (!provider.supportsSyncInboxCheck) {
      return provider.formatHookOutput({ event: 'PreInvocation' });
    }
    const wakeMessages = await orElse(messaging.takeNew, [])(self);
    return provider.formatHookOutput({ event: 'PreInvocation', wakeMessages });
  }

  if (parsed.event === 'Stop') {
    return handleStop({
      provider, parsed, self, mailbox, messaging, ...taskContext,
      waitOptions: { isAbandoned, sleep, maxPolls },
    });
  }

  return provider.formatHookOutput({ event: parsed.event });
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const source = process.argv[2];
  readStdin()
    .then((rawInput) => runHook({ source, rawInput }))
    .then(({ stdout, stderr, exitCode }) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      process.exitCode = exitCode ?? 0;
    })
    .catch((error) => {
      process.stderr.write(`[session-bridge] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
