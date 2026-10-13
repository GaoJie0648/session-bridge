import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultMailboxRoot } from './mailbox.js';
import { SESSION_ID } from './util.js';

export const PROVIDERS = ['codex', 'claude'];
export const AUTO_KINDS = ['command', 'file', 'tool', 'permissions'];
export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
export const atomicJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
};
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const entries = async (dir) => fs.readdir(dir).catch((error) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});

// Only the worker writes task.json. Other processes submit immutable commands.
export const createTaskStore = (root = defaultMailboxRoot()) => {
  const tasksRoot = path.join(root, 'tasks');
  const dir = (id) => {
    if (!SESSION_ID.test(id)) throw new Error('無效的 task id');
    return path.join(tasksRoot, id.toLowerCase());
  };
  const read = (id) => readJson(path.join(dir(id), 'task.json'));
  const write = (task) => atomicJson(path.join(dir(task.id), 'task.json'), task);
  const create = async ({ provider, cwd, prompt, from, autoRetry = true, fallback }) => {
    if (!PROVIDERS.includes(provider)) throw new Error('provider 必須是 codex 或 claude');
    if (fallback && (!PROVIDERS.includes(fallback) || fallback === provider)) throw new Error('fallback 必須是另一個 provider');
    if (!path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) throw new Error('cwd 必須是存在的絕對目錄');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new Error('任務內容必須為 1–32000 字');
    if (from && (!PROVIDERS.includes(from.source) || !SESSION_ID.test(from.id))) throw new Error('無效的回報位址');
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(), provider, cwd: await fs.realpath(cwd), prompt, from,
      autoRetry, fallback, fallbackUsed: false, retries: 0, attempts: 0,
      status: 'queued', sessions: {}, approvals: [], events: [], output: '',
      automode: null, createdAt: now, updatedAt: now,
    };
    await write(task);
    return task;
  };
  const list = async () => {
    const tasks = await Promise.all((await entries(tasksRoot)).filter((id) => SESSION_ID.test(id)).map(read));
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
  const submit = async (id, action) => {
    await read(id);
    const command = { ...action, id: `${Date.now()}-${randomUUID()}`, submittedAt: Date.now() };
    await atomicJson(path.join(dir(id), 'commands', `${command.id}.json`), command);
    return command.id;
  };
  const commands = async (id) => Promise.all((await entries(path.join(dir(id), 'commands')))
    .filter((name) => name.endsWith('.json')).sort()
    .map((name) => readJson(path.join(dir(id), 'commands', name))));
  const receipt = (id, commandId) => readJson(path.join(dir(id), 'receipts', `${commandId}.json`));
  const acknowledge = async (id, command, result) => {
    await atomicJson(path.join(dir(id), 'receipts', `${command.id}.json`), { ...result, at: new Date().toISOString() });
    await fs.unlink(path.join(dir(id), 'commands', `${command.id}.json`));
  };
  const beginCommand = (id, command) => atomicJson(path.join(dir(id), 'receipts', `${command.id}.json`), {
    ok: null, processing: true, at: new Date().toISOString(),
  });
  const claim = async (id) => {
    const lock = path.join(dir(id), 'worker.lock');
    try { await fs.mkdir(lock); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A process creating the directory gets time to publish its PID.
      const owner = await readJson(path.join(lock, 'owner.json')).catch(() => null);
      if (owner ? alive(owner.pid) : Date.now() - (await fs.stat(lock)).mtimeMs < 30000) return null;
      // Serialize stale-lock recovery. Never rename a replacement worker's
      // live lock after observing an older dead owner.
      const recovery = path.join(dir(id), 'recovery.lock');
      let guard;
      try { guard = await fs.open(recovery, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await readJson(recovery).catch(() => null);
        const stat = await fs.stat(recovery).catch(() => null);
        if ((!previous || !alive(previous.pid)) && stat && Date.now() - stat.mtimeMs > 30000) {
          await fs.unlink(recovery).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
        return null;
      }
      try {
        await guard.writeFile(JSON.stringify({ pid: process.pid }));
        const latest = await readJson(path.join(lock, 'owner.json')).catch(() => null);
        if (latest && alive(latest.pid)) return null;
        const stat = await fs.stat(lock).catch(() => null);
        if (!latest && stat && Date.now() - stat.mtimeMs < 30000) return null;
        try {
          await fs.rename(lock, `${lock}.stale-${randomUUID()}`);
          await fs.mkdir(lock);
        } catch (error) {
          if (['ENOENT', 'EEXIST', 'EPERM'].includes(error.code)) return null;
          throw error;
        }
      } finally { await guard.close(); await fs.unlink(recovery); }
    }
    const owner = { pid: process.pid, token: randomUUID() };
    await atomicJson(path.join(lock, 'owner.json'), owner);
    return async () => {
      const current = await readJson(path.join(lock, 'owner.json')).catch(() => null);
      if (current?.token === owner.token) {
        await fs.unlink(path.join(lock, 'owner.json'));
        await fs.rmdir(lock);
      }
    };
  };
  return { root, dir, create, read, write, list, submit, commands, beginCommand, acknowledge, receipt, claim };
};
