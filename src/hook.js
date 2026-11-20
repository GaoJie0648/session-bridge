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

  if (parsed.event === 'SessionStart') {
    if (source === 'agy' && parsed.cwd) {
      await orElse(recordAgySessionMeta)(self.id, { cwd: parsed.cwd }, home);
    }
    if (taskId) {
      await orElse(async () => {
        await taskStore.update(taskId, (current) => ({
          status: current.status === 'launched' ? 'running' : current.status,
          sessions: { ...current.sessions, [source]: self.id },
        }));
      })();
    }
    const injectText = `session-bridge：這個 session 的位址是 ${source} ${self.id}。要傳訊息給其他 session 時，使用 send_message 並以此作為 from_source 與 from_id。`;
    return provider.formatHookOutput({ event: 'SessionStart', injectText });
  }

  if (parsed.event === 'UserPromptSubmit') {
    await orElse(messaging.onPromptSubmit)({ ...self, prompt: parsed.prompt });
    return provider.formatHookOutput({ event: 'UserPromptSubmit' });
  }

  if (parsed.event === 'PreInvocation') {
    if (!provider.supportsSyncInboxCheck) {
      return provider.formatHookOutput({ event: 'PreInvocation' });
    }
    const wakeMessages = await orElse(messaging.takeNew, [])(self);
    return provider.formatHookOutput({ event: 'PreInvocation', wakeMessages });
  }

  if (parsed.event === 'Stop') {
    const task = taskId ? await orElse(taskStore.read, null)(taskId) : null;
    const shouldReportTask = Boolean(task && !task.reportedAt);
    const lastMessage = await extractLastReply({
      provider,
      parsed,
      mailbox,
      self,
      forceRead: shouldReportTask,
    });

    // 若此終端是由 start_task / resume_task 啟動，於首輪完成時回寫結果、用量並通知發起端
    if (task) {
      await orElse(async () => {
        const usage = parsed.transcriptPath && provider.readUsage
          ? await orElse(provider.readUsage, null)(parsed.transcriptPath)
          : null;
        let notificationError = task.notificationError;
        if (shouldReportTask && task.from) {
          try {
            const reportText = `[任務 ${task.id} 完成] (${source} ${self.id})\n${truncate(lastMessage || '（沒有文字回覆）', 7000)}`;
            await messaging.post({ from: self, to: task.from, text: reportText, auto: true, expectsReply: false });
            notificationError = null;
          } catch (error) {
            notificationError = error.message;
          }
        }
        await taskStore.update(task.id, (current) => ({
          status: 'completed',
          sessions: { ...current.sessions, [source]: self.id },
          output: lastMessage ? lastMessage.slice(-20000) : current.output,
          usage: usage ?? current.usage,
          reportedAt: current.reportedAt ?? new Date().toISOString(),
          notificationError,
        }));
      })();
    }

    await orElse(messaging.onStop)({ ...self, lastMessage });

    if (!provider.supportsInboxWaiter) {
      const wakeMessages = provider.supportsSyncInboxCheck ? await orElse(messaging.takeNew, [])(self) : [];
      return provider.formatHookOutput({ event: 'Stop', wakeMessages });
    }
    const wakeMessages = await waitForMessages({
      messaging,
      mailbox,
      address: self,
      isAbandoned,
      sleep,
      maxPolls,
    });
    return provider.formatHookOutput({ event: 'Stop', wakeMessages });
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
