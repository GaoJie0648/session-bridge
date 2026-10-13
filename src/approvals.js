import { randomUUID } from 'node:crypto';
import { AUTO_KINDS } from './task-store.js';

// User input (questions / forms / URLs) is never answered by automode.
export const autoAllows = (policy, request, now = Date.now()) => Boolean(
  !request.manualOnly && policy && policy.expiresAt > now && policy.provider === request.provider &&
  policy.kinds.includes(request.kind) && AUTO_KINDS.includes(request.kind),
);

export const validateAnswer = (request, answer) => {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('此請求需要 answer JSON 物件');
  if (request.method === 'item/tool/requestUserInput') {
    for (const question of request.details.questions ?? []) {
      const values = answer.answers?.[question.id]?.answers;
      if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string')) throw new Error(`問題 ${question.id} 需要 answers 字串陣列`);
    }
  }
  if (request.method === 'AskUserQuestion') {
    for (const question of request.details.input.questions ?? []) {
      if (typeof answer.answers?.[question.question] !== 'string') throw new Error(`請回答：${question.question}`);
    }
  }
  if (['mcpServer/elicitation/request', 'elicitation'].includes(request.method) && !['accept', 'decline', 'cancel'].includes(answer.action)) throw new Error('表單回答需要 action: accept、decline 或 cancel');
};

export const createApprovals = ({ task, save, notify = async () => {}, now = Date.now }) => {
  const pending = new Map();
  const resolve = async (id, decision, answer, actor = 'user') => {
    const live = pending.get(id);
    if (!live) throw new Error('此審批已結束或不屬於目前執行回合');
    if (!['approve', 'deny'].includes(decision)) throw new Error('無效的審批決定');
    if (live.request.kind === 'input' && decision === 'approve') validateAnswer(live.request, answer);
    if (decision === 'approve' && live.request.expiresAt <= now()) throw new Error('此審批已逾時');
    pending.delete(id);
    live.cleanup();
    Object.assign(live.request, { status: decision, actor, resolvedAt: now() });
    if (task.status !== 'cancelling') task.status = pending.size ? 'waiting_approval' : 'running';
    try { await save(); }
    catch (error) { live.finish({ decision: 'deny' }); throw error; }
    live.finish({ decision, answer });
  };
  const request = async (details, signal) => {
    if (signal?.aborted) return { decision: 'deny' };
    const approval = { ...details, id: randomUUID(), provider: task.provider, status: 'pending', createdAt: now(), expiresAt: now() + 60 * 60 * 1000 };
    task.approvals.push(approval);
    // Keep pending requests plus the most recent resolved history.
    task.approvals = task.approvals.filter((a) => a.status === 'pending' || task.approvals.indexOf(a) >= task.approvals.length - 100);
    if (autoAllows(task.automode, approval, now())) {
      Object.assign(approval, { status: 'approve', actor: 'automode', resolvedAt: now() });
      await save();
      return { decision: 'approve' };
    }
    let finish;
    const answer = new Promise((done) => { finish = done; });
    const abort = () => { void resolve(approval.id, 'deny', undefined, 'cancelled').catch(() => {}); };
    pending.set(approval.id, { request: approval, finish, cleanup: () => signal?.removeEventListener('abort', abort) });
    signal?.addEventListener('abort', abort, { once: true });
    task.status = 'waiting_approval';
    await save();
    if (signal?.aborted) abort();
    await notify(`等待${approval.kind === 'input' ? '回答' : '同意'}：${approval.id} (${approval.kind})`);
    return answer;
  };
  const tick = async () => {
    for (const { request: approval } of [...pending.values()]) {
      if (approval.expiresAt <= now()) await resolve(approval.id, 'deny', undefined, 'expired');
      else if (autoAllows(task.automode, approval, now())) await resolve(approval.id, 'approve', undefined, 'automode');
    }
  };
  const close = async () => {
    for (const id of [...pending.keys()]) await resolve(id, 'deny', undefined, 'cancelled');
  };
  const invalidate = async (requestId) => {
    for (const [id, live] of pending) {
      if (live.request.requestId === requestId) await resolve(id, 'deny', undefined, 'provider');
    }
  };
  return { request, resolve, tick, close, invalidate };
};
