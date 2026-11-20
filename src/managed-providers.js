import { TURN_TIMEOUT } from './managed-rpc.js';

const clientInfo = { name: 'session_bridge', title: 'Session Bridge', version: '0.3.0' };

export const runCodexTurn = async (rpc, { task, resumeSessionId, bindSession, preparePrompt }) => {
  await rpc.request('initialize', { clientInfo });
  rpc.notify('initialized', {});
  const thread = await rpc.request(resumeSessionId ? 'thread/resume' : 'thread/start', {
    cwd: task.cwd,
    ...(resumeSessionId ? { threadId: resumeSessionId, excludeTurns: true } : {}),
    ...(task.model ? { model: task.model } : {}),
  });
  const sessionId = thread.thread?.id;
  await bindSession(sessionId);
  const text = await preparePrompt();

  let output = '';
  let tokens;
  rpc.onNotification((method, params) => {
    if (params?.threadId !== sessionId) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      output = params.item.text?.slice(-20000) ?? output;
    }
    if (method === 'thread/tokenUsage/updated') tokens = params.tokenUsage?.last;
  });
  const [started, completed] = await Promise.all([
    rpc.request('turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(task.model ? { model: task.model } : {}),
      ...(task.effort ? { effort: task.effort } : {}),
    }),
    rpc.waitFor((method, params) => method === 'turn/completed' && params?.threadId === sessionId),
  ]);
  if (completed.turn?.id !== started.turn?.id || completed.turn?.status !== 'completed') {
    throw new Error(completed.turn?.error?.message || `Codex 回合結果：${completed.turn?.status ?? '未知'}`);
  }
  return {
    output,
    usage: tokens ? {
      model: thread.model ?? task.model,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cachedInputTokens,
      reasoningOutputTokens: tokens.reasoningOutputTokens,
      turns: 1,
    } : null,
  };
};

const hasValue = (options, value) => options?.some((option) =>
  option.value === value || hasValue(option.options, value));

export const runAgyTurn = async (rpc, { task, resumeSessionId, bindSession, preparePrompt, mcpServers }) => {
  const response = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo });
  if (response.protocolVersion !== 1) throw new Error('agy ACP 需要支援協議版本 1');
  if (resumeSessionId && !response.agentCapabilities?.loadSession) {
    throw new Error('此版本的 agy ACP 無法載入既有 session，請更新 agy 或選擇前台終端。');
  }
  const session = await rpc.request(resumeSessionId ? 'session/load' : 'session/new', {
    cwd: task.cwd,
    mcpServers,
    ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
  });
  const sessionId = resumeSessionId ?? session.sessionId;
  await bindSession(sessionId);
  let options = session.configOptions;

  const setOption = async (category, value) => {
    if (!value) return;
    const option = options?.find((entry) => entry.category === category || entry.id === category);
    if (!hasValue(option?.options, value)) {
      if (category === 'model' && session.models?.availableModels?.some((model) => model.modelId === value)) {
        await rpc.request('session/set_model', { sessionId, modelId: value });
        return;
      }
      throw new Error(`此 agy ACP session 不支援 ${category}=${value}，請選擇它支援的值或使用前台終端。`);
    }
    if (option.currentValue !== value) {
      const result = await rpc.request('session/set_config_option', { sessionId, configId: option.id, value });
      options = result.configOptions ?? options;
    }
  };
  await setOption('model', task.model);
  await setOption('thought_level', task.effort);
  const text = await preparePrompt();

  let output = '';
  rpc.onNotification((method, params) => {
    if (method !== 'session/update' || params?.sessionId !== sessionId) return;
    const update = params.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      output = `${output}${update.content.text}`.slice(-20000);
    }
  });
  const result = await rpc.request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text }],
  }, TURN_TIMEOUT);
  if (result.stopReason !== 'end_turn') throw new Error(`agy 回合結果：${result.stopReason ?? '未知'}`);
  return { output, usage: result.usage ?? null };
};
