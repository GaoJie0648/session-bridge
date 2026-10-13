import readline from 'node:readline';
import { resolveCodexCommand } from './codex-queue.js';
import { spawnAgent, stopProcess, agentEnvironment } from './processes.js';

export const codexApproval = (method, params) => {
  if (method === 'item/commandExecution/requestApproval') return { kind: 'command', details: params };
  if (method === 'item/fileChange/requestApproval') return { kind: 'file', details: params };
  if (method === 'item/permissions/requestApproval') return { kind: 'permissions', details: params };
  if (['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(method)) return { kind: 'input', details: params };
  return null;
};
export const codexDecision = (method, params, { decision, answer }) => {
  const approved = decision === 'approve';
  if (method === 'item/permissions/requestApproval') return { permissions: approved ? params.permissions : {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return approved ? answer : { answers: {} };
  if (method === 'mcpServer/elicitation/request') return approved ? answer : { action: 'decline', content: null };
  return { decision: approved ? 'accept' : 'decline' };
};

// JSON-RPC over stdio. Approval requests must not block notification processing.
export const runCodex = async (task, context, { spawn = spawnAgent, command = resolveCodexCommand() } = {}) => {
  const [executable, ...prefix] = command;
  const child = spawn(executable, [...prefix, 'app-server', '--listen', 'stdio://'], { cwd: task.cwd, env: agentEnvironment() });
  const requests = new Map();
  const approvals = new Map();
  let counter = 0;
  let events = Promise.resolve();
  let stderr = '';
  let stopped = false;
  let threadId;
  let turnId;
  let finalText = '';
  let quota;
  let complete;
  let fail;
  const completed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  completed.catch(() => {});
  const send = (message) => {
    if (!stopped && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Codex ${method} 逾時`)); }, 30000);
    requests.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
  const broken = (error) => {
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    requests.clear();
    fail(error);
  };
  child.on('error', broken);
  child.stdin.on('error', broken);
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  child.on('close', (code) => {
    if (!stopped) broken(new Error(`Codex 行程結束 (${code})：${stderr}`));
  });
  const input = readline.createInterface({ input: child.stdout });
  input.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { broken(new Error('Codex 回傳了無效的 JSON-RPC')); return; }
    if (!message.method && message.id !== undefined) {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { details: message.error }));
      else pending.resolve(message.result);
      return;
    }
    const { method, params = {} } = message;
    if (message.id !== undefined) {
      const approval = codexApproval(method, params);
      if (!approval || (threadId && params.threadId && params.threadId !== threadId)) {
        send({ id: message.id, error: { code: -32601, message: 'Unsupported bridge request' } });
        return;
      }
      const controller = new AbortController();
      approvals.set(message.id, controller);
      void context.approve({ ...approval, requestId: message.id, method,
        manualOnly: Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept'),
      }, controller.signal)
        .then((decision) => { if (!controller.signal.aborted) send({ id: message.id, result: codexDecision(method, params, decision) }); })
        .catch((error) => { send({ id: message.id, result: codexDecision(method, params, { decision: 'deny' }) }); broken(error); })
        .finally(() => approvals.delete(message.id));
      return;
    }
    events = events.then(async () => {
      if (params.threadId && threadId && params.threadId !== threadId) return;
      if (method === 'serverRequest/resolved') {
        approvals.get(params.requestId)?.abort();
        await context.invalidate(params.requestId);
      }
      if (method === 'account/rateLimits/updated') { quota = params; await context.event({ type: 'quota', value: quota }); }
      if (method === 'turn/started') turnId = params.turn.id;
      if (method === 'item/completed' || method === 'item/started') {
        const item = params.item;
        if (item?.type === 'agentMessage' && method === 'item/completed') {
          finalText = item.text ?? '';
          await context.event({ type: 'text', text: finalText });
        } else if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item?.type)) {
          await context.event({ type: 'operation', item });
        }
      }
      if (method === 'turn/diff/updated') await context.event({ type: 'diff', text: params.diff });
      if (method === 'turn/plan/updated') await context.event({ type: 'plan', value: params.plan });
      if (method === 'turn/completed') complete({ status: params.turn.status, error: params.turn.error, output: finalText, quota });
    }).catch(broken);
  });
  const abort = () => {
    if (threadId && turnId) send({ id: ++counter, method: 'turn/interrupt', params: { threadId, turnId } });
    broken(new Error('任務已中止'));
  };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    if (child.pid) await context.event({ type: 'process', pid: child.pid });
    if (context.signal.aborted) throw new Error('任務已中止');
    await rpc('initialize', { clientInfo: { name: 'session_bridge', title: 'Session Bridge', version: '0.2.0' } });
    send({ method: 'initialized' });
    const existing = task.sessions.codex;
    const result = await rpc(existing ? 'thread/resume' : 'thread/start', {
      ...(existing ? { threadId: existing } : {}), cwd: task.cwd,
      approvalPolicy: 'on-request', sandbox: 'workspace-write',
    });
    threadId = result.thread.id;
    await context.event({ type: 'session', id: threadId });
    quota = await rpc('account/rateLimits/read').catch(() => undefined);
    if (quota) await context.event({ type: 'quota', value: quota });
    if (context.signal.aborted) throw new Error('任務已中止');
    const started = await rpc('turn/start', { threadId, input: [{ type: 'text', text: context.prompt }] });
    turnId = started.turn.id;
    return await completed;
  } finally {
    stopped = true;
    context.signal.removeEventListener('abort', abort);
    for (const controller of approvals.values()) controller.abort();
    for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex 連線已關閉')); }
    requests.clear();
    input.close();
    await stopProcess(child);
    await events;
    if (child.pid) await context.event({ type: 'process', pid: null });
  }
};
