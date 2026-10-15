#!/usr/bin/env node
import { defaultMailboxRoot } from './mailbox.js';
import { createUsageStore, formatUsage, fromClaudeStatus } from './usage.js';
import { logError, parseJson } from './util.js';

// Claude Code 只在 statusline 的輸入提供 rate_limits，hook 拿不到，所以在這裡存成快照給 hook 讀
const main = async () => {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  const windows = fromClaudeStatus(parseJson(data));
  if (windows.length > 0) await createUsageStore(defaultMailboxRoot()).saveSnapshot('claude', windows);
  process.stdout.write(formatUsage(windows));
};

// statusline 出錯時只留空白，不讓錯誤訊息佔掉畫面
main().catch(logError);
