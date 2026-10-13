import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { runCodex, codexDecision } from '../src/codex-agent.js';
import { runClaude } from '../src/claude-agent.js';

const contextFor = (task) => {
  const events = [];
  return { events, prompt: 'hello', signal: new AbortController().signal,
    approve: async () => ({ decision: 'approve' }), invalidate: async () => {},
    event: async (event) => { events.push(event); if (event.type === 'session') task.sessions[task.provider] = event.id; },
  };
};

test('Codex initializes, starts, relays approval and completes over JSON-RPC', async () => {
  const task = { provider: 'codex', cwd: process.cwd(), sessions: {} };
  const context = contextFor(task);
  const sent = [];
  let approval;
  context.approve = async (request) => { approval = request; return { decision: 'approve' }; };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({ write(chunk, _, done) {
      const message = JSON.parse(chunk.toString()); sent.push(message);
      queueMicrotask(() => {
        if (message.method === 'initialize') emit({ id: message.id, result: {} });
        if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'native-thread' } } });
        if (message.method === 'account/rateLimits/read') emit({ id: message.id, result: {} });
        if (message.method === 'turn/start') {
          emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
          emit({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-thread', command: 'npm test' } });
        }
        if (message.id === 'approval-1') {
          emit({ method: 'item/completed', params: { threadId: 'native-thread', item: { type: 'agentMessage', text: 'done', phase: 'final_answer' } } });
          emit({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } });
        }
      });
      done();
    } });
    return child;
  };
  const result = await runCodex(task, context, { spawn, command: ['mock'] });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
  assert.equal(approval.kind, 'command');
  assert.equal(approval.requestId, 'approval-1');
  assert.equal(sent.find((m) => m.method === 'thread/start').params.approvalPolicy, 'on-request');
  assert.equal(sent.find((m) => m.id === 'approval-1').result.decision, 'accept');
});

test('Codex returns only requested permissions with turn scope and rejects unsupported answers', () => {
  assert.deepEqual(codexDecision('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, { decision: 'approve' }), {
    permissions: { network: { enabled: true } }, scope: 'turn',
  });
  assert.deepEqual(codexDecision('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, { decision: 'deny' }), { permissions: {}, scope: 'turn' });
  assert.deepEqual(codexDecision('mcpServer/elicitation/request', {}, { decision: 'deny' }), { action: 'decline', content: null });
});

test('Claude SDK receives permissions callback, resume id, events and user answers', async () => {
  const task = { provider: 'claude', cwd: process.cwd(), sessions: { claude: 'existing' } };
  const context = contextFor(task);
  const approvals = [];
  context.approve = async (request) => { approvals.push(request); return { decision: 'approve', answer: { answers: { 'Which?': 'A' } } }; };
  let closed = false;
  const createQuery = ({ options }) => {
    assert.equal(options.permissionMode, 'default');
    assert.equal(options.resume, 'existing');
    assert.equal(options.env.SESSION_BRIDGE_MANAGED, '1');
    const generator = (async function* () {
      const result = await options.canUseTool('Bash', { command: 'npm test' }, { toolUseID: 'tool-1' });
      assert.deepEqual(result, { behavior: 'allow', updatedInput: { command: 'npm test' } });
      const answer = await options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?' }] }, { toolUseID: 'tool-2' });
      assert.deepEqual(answer.updatedInput.answers, { 'Which?': 'A' });
      yield { type: 'assistant', session_id: 'existing', message: { content: [{ type: 'text', text: 'progress' }, { type: 'tool_use', name: 'Read', input: {} }] } };
      yield { type: 'rate_limit_event', session_id: 'existing', rate_limit_info: { status: 'allowed', resetsAt: 123 } };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'done' };
    })();
    generator.close = () => { closed = true; };
    return generator;
  };
  const result = await runClaude(task, context, { createQuery });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
  assert.equal(approvals[0].kind, 'command');
  assert.equal(approvals[1].kind, 'input');
  assert.ok(context.events.some((event) => event.type === 'operation'));
  assert.equal(closed, true);
});

test('Claude failure is not marked complete and denied requests stay denied', async () => {
  const task = { provider: 'claude', cwd: process.cwd(), sessions: {} };
  const context = contextFor(task);
  context.approve = async () => ({ decision: 'deny' });
  const createQuery = ({ options }) => {
    const generator = (async function* () {
      assert.equal((await options.canUseTool('Write', {}, {})).behavior, 'deny');
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 123 } };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['limit reached'] };
    })();
    generator.close = () => {};
    return generator;
  };
  const result = await runClaude(task, context, { createQuery });
  assert.equal(result.status, 'failed');
  assert.equal(result.quota.status, 'rejected');
});
