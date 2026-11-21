import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { maybeAutoPrune } from './cleanup.js';
import { EXECUTION_MODES, TERMINAL_MODES, loadConfig, resolveAutoApprove, resolveProviderOptions } from './config.js';
import { isActive, launchManaged, managedWorkerExited } from './managed-task.js';
import { verifyHint } from './messaging.js';
import { createDefaultRegistry } from './providers/registry.js';
import { createTaskStore } from './task-store.js';
import { launchInTerminal } from './terminal.js';

/** 組合交辦提示，附上可驗證的來源位址。 */
export const buildTaskPrompt = (task, { isResume = false, extraPrompt } = {}) => {
  const lines = [
    `[session-bridge 任務 ${task.id}] 工作目錄：${task.cwd}`,
  ];
  if (task.from) {
    lines.push(`交辦來源：${task.from.source} ${task.from.id}。${verifyHint(task.from)}`);
  }
  if (isResume) {
    lines.push('這是接續先前的任務。請先確認既有檔案狀態與先前進度，再繼續完成剩餘部分。');
    if (task.output) lines.push(`先前摘要：\n${task.output.slice(-4000)}`);
    if (extraPrompt) lines.push(`後續指示：\n${extraPrompt}`);
  } else {
    lines.push(task.prompt);
  }
  return lines.join('\n\n');
};

const resolveExecution = (provider, executionMode, terminalMode, previousMode) => {
  if (executionMode && !EXECUTION_MODES.includes(executionMode)) throw new Error('無效的 execution_mode');
  if (terminalMode && !TERMINAL_MODES.includes(terminalMode)) throw new Error('無效的 terminal_mode');
  if (terminalMode && executionMode === 'managed') throw new Error('背景執行不接受 terminal_mode');
  const mode = executionMode ?? (terminalMode ? 'terminal' : previousMode)
    ?? (provider.buildManagedSpec ? 'managed' : 'terminal');
  if (mode === 'managed' && !provider.buildManagedSpec) throw new Error(`${provider.displayName} 目前需要使用前台終端。`);
  return mode;
};

const currentTaskState = (task) => task.executionMode === 'managed' && isActive(task) && managedWorkerExited(task)
  ? { ...task, status: 'failed', error: '背景程序在回報之前結束，可用 resume_task 重試。' }
  : task;

