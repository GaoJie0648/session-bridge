import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTaskStore, alive, PROVIDERS } from './task-store.js';

const worker = fileURLToPath(new URL('./task-worker.js', import.meta.url));
export const wakeWorker = async (store, id) => {
  const log = await fs.open(path.join(store.dir(id), 'worker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [worker, id], {
      detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      cwd: path.dirname(worker), env: { ...process.env, SESSION_BRIDGE_HOME: store.root },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { await log.close(); }
};

export const taskView = (task) => ({ ...task,
  workerAlive: alive(task.pid),
  control: {
    show: `session-bridge-control show ${task.id}`,
    automode: `session-bridge-control auto ${task.id} on --minutes 60`,
    manual: `session-bridge-control auto ${task.id} off`,
    cancel: `session-bridge-control cancel ${task.id}`,
  },
});

// 只列出還沒結束的任務；已完成、失敗、中斷、取消的不佔畫面
const STATUS_LABELS = {
  queued: '執行中', running: '執行中', cancelling: '執行中',
  waiting_approval: '待審批', waiting_quota: '等額度', recovery_required: '需處理',
};
const LABEL_ORDER = [...new Set(Object.values(STATUS_LABELS))];
export const formatTasks = (tasks) => PROVIDERS.flatMap((provider) => LABEL_ORDER.map((label) => {
  const count = tasks.filter((task) => task.provider === provider && STATUS_LABELS[task.status] === label).length;
  return count ? `${provider} ${label} ${count}` : null;
})).filter(Boolean).join(' · ');

export const createTaskTools = ({ store = createTaskStore(), wake = wakeWorker, defaultCwd = process.cwd() } = {}) => {
  const start = async ({ provider, cwd = defaultCwd, prompt, from_source, from_id, auto_retry = true, fallback_provider }) => {
    if (process.env.SESSION_BRIDGE_MANAGED === '1') throw new Error('背景任務不能再啟動背景任務；請回報原交辦者');
    if (Boolean(from_source) !== Boolean(from_id)) throw new Error('from_source 與 from_id 必須一起提供');
    const task = await store.create({ provider, cwd, prompt, from: from_id ? { source: from_source, id: from_id } : undefined,
      autoRetry: auto_retry, fallback: fallback_provider });
    try { await wake(store, task.id); } catch (error) {
      task.status = 'failed'; task.error = { message: error.message }; await store.write(task); throw error;
    }
    return taskView(task);
  };
  const control = async (id, action) => {
    const commandId = await store.submit(id, action);
    await wake(store, id);
    // Re-wake handles a command arriving just as an idle worker releases its lock.
    for (let i = 0; i < 40; i += 1) {
      const receipt = await store.receipt(id, commandId).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (receipt && !receipt.processing) { if (!receipt.ok) throw new Error(receipt.error); return taskView(await store.read(id)); }
      if (i === 12 || i === 24) await wake(store, id);
      await sleep(250);
    }
    throw new Error(`控制指令尚未確認 (${commandId})；請用 show 檢查狀態與 worker.log，不要假定已執行。`);
  };
  return {
    start,
    get: async ({ id }) => taskView(await store.read(id)),
    list: async ({ cwd = defaultCwd, all = false } = {}) => (await store.list())
      .filter((task) => all || path.resolve(task.cwd) === path.resolve(cwd))
      .map(({ id, provider, status, createdAt, updatedAt, cwd, pid, nextRetryAt }) => ({ id, provider, status, createdAt, updatedAt, cwd, workerAlive: alive(pid), nextRetryAt })),
    resume: ({ id, provider, prompt }) => control(id, { action: 'resume', provider, prompt }),
    cancel: ({ id }) => control(id, { action: 'cancel' }),
    control,
  };
};
