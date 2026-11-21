import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { parseJson } from './util.js';

const START_TIMEOUT = 45_000;
export const TURN_TIMEOUT = 30 * 60_000;

export class UserActionRequired extends Error {}

export const openManagedRpc = ({ executable, args, kind }, { cwd, env, spawnFn = spawn, approve = () => null }) => {
  const child = spawnFn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = new Map();
  const listeners = new Set();
  const waiters = new Set();
  let nextId = 0;
  let failure;

  const send = (message) => child.stdin.write(`${JSON.stringify({
    ...(kind === 'acp' ? { jsonrpc: '2.0' } : {}), ...message,
  })}\n`);

  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const pending of [...replies.values(), ...waiters]) pending.reject(error);
  };

  const track = (description, timeout, register) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const finish = (settle, value) => {
      clearTimeout(timer);
      unregister();
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`${description} 逾時`)), timeout);
    const unregister = register({
      resolve: (value) => finish(resolve, value),
      reject: (error) => finish(reject, error),
    });
  });

  child.stderr.resume();
  child.once('error', fail);
  child.once('close', (code) => fail(new Error(`${kind} 程序已結束（代碼 ${code ?? '未知'}）`)));
  child.stdin.on('error', fail);

  lines.on('line', (line) => {
    const message = parseJson(line);
    if (!message) return;
    const { id, method, params, result, error } = message;
    if (method && id != null) {
      const approvedOption = method === 'session/request_permission' ? approve(params) : null;
      if (approvedOption) {
        send({ id, result: { outcome: { outcome: 'selected', optionId: approvedOption } } });
        return;
      }
      const requiresUser = /requestApproval|requestUserInput|elicitation\/request|session\/request_permission/.test(method);
      const response = method === 'session/request_permission'
        ? { result: { outcome: { outcome: 'cancelled' } } }
        : { error: { code: requiresUser ? -32000 : -32601, message: 'Request requires an interactive client' } };
      send({ id, ...response });
      if (requiresUser) fail(new UserActionRequired(`${method} 需要使用者確認。`));
      return;
    }
    if (method) {
      for (const listener of listeners) listener(method, params);
      for (const waiter of waiters) {
        if (waiter.matches(method, params)) waiter.resolve(params);
      }
      return;
    }
    const pending = replies.get(id);
    if (error) {
      const message = String(error.message || '未知錯誤').slice(0, 1000);
      const needsAuth = (kind === 'acp' && error.code === -32000 && /auth/i.test(message))
        || /authentication required|not authenticated|not logged in|login required/i.test(message);
      pending?.reject(needsAuth ? new UserActionRequired(message) : new Error(message));
    } else {
      pending?.resolve(result);
    }
  });

  return {
    request(method, params, timeout = START_TIMEOUT) {
      const id = ++nextId;
      return track(method, timeout, (pending) => {
        replies.set(id, pending);
        send({ id, method, params });
        return () => replies.delete(id);
      });
    },
    notify(method, params) { send({ method, params }); },
    onNotification(listener) { listeners.add(listener); },
    waitFor(matches, timeout = TURN_TIMEOUT) {
      return track('等待回合完成', timeout, (pending) => {
        const waiter = { ...pending, matches };
        waiters.add(waiter);
        return () => waiters.delete(waiter);
      });
    },
    close() {
      lines.close();
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    },
  };
};