export const createTaskTools = ({
  store = createTaskStore(),
  registry = createDefaultRegistry({ home: store.root }),
  launcher = launchInTerminal,
  managedLauncher = launchManaged,
  defaultCwd = process.cwd(),
} = {}) => {
  const launchTask = async (task, { prompt, resumeSessionId } = {}) => {
    const provider = registry.get(task.provider);
    const runId = randomUUID();
    if (task.executionMode === 'managed') {
      const next = await store.update(task.id, { runId, launcher: `managed:${task.provider}`, managedPid: null });
      await managedLauncher({ store, task: next, prompt, resumeSessionId });
      return store.read(task.id);
    }
    const config = await loadConfig(store.root);
    const mode = task.terminalMode ?? config.terminal.mode ?? 'tab';
    const spec = provider.buildLaunchSpec({
      cwd: task.cwd,
      model: task.model,
      effort: task.effort,
      resumeSessionId,
    });
    const title = `bridge:${task.provider} ${task.id.slice(0, 8)}`;
    const trusted = await provider.workspaceTrust?.(task.cwd);
    const startupHint = provider.workspaceTrust && trusted !== true
      ? '如果 Claude Code 顯示 Accessing workspace，請在原生終端確認這個專案目錄。'
      : null;
    await store.update(task.id, {
      runId, startupHint,
      ...(trusted === false ? { status: 'waiting_for_workspace_trust' } : {}),
    });
    const launched = await launcher({
      taskDir: store.dir(task.id),
      cwd: task.cwd,
      title,
      executable: spec.executable,
      args: spec.args,
      prompt,
      promptFlag: spec.promptFlag,
      env: {
        SESSION_BRIDGE_HOME: store.root,
        SESSION_BRIDGE_TASK_ID: task.id,
        SESSION_BRIDGE_TASK_RUN_ID: runId,
        SESSION_BRIDGE_TASK_PROVIDER: task.provider,
        ...(task.from ? {
          SESSION_BRIDGE_FROM_SOURCE: task.from.source,
          SESSION_BRIDGE_FROM_ID: task.from.id,
        } : {}),
      },
      mode,
      splitDirection: config.terminal.splitDirection ?? 'auto',
    });
    return store.update(task.id, { launcher: launched.launcher });
  };

  const start = async ({
    provider,
    cwd = defaultCwd,
    prompt,
    model,
    effort,
    terminal_mode,
    execution_mode,
    auto_approve,
    from_source,
    from_id,
  }) => {
    if (Boolean(from_source) !== Boolean(from_id)) {
      throw new Error('from_source 與 from_id 必須一起提供');
    }
    const executionMode = resolveExecution(registry.get(provider), execution_mode, terminal_mode);
    const config = await loadConfig(store.root);
    const resolved = resolveProviderOptions(config, provider, { model, effort });
    const mode = terminal_mode ?? config.terminal.mode ?? 'tab';

    const task = await store.create({
      provider,
      cwd,
      prompt,
      model: resolved.model,
      effort: resolved.effort,
      terminalMode: mode,
      executionMode,
      autoApprove: resolveAutoApprove(config, auto_approve),
      from: from_id ? { source: from_source, id: from_id } : undefined,
      validProviders: registry.names,
    });
    const fullPrompt = buildTaskPrompt(task);
    try {
      const updated = await launchTask(task, { prompt: fullPrompt });
      await maybeAutoPrune(store.root);
      return updated;
    } catch (error) {
      await store.update(task.id, { status: 'failed', error: error.message });
      throw error;
    }
  };

  const resume = async ({ id, provider, prompt, model, effort, terminal_mode, execution_mode, auto_approve }) => store.withLaunchLock(id, async () => {
    const existing = currentTaskState(await store.read(id));
    if (existing.executionMode === 'managed' && isActive(existing)) throw new Error('背景任務正在執行，完成後才能續接。');
    const nextProvider = provider ?? existing.provider;
    if (!registry.has(nextProvider)) {
      throw new Error(`不支援的 provider：${nextProvider}（可用：${registry.names.join('、')}）`);
    }
    const executionMode = resolveExecution(registry.get(nextProvider), execution_mode, terminal_mode,
      nextProvider === existing.provider ? existing.executionMode : undefined);
    const config = await loadConfig(store.root);
    const resolved = resolveProviderOptions(config, nextProvider, {
      model: model ?? (nextProvider === existing.provider ? existing.model : undefined),
      effort: effort ?? (nextProvider === existing.provider ? existing.effort : undefined),
    });
    const resumeSessionId = existing.sessions?.[nextProvider];
    const updated = await store.update(id, {
      provider: nextProvider,
      model: resolved.model ?? null,
      effort: resolved.effort ?? null,
      terminalMode: terminal_mode ?? existing.terminalMode ?? config.terminal.mode ?? 'tab',
      executionMode,
      autoApprove: resolveAutoApprove(config, auto_approve ?? existing.autoApprove),
      status: 'launched',
      pendingBackground: 0,
      reportedAt: null,
      runId: null,
      managedPid: null,
      error: null,
      startupHint: null,
      notificationError: null,
      launcher: null,
      ...(prompt?.trim() ? { prompt: `${existing.prompt}\n\n後續指示：${prompt.slice(0, 32000)}` } : {}),
    });
    const nextPrompt = resumeSessionId
      ? (prompt?.trim() || '請接續先前未完成的工作。')
      : buildTaskPrompt(updated, { isResume: true, extraPrompt: prompt?.trim() });
    try {
      return await launchTask(updated, { prompt: nextPrompt, resumeSessionId });
    } catch (error) {
      await store.update(id, { status: 'failed', error: error.message });
      throw error;
    }
  });

  const get = async ({ id }) => currentTaskState(await store.read(id));

  const list = async ({ cwd = defaultCwd, all = false } = {}) =>
    (await store.list())
      .filter((task) => all || path.resolve(task.cwd) === path.resolve(cwd))
      .map(currentTaskState)
      .map(({ id, provider, status, model, effort, createdAt, updatedAt, cwd: taskCwd, sessions, usage,
        executionMode, error, startupHint }) => ({
        id,
        provider,
        status,
        model,
        effort,
        sessions,
        usage,
        executionMode: executionMode ?? 'terminal',
        ...(error ? { error } : {}),
        ...(startupHint ? { startupHint } : {}),
        createdAt,
        updatedAt,
        cwd: taskCwd,
      }));

  return { start, resume, get, list };
};
