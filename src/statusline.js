#!/usr/bin/env node
import { defaultMailboxRoot } from './mailbox.js';
import { createTaskStore } from './task-store.js';
import { formatTasks } from './tasks.js';
import { createUsageStore, formatUsage, fromClaudeStatus } from './usage.js';
import { logError, orElse, parseJson } from './util.js';

// Claude Code 只在 statusline 的輸入提供 rate_limits，hook 拿不到，所以在這裡存成快照給 hook 讀
const main = async () => {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  const windows = fromClaudeStatus(parseJson(data));
  if (windows.length > 0) await createUsageStore(defaultMailboxRoot()).saveSnapshot('claude', windows);
  // 背景任務沒有視窗，在這裡顯示才看得出有任務在跑；任務檔讀不到時只略過這段
  const tasks = await orElse(() => createTaskStore(defaultMailboxRoot()).list(), [])();
  process.stdout.write([formatUsage(windows), formatTasks(tasks)].filter(Boolean).join(' · '));
};

// statusline 出錯時只留空白，不讓錯誤訊息佔掉畫面
main().catch(logError);
