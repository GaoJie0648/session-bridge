#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTaskTools } from './tasks.js';

const help = `session-bridge-control — 雙向背景協作控制入口

  list                                      列出所有任務
  show <task-id>                            顯示進度、結果與審批 ID
  watch <task-id>                           持續顯示進度（Ctrl+C 離開，不會取消任務）
  approve <task-id> <approval-id>            同意這一次操作
  deny <task-id> <approval-id>               拒絕這一次操作
  answer <task-id> <approval-id> --file JSON  回答問題／表單（JSON 檔）
  auto <task-id> on --minutes 60             對這個任務目前的 provider 開啟限時自動同意
       [--kinds command,file,tool,permissions]  可縮小自動同意種類
  auto <task-id> off                         關閉自動同意
  resume <task-id> [--provider codex|claude]  恢復任務或換另一邊接手
       [--prompt "後續指示"]
  cancel <task-id>                           中止背景任務

automode 會同意指定種類的後續原生審批，包含可能超出工作目錄的操作；
這是限時預先授權，不是風險判斷器，也不會替你回答問題或填表。
不更改全域 CLI 設定，不繞過原生禁止規則。切換 provider 或任務完成後失效。
請由你在終端執行控制指令，不要讓 agent 自行啟用 automode。
`;

const main = async () => {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, minutes: { type: 'string' }, kinds: { type: 'string' },
    file: { type: 'string' }, provider: { type: 'string' }, prompt: { type: 'string' },
  } });
  const [action, id, argument] = positionals;
  if (!action || values.help) { process.stdout.write(help); return; }
  const tools = createTaskTools();
  const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (action === 'list') { print(await tools.list({ all: true })); return; }
  if (!id) throw new Error('請提供 task id');
  if (action === 'show') { print(await tools.get({ id })); return; }
  if (action === 'watch') {
    let previous;
    while (true) {
      const task = await tools.get({ id });
      if (task.updatedAt !== previous) { print(task); previous = task.updatedAt; }
      if (!task.workerAlive && !['queued', 'waiting_quota'].includes(task.status)) break;
      await sleep(1000);
    }
    return;
  }
  if (process.env.SESSION_BRIDGE_MANAGED === '1') throw new Error('背景 agent 不可使用審批控制入口');
  if (action === 'resume') { print(await tools.resume({ id, provider: values.provider, prompt: values.prompt })); return; }
  if (action === 'cancel') { print(await tools.cancel({ id })); return; }
  if (action === 'auto') {
    if (!['on', 'off'].includes(argument)) throw new Error('請指定 on 或 off');
    print(await tools.control(id, { action: 'auto', enabled: argument === 'on',
      minutes: values.minutes === undefined ? 60 : Number(values.minutes),
      kinds: values.kinds?.split(',') }));
    return;
  }
  if (['approve', 'deny', 'answer'].includes(action)) {
    if (!argument) throw new Error('請提供 approval id');
    if (action === 'answer' && !values.file) throw new Error('answer 需要 --file JSON 檔案');
    const answer = action === 'answer' ? JSON.parse(await fs.readFile(values.file, 'utf8')) : undefined;
    print(await tools.control(id, { action: action === 'answer' ? 'approve' : action, approvalId: argument, answer }));
    return;
  }
  throw new Error('不支援的指令；使用 --help 查看用法');
};
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
