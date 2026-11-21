#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ACP_TOOL_KINDS, EFFORT_LEVELS, EXECUTION_MODES, TERMINAL_MODES, defaultHome } from './config.js';
import { MESSAGE_ID, createMailbox } from './mailbox.js';
import { createDefaultRegistry } from './providers/registry.js';
import { createTaskStore } from './task-store.js';
import { createTaskTools } from './tasks.js';
import { createTools } from './tools.js';
import { createUsageTools } from './usage.js';

const home = defaultHome();
const registry = createDefaultRegistry({ home });
const mailbox = createMailbox(home);
const taskStore = createTaskStore(home);

const tools = createTools({ registry, mailbox, defaultCwd: process.cwd() });
const tasks = createTaskTools({ store: taskStore, registry, defaultCwd: process.cwd() });
const usage = createUsageTools({ registry, taskStore });

const providerNames = registry.names;
const source = z.enum(providerNames).describe(`session 來自哪個工具（${providerNames.join(' / ')}）`);
const scope = {
  source: z.enum([...providerNames, 'all']).optional().describe('只看某一個工具的 session，預設 all'),
  cwd: z.string().max(1024).optional().describe('專案目錄的絕對路徑；請傳入你目前的工作目錄，只會納入該目錄（含子目錄）的 session'),
  all: z.boolean().optional().describe('true 時忽略 cwd，涵蓋所有專案'),
};

