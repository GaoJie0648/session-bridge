import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultHome } from './config.js';
import { SAFE_SESSION_ID, UUID_PATTERN, atomicJson, readJsonOr } from './util.js';

const listDirs = async (dir) =>
  fs.readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

export const createTaskStore = (root = defaultHome()) => {
  const tasksRoot = path.join(root, 'tasks');

  const dir = (id) => {
    if (!UUID_PATTERN.test(String(id ?? ''))) throw new Error('無效的 task id');
    return path.join(tasksRoot, id.toLowerCase());
  };

  const read = async (id) => {
    const task = await readJsonOr(path.join(dir(id), 'task.json'), null);
    if (!task) throw new Error(`找不到任務：${id}`);
    return task;
  };

  const write = (task) => atomicJson(path.join(dir(task.id), 'task.json'), task);

  const create = async ({
    provider,
    cwd,
    prompt,
    model,
    effort,
    terminalMode,
    roomId,
    from,
    validProviders,
  }) => {
    if (validProviders && !validProviders.includes(provider)) {
      throw new Error(`不支援的 provider：${provider}（可用：${validProviders.join('、')}）`);
    }
    if (!path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) {
      throw new Error('cwd 必須是存在的絕對目錄');
    }
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) {
      throw new Error('任務內容必須為 1–32000 字');
    }
    if (from && (!SAFE_SESSION_ID.test(from.id) || (validProviders && !validProviders.includes(from.source)))) {
      throw new Error('無效的回報位址');
    }
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(),
      provider,
      cwd: await fs.realpath(cwd),
      prompt,
      model: model ?? null,
      effort: effort ?? null,
      terminalMode: terminalMode ?? 'tab',
      from: from ?? null,
      ...(roomId ? { roomId } : {}),
      status: 'launched',
      sessions: {},
      launcher: null,
      output: '',
      usage: null,
      reportedAt: null,
      notificationError: null,
      createdAt: now,
      updatedAt: now,
    };
    await write(task);
    return task;
  };

  const update = async (id, patch) => {
    const current = await read(id);
    const next = {
      ...current,
      ...(typeof patch === 'function' ? patch(current) : patch),
      updatedAt: new Date().toISOString(),
    };
    await write(next);
    return next;
  };

  const list = async () => {
    const ids = (await listDirs(tasksRoot)).filter((id) => UUID_PATTERN.test(id));
    const tasks = await Promise.all(
      ids.map((id) => readJsonOr(path.join(tasksRoot, id, 'task.json'), null).catch(() => null)),
    );
    return tasks.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };

  return { root, tasksRoot, dir, create, read, write, update, list };
};
