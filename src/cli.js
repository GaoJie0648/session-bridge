#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { pruneStorage } from './cleanup.js';
import { defaultHome, loadConfig, saveConfig } from './config.js';
import { createMailbox } from './mailbox.js';
import { createMessaging } from './messaging.js';
import { createDefaultRegistry } from './providers/registry.js';
import { createTaskStore } from './task-store.js';
import { createTaskTools } from './tasks.js';
import { detectWindowsTerminal } from './terminal.js';
import { createUsageTools } from './usage.js';
import { waitForMessages } from './waiter.js';

const help = `session-bridge-cli — 跨工具前台終端協作管理工具

  init [--providers claude,codex,agy] [--no-mcp] [--no-hooks]
                                       初始化設定檔並一次安裝各工具的 MCP Server 與 hook
  doctor [--json]                      檢查 wt、各 CLI 執行檔、MCP 與 hook 設定狀態
  tasks [--all] [--json]               列出派發的任務摘要
  show <task-id> [--json]              顯示單一任務詳細資訊與用量
  usage [--days 7] [--source all] [--json]
                                       查看近期各工具 token 用量摘要
  prune [--tasks-days 14] [--messages-days 7]
                                       清理過期任務、舊訊息與空信箱目錄
  wait <source> <session-id> [--timeout 3600]
                                       等待指定 session 收到新訊息後印出並結束（供背景喚醒用）
`;

const formatNumber = (n) => Number(n ?? 0).toLocaleString('en-US');

const renderDoctor = (report) => {
  const lines = [
    `session-bridge doctor (home: ${report.home})`,
    `  Windows Terminal (wt): ${report.wt ? `OK (${report.wt})` : '未找到（將退回獨立終端視窗）'}`,
    '',
  ];
  for (const item of report.providers) {
    lines.push(`[${item.provider}]`);
    lines.push(`  執行檔: ${item.executableOk ? `OK (${item.executable})` : '未找到'}`);
    lines.push(`  MCP:    ${item.mcpConfigured ? `OK${item.mcpFile ? ` (${item.mcpFile})` : ''}` : `尚未設定${item.mcpFile ? ` (${item.mcpFile})` : ''}`}`);
    lines.push(`  Hooks:  ${item.hooksConfigured ? `OK (${item.hooksFile})` : `尚未設定 (${item.hooksFile})`}`);
    lines.push(`  紀錄夾: ${item.sessionsDirExists ? `OK (${item.sessionsDir})` : `不存在 (${item.sessionsDir})`}`);
  }
  return `${lines.join('\n')}\n`;
};

const renderTasks = (list) => {
  if (list.length === 0) return '目前沒有任務紀錄。\n';
  return `${list.map((t) => {
    const model = [t.model, t.effort].filter(Boolean).join('/');
    return `${t.id.slice(0, 8)}  ${t.provider.padEnd(6)}  ${t.status.padEnd(10)}  ${(model || 'default').padEnd(18)}  ${t.updatedAt.slice(0, 16)}  ${t.cwd}`;
  }).join('\n')}\n`;
};

const renderUsage = (result) => {
  if (result.scope !== 'summary') return `${JSON.stringify(result, null, 2)}\n`;
  const lines = [`近期 ${result.days} 天各工具用量摘要：`];
  for (const [name, totals] of Object.entries(result.providers)) {
    lines.push(
      `  ${name.padEnd(7)} sessions=${totals.sessions}  turns=${totals.turns}  in=${formatNumber(totals.inputTokens)}  out=${formatNumber(totals.outputTokens)}  cache=${formatNumber(totals.cacheReadTokens)}  model=${totals.latestModel ?? '-'}`,
    );
  }
  return `${lines.join('\n')}\n`;
};