const asResult = (handler) => async (args) => {
  try {
    return { content: [{ type: 'text', text: await handler(args) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
};

const jsonResult = (handler) => asResult(async (args) => JSON.stringify(await handler(args), null, 2));

const server = new McpServer({ name: 'session-bridge', version: '0.3.0' });
const readOnly = { readOnlyHint: true, openWorldHint: false };
const writesMailbox = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const instructsAnotherAgent = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

server.registerTool('list_sessions', {
  description: `列出 ${providerNames.join(' / ')} 的對話 session（新到舊），用來找出其他工具先前做過的工作。預設只列出目前專案的 session。`,
  inputSchema: { ...scope, limit: z.number().int().min(1).max(100).optional().describe('最多列出幾個，預設 20') },
  annotations: readOnly,
}, asResult(tools.listSessions));

server.registerTool('read_session', {
  description: '讀取某個 session 的對話內容：使用者與助理的文字，工具呼叫只顯示一行摘要（不含輸出）。預設回傳最後 30 則；每則開頭的 [index] 可交給 get_entry 取得完整內容。只想核對使用者說過的話（例如驗證跨 agent 交辦授權）時加上 roles=["user"]，比整段讀取省得多。',
  inputSchema: {
    source,
    id: z.string().max(128).describe('list_sessions 回傳的 session id'),
    roles: z.array(z.enum(['user', 'assistant', 'tool'])).min(1).max(3).optional()
      .describe('只看這些角色的紀錄，例如 ["user"] 只看使用者說過的話；此時 offset 與 limit 以篩選後的清單計算'),
    offset: z.number().int().min(0).optional().describe('從第幾則開始；省略時讀取最後 limit 則'),
    limit: z.number().int().min(1).max(200).optional().describe('回傳幾則，預設 30'),
    maxChars: z.number().int().min(100).max(20000).optional().describe('每則訊息最多保留幾個字，預設 2000'),
  },
  annotations: readOnly,
}, asResult(tools.readSession));

server.registerTool('get_entry', {
  description: '取得 session 中單一則紀錄的完整內容；對工具呼叫會包含完整輸入與輸出。',
  inputSchema: {
    source,
    id: z.string().max(128).describe('session id'),
    index: z.number().int().min(0).describe('read_session 或 search_sessions 顯示的 [index]'),
  },
  annotations: readOnly,
}, asResult(tools.getEntry));

server.registerTool('search_sessions', {
  description: `在 ${providerNames.join(' / ')} 的對話文字中搜尋關鍵字（不分大小寫，不含工具輸出），回傳符合的 session id、[index] 與前後文。`,
  inputSchema: {
    query: z.string().min(1).max(500).describe('要搜尋的文字'),
    ...scope,
    limit: z.number().int().min(1).max(100).optional().describe('最多回傳幾筆，預設 20'),
  },
  annotations: readOnly,
}, asResult(tools.searchSessions));

const sessionId = (what) => z.string().max(128).describe(`${what}的 session id`);

server.registerTool('send_message', {
  description: `傳訊息給這台機器上另一個 ${providerNames.join(' / ')} session，用於交接工作、提問或回報結果。訊息會附上來源 session 定位，對方如需確認授權可直接用 read_session(roles=["user"]) 查證原話。只在使用者要求交接或協作時使用。`,
  inputSchema: {
    from_source: source.describe('寄件 session 來自哪個工具（就是你自己）'),
    from_id: sessionId('寄件'),
    to_source: source.describe('收件 session 來自哪個工具'),
    to_id: sessionId('收件'),
    text: z.string().min(1).max(8000).describe('訊息內容'),
    expects_reply: z.boolean().optional()
      .describe('是否要對方回覆。true：對方回合結束時的最後回覆會自動送回來；false：純通知。省略時，新交辦為 true，回覆來信為 false'),
  },
  annotations: instructsAnotherAgent,
}, asResult(tools.sendMessage));

server.registerTool('get_message_status', {
  description: '查詢 send_message 寄出的訊息目前狀態：尚未讀取、對方處理中，或已結案。',
  inputSchema: {
    to_source: source.describe('收件 session 來自哪個工具'),
    to_id: sessionId('收件'),
    message_id: z.string().regex(MESSAGE_ID).describe('send_message 回傳的訊息 id'),
  },
  annotations: readOnly,
}, asResult(tools.messageStatus));

server.registerTool('check_inbox', {
  description: '取出寄給指定 session、尚未讀取的協作訊息。如需確認是否為使用者授權，可依訊息中的來源位址呼叫 read_session(roles=["user"]) 核對原話。',
  inputSchema: {
    source: source.optional().describe('收件工具，預設 claude'),
    id: sessionId('收件'),
  },
  annotations: writesMailbox,
}, asResult(tools.checkInbox));

const taskId = z.string().uuid().describe('start_task 回傳的任務 id（不是 session id）');
const effortSchema = z.enum(EFFORT_LEVELS).optional().describe(`推理強度（${EFFORT_LEVELS.join(' / ')}），省略時沿用工具預設`);
const terminalModeSchema = z.enum(TERMINAL_MODES).optional().describe(`開啟終端的方式（${TERMINAL_MODES.join(' / ')}），省略時沿用 ~/.session-bridge/config.json`);
const autoApproveSchema = z.array(z.enum(ACP_TOOL_KINDS)).max(ACP_TOOL_KINDS.length).optional()
  .describe('背景 agy 任務遇到這些工具類型的權限確認時自動允許一次；只能縮小 ~/.session-bridge/config.json 的 managed.autoApprove，省略時沿用設定檔');
const executionModeSchema = z.enum(EXECUTION_MODES).optional().describe('執行方式。Codex 和 agy 預設由 MCP 管理，Claude Code 使用前台終端；指定 terminal_mode 也會使用前台終端。');

server.registerTool('start_task', {
  description: `啟動指定的 CLI（${providerNames.join(' / ')}）執行協作任務，每次都會開新的 session。要在同一個 session 接續上一輪工作，請改用 resume_task 帶上一輪的任務 id。Codex 和 agy 預設在背景執行，Claude Code 使用原生終端。用 get_task 查看 session、結果及待確認事項。`,
  inputSchema: {
    provider: source,
    cwd: z.string().max(1024).optional().describe('工作目錄的絕對路徑'),
    prompt: z.string().min(1).max(32000).describe('完整交辦內容、限制與驗收條件'),
    model: z.string().max(128).optional().describe('指定該工具使用的模型名稱（如 claude-opus-4-6、sonnet、gpt-5.4），省略時使用預設'),
    effort: effortSchema,
    terminal_mode: terminalModeSchema,
    execution_mode: executionModeSchema,
    auto_approve: autoApproveSchema,
    from_source: source.optional().describe('發起端工具，與 from_id 一起提供時會在完成後自動回報'),
    from_id: z.string().max(128).optional().describe('發起端 session id'),
  },
  annotations: instructsAnotherAgent,
}, jsonResult(tasks.start));

server.registerTool('resume_task', {
  description: '在原本的 session 接續任務（保留上下文，適合下一輪工作或追加交辦），或切換 provider 繼續。背景任務停在 needs_user_action 時，可指定 execution_mode=terminal 在原生終端處理權限或登入。',
  inputSchema: {
    id: taskId,
    provider: source.optional(),
    prompt: z.string().max(32000).optional(),
    model: z.string().max(128).optional(),
    effort: effortSchema,
    terminal_mode: terminalModeSchema,
    execution_mode: executionModeSchema,
    auto_approve: autoApproveSchema,
  },
  annotations: instructsAnotherAgent,
}, jsonResult(tasks.resume));

server.registerTool('get_task', {
  description: '查看任務狀態、對應的原生 session id、最新回合的回覆與基本用量紀錄。status：running＝回合進行中；waiting_background＝回合已結束但背景工作未完成（pendingBackground 為數量），完成後會自動續跑並回報；completed＝最近一回合已結束且沒有背景工作；needs_user_action＝背景任務需要使用者確認。',
  inputSchema: { id: taskId },
  annotations: readOnly,
}, jsonResult(tasks.get));

server.registerTool('list_tasks', {
  description: '列出 session-bridge 派發的任務，預設目前專案。',
  inputSchema: {
    cwd: z.string().max(1024).optional(),
    all: z.boolean().optional(),
  },
  annotations: readOnly,
}, jsonResult(tasks.list));

server.registerTool('get_usage', {
  description: '查詢單一任務、單一 session，或近期各工具彙總的 token 用量與本機可得的 rate limit 快照。',
  inputSchema: {
    task_id: z.string().uuid().optional().describe('查詢指定任務的用量'),
    source: z.enum([...providerNames, 'all']).optional().describe('篩選工具（查單一 session 時必填）'),
    id: z.string().max(128).optional().describe('查詢指定 session id 的用量'),
    days: z.number().int().min(1).max(90).optional().describe('彙總最近幾天的用量，預設 7 天'),
  },
  annotations: readOnly,
}, jsonResult(usage.getUsage));

await server.connect(new StdioServerTransport());
