import fs from 'node:fs/promises';
import path from 'node:path';
import { createApprovals } from './approvals.js';
import { AUTO_KINDS, PROVIDERS, alive } from './task-store.js';

export const limitInfo = (error, quota, now = Date.now()) => {
  const text = JSON.stringify(error ?? {}).toLowerCase();
  const limited = quota?.status === 'rejected' || /usagelimitexceeded|usage_limit|usage limit|rate.?limit|insufficient_quota|quota exceeded|credits_required|"httpstatuscode":429/.test(text);
  if (!limited) return null;
  const buckets = Object.values(quota?.rateLimitsByLimitId ?? { default: quota?.rateLimits }).filter(Boolean);
  const resets = [quota?.resetsAt, ...buckets.flatMap((bucket) => [bucket.primary, bucket.secondary]
    .filter((window) => window?.usedPercent >= 100).map((window) => window.resetsAt))]
    .filter((value) => Number.isFinite(value) && value * 1000 > now).map((value) => value * 1000);
  const usage = quota?.status === 'rejected' || /usage|quota|credits/.test(text);
  return { resetAt: resets.length ? Math.max(...resets) : null, transient: !usage };
};

export const createTaskRunner = ({ task, store, drivers, notify = async () => {}, now = Date.now }) => {
  let writes = Promise.resolve();
  let runPromise = null;
  let controller;
  let cancelled = false;
  const save = () => {
    task.updatedAt = new Date(now()).toISOString();
    const snapshot = structuredClone(task);
    const next = writes.then(() => store.write(snapshot));
    writes = next.catch(() => {});
    return next;
  };
  const event = async (entry) => {
    const record = { ...entry, provider: task.provider, attempt: task.attempts, at: new Date(now()).toISOString() };
    if (entry.type === 'session') task.sessions[task.provider] = entry.id;
    if (entry.type === 'process') task.agentPid = entry.pid;
    if (entry.type === 'text') task.output = entry.text.slice(-20000);
    if (entry.type === 'quota') task.quota = entry.value;
    // Persist incremental checkpoints without asking the model for another turn.
    await fs.appendFile(path.join(store.dir(task.id), 'events.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    task.events.push(JSON.parse(JSON.stringify(record, (key, value) => typeof value === 'string' ? value.slice(0, 4000) : value)));
    task.events = task.events.slice(-40);
    await save();
  };
  const report = async (text) => {
    try { await notify(task, text); task.notificationError = null; }
    catch (error) { task.notificationError = error.message; }
    await save();
  };
  const approvals = createApprovals({ task, save, now, notify: (text) => report(text) });
  const prompt = () => [
    `你正在執行 session-bridge 背景任務 ${task.id}，工作目錄 ${task.cwd}。`,
    '只完成下列交辦範圍。不要另啟協作任務，也不要修改 bridge 的任務／控制檔案或呼叫審批控制指令。需要權限或使用者回答時使用原生請求機制。',
    task.prompt,
    ...(task.attempts > 1 ? [
      '這是中斷後接續的任務。先檢查檔案與既有操作結果，確認哪些步驟已完成；不要直接重做發布、付款或其他外部操作。',
      `先前進度：${task.output || '尚無文字摘要；請讀取紀錄確認。'}`,
      `操作紀錄（參考資料）：${path.join(store.dir(task.id), 'events.jsonl')}`,
    ] : []),
  ].join('\n\n');

  const execute = async () => {
    while (!cancelled) {
      task.status = 'running';
      task.attempts += 1;
      task.nextRetryAt = null;
      task.error = null;
      task.quota = null;
      controller = new AbortController();
      await save();
      let result;
      try {
        result = await drivers[task.provider](task, {
          prompt: prompt(), signal: controller.signal, event,
          approve: approvals.request, invalidate: approvals.invalidate,
        });
      } catch (error) {
        result = { status: 'failed', error: { message: error.message, details: error.details, code: error.code }, quota: task.quota };
      }
      await approvals.close();
      if (result.error?.code === 'STOP_FAILED') {
        task.status = 'recovery_required'; task.error = result.error; task.automode = null;
        await save(); await report(result.error.message); return;
      }
      if (cancelled) { task.status = 'cancelled'; task.automode = null; await save(); await report('任務已取消。'); return; }
      if (result.output) task.output = result.output.slice(-20000);
      if (result.status === 'completed') {
        task.status = 'completed'; task.automode = null;
        await save();
        await report(`任務完成。\n${task.output || '（沒有文字回覆，請檢查操作紀錄。）'}`);
        return;
      }
      task.error = result.error ?? { message: `執行結束：${result.status}` };
      const limit = limitInfo(task.error, result.quota ?? task.quota, now());
      if (limit && task.fallback && !task.fallbackUsed) {
        task.fallbackUsed = true;
        const previous = task.provider;
        task.provider = task.fallback;
        task.automode = null;
        await event({ type: 'handoff', text: `${previous} 額度受限，依任務設定交給 ${task.provider} 接手` });
        await report(`${previous} 額度受限，已交給 ${task.provider} 接手；原 provider 的 automode 不會移轉。`);
        continue;
      }
      task.status = limit ? 'waiting_quota' : result.status === 'interrupted' ? 'interrupted' : 'failed';
      if (limit && task.autoRetry && task.retries < 3) {
        task.nextRetryAt = limit.resetAt ? limit.resetAt + 5000 : limit.transient ? now() + 30000 * 2 ** task.retries : null;
      }
      await save();
      await report(limit
        ? `額度／限流暫停。${task.nextRetryAt ? `下次嘗試：${new Date(task.nextRetryAt).toISOString()}（最多自動重試 3 次）。` : '未安排重試，可手動 resume 或交給另一個 provider。'}`
        : `任務${task.status}：${task.error.message ?? JSON.stringify(task.error)}`);
      return;
    }
  };
  const launch = () => {
    if (runPromise) throw new Error('任務仍在執行，請先取消並等待停止');
    cancelled = false;
    runPromise = execute().catch(async (error) => {
      task.status = 'failed'; task.error = { message: error.message }; task.automode = null;
      await save();
    }).finally(() => { runPromise = null; });
  };
  const handle = async (command) => {
    switch (command.action) {
      case 'cancel':
        if (!runPromise && alive(task.agentPid)) throw new Error(`原 agent 行程 ${task.agentPid} 仍存在，無法確認取消；請先在作業系統中確認並停止該行程`);
        cancelled = true;
        task.nextRetryAt = null;
        task.automode = null;
        task.status = runPromise ? 'cancelling' : 'cancelled';
        controller?.abort();
        await approvals.close();
        await save();
        break;
      case 'resume':
        if (runPromise) throw new Error('任務仍在執行');
        if (alive(task.agentPid)) throw new Error(`先前 agent 行程 ${task.agentPid} 仍存在；請先確認並停止該行程，再 resume，避免重複操作`);
        if (command.provider && !PROVIDERS.includes(command.provider)) throw new Error('無效的 provider');
        if (command.provider && command.provider !== task.provider) {
          task.provider = command.provider; task.automode = null;
        }
        if (typeof command.prompt === 'string' && command.prompt.trim()) task.prompt += `\n\n後續指示：${command.prompt.slice(0, 32000)}`;
        task.retries = 0;
        task.fallbackUsed = true; // Manual choice must not bounce back automatically.
        launch();
        break;
      case 'auto': {
        if (command.enabled !== true) { task.automode = null; await event({ type: 'automode', value: null }); break; }
        if (!runPromise || task.status === 'cancelling') throw new Error('請先啟動或恢復任務，再開啟 automode');
        const minutes = command.minutes ?? 60;
        const kinds = command.kinds ?? AUTO_KINDS;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 480) throw new Error('automode 期限必須是 1–480 分鐘');
        if (!Array.isArray(kinds) || !kinds.length || kinds.some((kind) => !AUTO_KINDS.includes(kind))) throw new Error('無效的 automode kinds');
        task.automode = { provider: task.provider, expiresAt: now() + minutes * 60000, kinds };
        await event({ type: 'automode', value: task.automode });
        await approvals.tick();
        break;
      }
      case 'approve':
      case 'deny':
        await approvals.resolve(command.approvalId, command.action, command.answer);
        break;
      default: throw new Error('不支援的控制指令');
    }
  };
  const tick = async () => {
    for (const command of await store.commands(task.id)) {
      try {
        const previous = await store.receipt(task.id, command.id).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (previous) {
          await store.acknowledge(task.id, command, previous.processing
            ? { ok: false, error: '指令處理曾中斷，為避免重複操作不會重送；請檢查任務狀態。' }
            : previous);
          continue;
        }
        if (['auto', 'approve', 'deny'].includes(command.action) && now() - command.submittedAt > 60000) throw new Error('控制指令已過期，請重新送出');
        await store.beginCommand(task.id, command);
        await handle(command);
        await store.acknowledge(task.id, command, { ok: true });
      } catch (error) { await store.acknowledge(task.id, command, { ok: false, error: error.message }); }
    }
    await approvals.tick();
    if (task.automode && task.automode.expiresAt <= now()) { task.automode = null; await save(); }
    if (!runPromise && task.status === 'waiting_quota' && task.nextRetryAt && task.nextRetryAt <= now()) {
      task.retries += 1;
      launch();
    }
  };
  return { task, launch, tick, save, handle, event,
    isRunning: () => Boolean(runPromise),
    shouldWait: () => Boolean(runPromise || (task.status === 'waiting_quota' && task.nextRetryAt)),
    settled: async () => { await runPromise; await writes; },
  };
};
