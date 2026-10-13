import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const run = promisify(execFile);
export const spawnAgent = (command, args, options = {}) => spawn(command, args, {
  ...options, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
});

export const stopProcess = async (child) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      await run(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch((error) => {
        if (child.exitCode === null && child.signalCode === null) throw error;
      });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (let n = 0; n < 100 && child.exitCode === null && child.signalCode === null; n += 1) await sleep(50);
    if (child.exitCode === null && child.signalCode === null) throw new Error('行程仍在執行');
  } catch (error) { throw Object.assign(new Error(`無法確認 agent 行程 ${child.pid} 已停止：${error.message}`), { code: 'STOP_FAILED' }); }
};

// Background tasks are already managed by the worker; inherited bridge Stop
// hooks must not create six-hour waiters or duplicate completion reports.
export const agentEnvironment = () => {
  const env = { ...process.env, SESSION_BRIDGE_MANAGED: '1' };
  delete env.CLAUDECODE;
  return env;
};