export const runCli = async (argv = process.argv.slice(2), { home = defaultHome(), env = process.env } = {}) => {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      providers: { type: 'string' },
      'no-mcp': { type: 'boolean' },
      'no-hooks': { type: 'boolean' },
      days: { type: 'string' },
      source: { type: 'string' },
      'tasks-days': { type: 'string' },
      'messages-days': { type: 'string' },
      timeout: { type: 'string' },
      'poll-ms': { type: 'string' },
    },
  });

  const [action, id, extraArg] = positionals;
  if (!action || values.help) return help;

  const registry = createDefaultRegistry({ home, env });
  const taskStore = createTaskStore(home);
  const taskTools = createTaskTools({ store: taskStore, registry });
  const usageTools = createUsageTools({ registry, taskStore });
  const hookScriptPath = fileURLToPath(new URL('./hook.js', import.meta.url));
  const serverScriptPath = fileURLToPath(new URL('./server.js', import.meta.url));

  if (action === 'init') {
    const config = await saveConfig(await loadConfig(home), home);
    const wanted = values.providers ? values.providers.split(',').map((s) => s.trim()).filter(Boolean) : registry.names;
    const results = [];
    for (const name of wanted) {
      const provider = registry.get(name);
      const entry = { provider: name, mcp: null, hooks: null, errors: [] };
      if (!values['no-mcp'] && provider.installMcp) {
        try {
          entry.mcp = await provider.installMcp(serverScriptPath);
        } catch (error) {
          entry.errors.push(`MCP 註冊失敗：${error.message}`);
        }
      }
      if (!values['no-hooks'] && provider.installHook) {
        try {
          entry.hooks = await provider.installHook(hookScriptPath);
        } catch (error) {
          entry.errors.push(`Hook 安裝失敗：${error.message}`);
        }
      }
      results.push(entry);
    }
    const payload = { configFile: path.join(home, 'config.json'), config, results };
    if (values.json) return `${JSON.stringify(payload, null, 2)}\n`;
    const lines = [`已初始化設定檔：${payload.configFile}`];
    for (const item of results) {
      lines.push(`[${item.provider}]`);
      if (item.mcp) lines.push(`  MCP:   已註冊 (${item.mcp})`);
      if (item.hooks) lines.push(`  Hooks: 已安裝 (${item.hooks})`);
      for (const err of item.errors) lines.push(`  錯誤:  ${err}`);
    }
    lines.push('', '提示：Codex CLI 新增或更新 hook 後，需在 Codex 內執行 /hooks 信任該設定；各工具需重啟或重新連線 MCP 生效。');
    return `${lines.join('\n')}\n`;
  }

  if (action === 'doctor') {
    const providers = await Promise.all(registry.all().map((provider) => provider.doctor()));
    const report = {
      home,
      wt: detectWindowsTerminal(env),
      providers,
    };
    return values.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report);
  }

  if (action === 'tasks' || action === 'list') {
    const list = await taskTools.list({ all: values.all ?? true });
    return values.json ? `${JSON.stringify(list, null, 2)}\n` : renderTasks(list);
  }

  if (action === 'show') {
    if (!id) throw new Error('請提供 task id');
    const task = await taskTools.get({ id });
    if (values.json) return `${JSON.stringify(task, null, 2)}\n`;
    const lines = [
      `Task:     ${task.id}`,
      `Provider: ${task.provider} (model=${task.model ?? 'default'}, effort=${task.effort ?? 'default'})`,
      `Status:   ${task.status} (launcher=${task.launcher ?? '-'})`,
      `CWD:      ${task.cwd}`,
      `Sessions: ${JSON.stringify(task.sessions)}`,
      `Usage:    ${task.usage ? JSON.stringify(task.usage) : '-'}`,
      `Output:\n${task.output || '(尚無回覆摘要)'}`,
    ];
    if (task.startupHint) lines.push(task.startupHint);
    if (task.error) lines.push(`問題：${task.error}`);
    return `${lines.join('\n')}\n`;
  }

  if (action === 'usage') {
    const days = values.days ? Number(values.days) : 7;
    const result = await usageTools.getUsage({ source: values.source, days });
    return values.json ? `${JSON.stringify(result, null, 2)}\n` : renderUsage(result);
  }

  if (action === 'prune') {
    const config = await loadConfig(home);
    const stats = await pruneStorage({
      home,
      tasksDays: values['tasks-days'] ? Number(values['tasks-days']) : config.retention.tasksDays,
      doneMessagesDays: values['messages-days'] ? Number(values['messages-days']) : config.retention.doneMessagesDays,
    });
    return values.json
      ? `${JSON.stringify(stats, null, 2)}\n`
      : `清理完成：移除任務 ${stats.tasksRemoved} 筆、過期訊息 ${stats.messagesRemoved} 則、空信箱目錄 ${stats.mailboxesRemoved} 個。\n`;
  }

  if (action === 'wait') {
    const source = id;
    const sessionId = extraArg;
    if (!source || !sessionId) throw new Error('請提供 <source> 與 <session-id>');
    if (!registry.isValidSessionId(source, sessionId)) throw new Error(`無效的 session 位址：${source} ${sessionId}`);
    const timeoutSec = values.timeout ? Math.max(1, Number(values.timeout)) : 3600;
    const pollMs = values['poll-ms'] ? Math.max(50, Number(values['poll-ms'])) : 1000;
    const mailbox = createMailbox(home);
    const messaging = createMessaging({ mailbox, registry });
    const messages = await waitForMessages({
      messaging,
      mailbox,
      address: { source, id: sessionId },
      isAbandoned: () => false,
      sleep: () => new Promise((resolve) => setTimeout(resolve, pollMs)),
      maxPolls: Math.max(1, Math.ceil((timeoutSec * 1000) / pollMs)),
    });
    return messages.length > 0 ? `${messages.join('\n\n---\n\n')}\n` : '等待逾時，沒有新訊息。\n';
  }

  throw new Error(`不支援的指令：${action}（使用 --help 查看用法）`);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runCli()
    .then((output) => {
      if (output) process.stdout.write(output);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
