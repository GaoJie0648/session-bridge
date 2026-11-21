import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createMailbox } from './mailbox.js';
import { createMessaging } from './messaging.js';
import { openManagedRpc, UserActionRequired } from './managed-rpc.js';
import { runAgyTurn, runCodexTurn } from './managed-providers.js';
import { recordAgySessionMeta } from './providers/agy.js';
import { createDefaultRegistry } from './providers/registry.js';
import { createTaskStore } from './task-store.js';
import { atomicJson, logError, readJsonOr, truncate } from './util.js';

const workerFile = fileURLToPath(import.meta.url);
const serverFile = fileURLToPath(new URL('./server.js', import.meta.url));
const requestFile = (store, id) => path.join(store.dir(id), 'managed-launch.json');
export const isActive = (task) => ['launched', 'running'].includes(task.status);

/** 只核准設定允許的工具類型，且只選 allow_once，不替使用者永久放行 */
export const permissionApprover = (kinds) => (params) => {
  if (!kinds?.length) return null;
  if (!kinds.includes(params?.toolCall?.kind ?? 'other')) return null;
  const options = Array.isArray(params?.options) ? params.options : [];
  return options.find((option) => option?.kind === 'allow_once')?.optionId ?? null;
};

const resumeHint = (id) => `可呼叫 resume_task(id="${id}", execution_mode="terminal") 在原生終端接續同一個 session 並手動確認；或在 ~/.session-bridge/config.json 的 managed.autoApprove 設定可自動核准的工具類型。`;

export const launchManaged = async ({ store, task, prompt, resumeSessionId, spawnFn = spawn }) => {
  await atomicJson(requestFile(store, task.id), { runId: task.runId, prompt, resumeSessionId });
  const child = spawnFn(process.execPath, [workerFile, task.id, task.runId], {
    cwd: task.cwd,
    env: { ...process.env, SESSION_BRIDGE_HOME: store.root },
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
};

export const managedWorkerExited = (task) => {
  if (!Number.isSafeInteger(task.managedPid) || task.managedPid < 1) {
    return Date.now() - Date.parse(task.updatedAt) > 60_000;
  }
  try {
    process.kill(task.managedPid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};

export const runManagedTask = async ({
  id,
  runId,
  store = createTaskStore(),
  registry = createDefaultRegistry({ home: store.root }),
  messaging = createMessaging({ mailbox: createMailbox(store.root), registry }),
  connect = openManagedRpc,
  env = process.env,
}) => {
  const task = await store.read(id);
  const request = await readJsonOr(requestFile(store, id));
  if (task.runId !== runId || request?.runId !== runId || task.executionMode !== 'managed' || !isActive(task)) return;
  await store.update(id, { managedPid: process.pid });
  const provider = registry.get(task.provider);
  const providerEnv = { ...env, SESSION_BRIDGE_HOME: store.root };
  delete providerEnv.SESSION_BRIDGE_TASK_ID;
  delete providerEnv.SESSION_BRIDGE_TASK_RUN_ID;

  let self;
  let rpc;
  let result;
  let failure;
  try {
    const spec = provider.buildManagedSpec();
    const runTurn = spec.kind === 'acp' ? runAgyTurn : runCodexTurn;
    rpc = connect(spec, { cwd: task.cwd, env: providerEnv, approve: permissionApprover(task.autoApprove) });
    result = await runTurn(rpc, {
      task,
      resumeSessionId: request.resumeSessionId,
      mcpServers: [{
        name: 'session-bridge', command: process.execPath, args: [serverFile],
        env: [{ name: 'SESSION_BRIDGE_HOME', value: store.root }],
      }],
      bindSession: async (sessionId) => {
        if (!registry.isValidSessionId(task.provider, sessionId)) throw new Error('未收到有效的原生 session ID。');
        self = { source: task.provider, id: sessionId };
        await store.update(id, { status: 'running', sessions: { ...task.sessions, [task.provider]: sessionId } });
        if (task.provider === 'agy') await recordAgySessionMeta(sessionId, { cwd: task.cwd }, store.root);
      },
      preparePrompt: async () => {
        if (task.provider !== 'agy') return request.prompt;
        const waiting = await messaging.takeNew(self);
        return [request.prompt, ...waiting].join('\n\n');
      },
    });
  } catch (error) {
    const needsUser = error instanceof UserActionRequired;
    failure = {
      status: needsUser ? 'needs_user_action' : 'failed',
      error: needsUser
        ? `${truncate(error.message, 1000)}\n${resumeHint(id)}`
        : truncate(error.message, 1000),
    };
  } finally {
    rpc?.close();
  }

  const notificationErrors = [];
  if (task.from && self) {
    const summary = failure
      ? (failure.status === 'needs_user_action' ? '需要使用者確認' : '失敗')
      : '完成';
    try {
      await messaging.post({
        from: self, to: task.from, auto: true, expectsReply: false,
        text: `[任務 ${id} ${summary}] (${self.source} ${self.id})\n${truncate(failure?.error || result?.output || '（沒有文字回覆）', 7000)}`,
      });
    } catch (error) {
      notificationErrors.push(error.message);
    }
  }
  if (!failure && task.provider === 'agy') {
    try {
      await messaging.onStop({ ...self, lastMessage: result.output });
    } catch (error) {
      notificationErrors.push(error.message);
    }
  }
  await store.update(id, {
    ...(failure ?? { status: 'completed', output: result?.output, usage: result?.usage }),
    reportedAt: new Date().toISOString(),
    notificationError: notificationErrors.join('\n') || null,
    managedPid: null,
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runManagedTask({ id: process.argv[2], runId: process.argv[3] }).catch((error) => {
    logError(error);
    process.exitCode = 1;
  });
}
