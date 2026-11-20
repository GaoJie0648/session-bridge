import path from 'node:path';

import { maybeAutoPrune } from './cleanup.js';
import { TERMINAL_MODES, loadConfig, resolveProviderOptions } from './config.js';
import { createDefaultRegistry } from './providers/registry.js';
import { createRooms } from './rooms.js';
import { createTaskStore } from './task-store.js';
import { launchInTerminal } from './terminal.js';

const roomPrompt = (roomId) =>
  `[session-bridge 房間 ${roomId}] 若已取得房主提供的成員權杖，請用 room_read 查看房間，並用 room_post 明確貼回討論結果。`;

/** 組合交辦給獨立終端 CLI 的初始 prompt（附上可驗證來源的查證指引） */
export const buildTaskPrompt = (task, { isResume = false, extraPrompt } = {}) => {
  const lines = [
    `[session-bridge 任務 ${task.id}] 工作目錄：${task.cwd}`,
  ];
  if (task.roomId) lines.push(roomPrompt(task.roomId));
  if (task.from) {
    lines.push(
      `交辦來源：${task.from.source} ${task.from.id}。如需核對是否為使用者本人授權或確認原話，請直接呼叫 session-bridge 的 read_session(source="${task.from.source}", id="${task.from.id}", roles=["user"]) 查證後直接執行，無需再詢問使用者。`,
    );
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

export const createTaskTools = ({
  store = createTaskStore(),
  registry = createDefaultRegistry({ home: store.root }),
  rooms = createRooms({ home: store.root, registry }),
  launcher = launchInTerminal,
  defaultCwd = process.cwd(),
} = {}) => {
  const launchTask = async (task, { prompt, resumeSessionId } = {}) => {
    const config = await loadConfig(store.root);
    const provider = registry.get(task.provider);
    const mode = task.terminalMode ?? config.terminal.mode ?? 'tab';
    const spec = provider.buildLaunchSpec({
      cwd: task.cwd,
      model: task.model,
      effort: task.effort,
      resumeSessionId,
    });
    const title = `bridge:${task.provider} ${task.id.slice(0, 8)}`;
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
    from_source,
    from_id,
    room_id,
  }) => {
    if (Boolean(from_source) !== Boolean(from_id)) {
      throw new Error('from_source 與 from_id 必須一起提供');
    }
    if (terminal_mode && !TERMINAL_MODES.includes(terminal_mode)) {
      throw new Error(`無效的 terminal_mode：${terminal_mode}（可用：${TERMINAL_MODES.join('、')}）`);
    }
    const config = await loadConfig(store.root);
    const resolved = resolveProviderOptions(config, provider, { model, effort });
    const mode = terminal_mode ?? config.terminal.mode ?? 'tab';
    const roomId = room_id ? rooms.info(room_id).id : undefined;

    const task = await store.create({
      provider,
      cwd,
      prompt,
      model: resolved.model,
      effort: resolved.effort,
      terminalMode: mode,
      roomId,
      from: from_id ? { source: from_source, id: from_id } : undefined,
      validProviders: registry.names,
    });
    const fullPrompt = buildTaskPrompt(task);
    try {
      const updated = await launchTask(task, { prompt: fullPrompt });
      await maybeAutoPrune(store.root);
      return updated;
    } catch (error) {
      await store.update(task.id, { status: 'failed', notificationError: error.message });
      throw error;
    }
  };

  const resume = async ({ id, provider, prompt, model, effort, terminal_mode, room_id }) => {
    const existing = await store.read(id);
    const nextProvider = provider ?? existing.provider;
    if (!registry.has(nextProvider)) {
      throw new Error(`不支援的 provider：${nextProvider}（可用：${registry.names.join('、')}）`);
    }
    if (terminal_mode && !TERMINAL_MODES.includes(terminal_mode)) {
      throw new Error(`無效的 terminal_mode：${terminal_mode}（可用：${TERMINAL_MODES.join('、')}）`);
    }
    const config = await loadConfig(store.root);
    const resolved = resolveProviderOptions(config, nextProvider, {
      model: model ?? (nextProvider === existing.provider ? existing.model : undefined),
      effort: effort ?? (nextProvider === existing.provider ? existing.effort : undefined),
    });
    const resumeSessionId = existing.sessions?.[nextProvider];
    const requestedRoom = room_id ?? existing.roomId;
    const roomId = requestedRoom ? rooms.info(requestedRoom).id : undefined;
    const updated = await store.update(id, {
      provider: nextProvider,
      model: resolved.model ?? null,
      effort: resolved.effort ?? null,
      terminalMode: terminal_mode ?? existing.terminalMode ?? config.terminal.mode ?? 'tab',
      status: 'launched',
      reportedAt: null,
      ...(roomId ? { roomId } : {}),
      ...(prompt?.trim() ? { prompt: `${existing.prompt}\n\n後續指示：${prompt.slice(0, 32000)}` } : {}),
    });
    const nextPrompt = resumeSessionId
      ? [roomId ? roomPrompt(roomId) : '', prompt?.trim() || '請接續先前未完成的工作。'].filter(Boolean).join('\n\n')
      : buildTaskPrompt(updated, { isResume: true, extraPrompt: prompt?.trim() });
    return launchTask(updated, { prompt: nextPrompt, resumeSessionId });
  };

  const get = async ({ id }) => store.read(id);

  const list = async ({ cwd = defaultCwd, all = false } = {}) =>
    (await store.list())
      .filter((task) => all || path.resolve(task.cwd) === path.resolve(cwd))
      .map(({ id, provider, status, model, effort, createdAt, updatedAt, cwd: taskCwd, sessions, usage }) => ({
        id,
        provider,
        status,
        model,
        effort,
        sessions,
        usage,
        createdAt,
        updatedAt,
        cwd: taskCwd,
      }));

  return { start, resume, get, list };
};
