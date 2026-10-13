import { setTimeout as sleep } from 'node:timers/promises';
import { createTaskStore, alive } from './task-store.js';
import { createTaskRunner } from './task-runner.js';
import { runCodex } from './codex-agent.js';
import { runClaude } from './claude-agent.js';
import { createMailbox } from './mailbox.js';
import { createCodexQueue } from './codex-queue.js';
import { renderMessage } from './messaging.js';

const store = createTaskStore();
const id = process.argv[2];
const release = await store.claim(id);
if (release) {
  try {
    const task = await store.read(id);
    const fresh = task.status === 'queued';
    if (['running', 'waiting_approval', 'cancelling'].includes(task.status)) {
      task.status = alive(task.agentPid) ? 'recovery_required' : 'interrupted';
      task.error = { message: '背景行程曾中斷；請先確認操作紀錄，再 resume。' };
      task.automode = null;
      for (const approval of task.approvals) if (approval.status === 'pending') approval.status = 'stale';
    }
    task.pid = process.pid;
    const mailbox = createMailbox(store.root);
    const deliver = createCodexQueue();
    const runner = createTaskRunner({ task, store, drivers: { codex: runCodex, claude: runClaude }, notify: async (current, text) => {
      if (!current.from) return;
      const senderSource = current.sessions[current.provider] ? current.provider : Object.keys(current.sessions)[0];
      const senderId = current.sessions[senderSource];
      if (!senderId) throw new Error('尚未取得背景 session id；請用 get_task 查看狀態。');
      const message = await mailbox.add({ from: { source: senderSource, id: senderId }, to: current.from,
        text: `[背景任務 ${current.id}] ${text.slice(0, 7000)}\n控制入口：session-bridge-control show ${current.id}`,
        auto: true, expectsReply: false,
      }, current.from.source === 'codex' ? 'done' : 'new');
      if (current.from.source === 'codex') await deliver(current.from.id, renderMessage(message));
    } });
    await runner.save();
    if (fresh) runner.launch();
    let idle = 0;
    while (idle < 4) {
      await runner.tick();
      idle = runner.shouldWait() ? 0 : idle + 1;
      await sleep(500);
    }
    await runner.settled();
    task.pid = null;
    await runner.save();
  } finally { await release(); }
}
