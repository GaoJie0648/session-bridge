import { query } from '@anthropic-ai/claude-agent-sdk';
import { agentEnvironment, spawnAgent, stopProcess } from './processes.js';

export const claudeApprovalKind = (name) => {
  if (['AskUserQuestion', 'ExitPlanMode'].includes(name)) return 'input';
  if (['Bash', 'PowerShell'].includes(name)) return 'command';
  if (['Edit', 'Write', 'NotebookEdit'].includes(name)) return 'file';
  return 'tool';
};

export const runClaude = async (task, context, { createQuery = query } = {}) => {
  let child;
  let quota;
  let result;
  let output = '';
  let registration = Promise.resolve();
  let stopping;
  let stopError;
  const controller = new AbortController();
  const abort = () => {
    stopping = stopProcess(child).catch((error) => { stopError = error; }).finally(() => controller.abort());
  };
  context.signal.addEventListener('abort', abort, { once: true });
  if (context.signal.aborted) controller.abort();
  const conversation = createQuery({
    prompt: context.prompt,
    options: {
      cwd: task.cwd, resume: task.sessions.claude, abortController: controller,
      permissionMode: 'default', permissionPrompts: 'host',
      settingSources: ['user', 'project', 'local'],
      env: agentEnvironment(),
      ...(process.env.SESSION_BRIDGE_CLAUDE ? { pathToClaudeCodeExecutable: process.env.SESSION_BRIDGE_CLAUDE } : {}),
      spawnClaudeCodeProcess: (options) => {
        child = spawnAgent(options.command, options.args, { cwd: options.cwd, env: options.env });
        if (child.pid) registration = context.event({ type: 'process', pid: child.pid });
        return child;
      },
      canUseTool: async (name, input, options) => {
        const kind = claudeApprovalKind(name);
        const response = await context.approve({ kind, method: name, requestId: options.toolUseID,
          details: { tool: name, input, reason: options.decisionReason },
          manualOnly: /organization requires approval/i.test(options.decisionReason ?? ''),
        }, options.signal);
        if (response.decision !== 'approve') return { behavior: 'deny', message: '使用者或 bridge 拒絕此操作' };
        // Answers extend the original input; they cannot change the approved tool.
        return { behavior: 'allow', updatedInput: kind === 'input' ? { ...input, ...response.answer } : input };
      },
      onElicitation: async (request, options) => {
        const response = await context.approve({ kind: 'input', method: 'elicitation', requestId: options.requestId, details: request }, options.signal);
        return response.decision === 'approve' ? response.answer : { action: 'decline' };
      },
      // Unknown native dialog kinds have no renderer here. The SDK contract
      // requires cancellation, rather than leaving the agent parked forever.
      onUserDialog: async (request) => {
        await context.event({ type: 'unsupported_dialog', value: request });
        return { behavior: 'cancelled' };
      },
    },
  });
  try {
    await registration;
    for await (const message of conversation) {
      if (message.session_id && task.sessions.claude !== message.session_id) await context.event({ type: 'session', id: message.session_id });
      if (message.type === 'assistant') {
        for (const block of message.message.content ?? []) {
          if (block.type === 'text') { output = block.text; await context.event({ type: 'text', text: output }); }
          if (block.type === 'tool_use') await context.event({ type: 'operation', item: block });
        }
      }
      if (message.type === 'user') {
        for (const block of Array.isArray(message.message.content) ? message.message.content : []) {
          if (block.type === 'tool_result') await context.event({ type: 'operation', item: block });
        }
      }
      if (message.type === 'rate_limit_event') { quota = message.rate_limit_info; await context.event({ type: 'quota', value: quota }); }
      if (message.type === 'result') { result = message; break; }
    }
    if (!result) throw new Error('Claude 未回傳任務結束事件');
    return {
      status: result.subtype === 'success' && !result.is_error ? 'completed' : 'failed',
      output: result.result ?? output, quota,
      error: result.is_error ? { message: (result.errors ?? [result.result ?? result.subtype]).join('\n'), quota } : undefined,
    };
  } finally {
    context.signal.removeEventListener('abort', abort);
    try {
      await stopping;
      if (stopError) throw stopError;
      await stopProcess(child);
      if (child?.pid) await context.event({ type: 'process', pid: null });
    } finally { conversation.close(); }
  }
};
