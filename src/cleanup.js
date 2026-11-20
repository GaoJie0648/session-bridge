import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultHome, loadConfig } from './config.js';
import { createRooms } from './rooms.js';
import { atomicJson, readJsonOr } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_PRUNE_INTERVAL_MS = DAY_MS;

const listEntries = async (dir) =>
  fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

const sentAtOf = (name) => Number(name.split('-')[0]);

/**
 * 清理過期任務、過期已完成訊息與殘留的空信箱目錄
 */
export const pruneStorage = async ({
  home = defaultHome(),
  tasksDays = 14,
  doneMessagesDays = 7,
  roomsDays,
  now = Date.now(),
} = {}) => {
  if (roomsDays !== undefined && (!Number.isSafeInteger(roomsDays) || roomsDays < 1)) {
    throw new Error('房間保留天數須為正整數');
  }
  const stats = { tasksRemoved: 0, messagesRemoved: 0, mailboxesRemoved: 0 };
  const taskCutoff = now - tasksDays * DAY_MS;
  const msgCutoff = now - doneMessagesDays * DAY_MS;

  // 1. 清理過期任務（只清理已完成的任務，或遠超期限的閒置任務）
  const tasksRoot = path.join(home, 'tasks');
  for (const entry of await listEntries(tasksRoot)) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(tasksRoot, entry.name);
    const task = await readJsonOr(path.join(dir, 'task.json'), null).catch(() => null);
    const stat = await fs.stat(dir).catch(() => null);
    const updatedMs = task?.updatedAt ? Date.parse(task.updatedAt) : stat?.mtimeMs ?? now;
    if (Number.isFinite(updatedMs) && updatedMs < taskCutoff) {
      await fs.rm(dir, { recursive: true, force: true });
      stats.tasksRemoved += 1;
    }
  }

  // 2. 清理過期 done 訊息與只剩過期 waiter 的空信箱目錄
  const reserved = new Set(['tasks', 'meta', 'rooms', 'config.json', 'cleanup-state.json']);
  for (const entry of await listEntries(home)) {
    if (!entry.isDirectory() || reserved.has(entry.name)) continue;
    const boxDir = path.join(home, entry.name);
    const doneDir = path.join(boxDir, 'done');
    for (const file of await listEntries(doneDir)) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      if (sentAtOf(file.name) < msgCutoff) {
        await fs.unlink(path.join(doneDir, file.name)).catch(() => {});
        stats.messagesRemoved += 1;
      }
    }
    const [newList, activeList, doneList] = await Promise.all([
      listEntries(path.join(boxDir, 'new')),
      listEntries(path.join(boxDir, 'active')),
      listEntries(doneDir),
    ]);
    const hasMessages = newList.length + activeList.length + doneList.length > 0;
    if (!hasMessages) {
      const waiterStat = await fs.stat(path.join(boxDir, 'waiter')).catch(() => null);
      const boxStat = await fs.stat(boxDir).catch(() => null);
      const lastTouched = waiterStat?.mtimeMs ?? boxStat?.mtimeMs ?? now;
      if (lastTouched < msgCutoff) {
        await fs.rm(boxDir, { recursive: true, force: true });
        stats.mailboxesRemoved += 1;
      }
    }
  }

  if (roomsDays !== undefined) stats.roomsRemoved = createRooms({ home }).prune(now - roomsDays * DAY_MS);
  return stats;
};

/** 節流自動清理（預設每 24 小時最多執行一次，失敗不影響主流程） */
export const maybeAutoPrune = async (home = defaultHome(), now = Date.now()) => {
  try {
    const stateFile = path.join(home, 'cleanup-state.json');
    const state = await readJsonOr(stateFile, null);
    if (state?.lastRunAt && now - state.lastRunAt < AUTO_PRUNE_INTERVAL_MS) return null;
    const config = await loadConfig(home);
    const stats = await pruneStorage({
      home,
      tasksDays: config.retention.tasksDays,
      doneMessagesDays: config.retention.doneMessagesDays,
      now,
    });
    await atomicJson(stateFile, { lastRunAt: now, stats });
    return stats;
  } catch {
    return null;
  }
};
