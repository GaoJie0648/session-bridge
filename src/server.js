#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { EFFORT_LEVELS, TERMINAL_MODES, defaultHome } from './config.js';
import { createMailbox } from './mailbox.js';
import { createDefaultRegistry } from './providers/registry.js';
import { attachmentContent } from './room-attachments.js';
import { createRooms } from './rooms.js';
import { createTaskStore } from './task-store.js';
import { createTaskTools } from './tasks.js';
import { createTools } from './tools.js';
import { createUsageTools } from './usage.js';

const home = defaultHome();
const registry = createDefaultRegistry({ home });
const mailbox = createMailbox(home);
const rooms = createRooms({ home, registry });
const taskStore = createTaskStore(home);

const tools = createTools({ registry, mailbox, defaultCwd: process.cwd() });
const tasks = createTaskTools({ store: taskStore, registry, rooms, defaultCwd: process.cwd() });
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

server.registerTool('check_inbox', {
  description: '取出寄給指定 session、尚未讀取的協作訊息。如需確認是否為使用者授權，可依訊息中的來源位址呼叫 read_session(roles=["user"]) 核對原話。',
  inputSchema: {
    source: source.optional().describe('收件工具，預設 claude'),
    id: sessionId('收件'),
  },
  annotations: writesMailbox,
}, asResult(tools.checkInbox));

const taskId = z.string().uuid().describe('start_task 回傳的任務 id（不是 session id）');
const roomId = z.string().uuid().describe('群組房間 ID');
const roomCredentials = {
  room_id: roomId,
  room_token: z.string().regex(/^[a-f0-9]{48}$/).describe('房主交給這個 session 的成員權杖，請勿貼到房間或轉交'),
};
const seq = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const attachment = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workspace_ref'),
    path: z.string().min(1).max(4096).describe('房間工作目錄中的檔案，支援相對路徑'),
    lines: z.strictObject({ start: seq, end: seq }).optional(),
    note: z.string().max(1000).optional(),
  }),
  z.strictObject({
    kind: z.literal('artifact'),
    path: z.string().min(1).max(4096).describe('房間工作目錄中的檔案，會另外保存快照'),
    name: z.string().min(1).max(256).optional(),
  }),
]);
const asAgent = (token) => ({ agent: true, token });

server.registerTool('room_read', {
  description: '讀取群組房間的貼文、成員、附件與點名狀態。省略 since_seq 時回傳最近一頁。',
  inputSchema: {
    ...roomCredentials,
    since_seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  annotations: readOnly,
}, jsonResult(({ room_id, room_token, ...options }) => rooms.read(room_id, { ...options, ...asAgent(room_token) })));

server.registerTool('room_post', {
  description: '以你的房間成員身份貼文。正文的 @ 不觸發通知。接力點名時必須用 wake 列出成員別名，並以 reply_to_seq 指向點名給你的貼文。回覆結果通常只需貼文。',
  inputSchema: {
    ...roomCredentials,
    text: z.string().max(8000).optional(),
    wake: z.array(z.string().min(1).max(33)).max(32).optional(),
    reply_to_seq: seq.optional(),
    attachments: z.array(attachment).max(4).optional(),
    client_message_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional()
      .describe('重試同一則貼文時沿用此值'),
  },
  annotations: instructsAnotherAgent,
}, jsonResult(({ room_id, room_token, ...draft }) => rooms.post(room_id, draft, asAgent(room_token))));

server.registerTool('room_get_attachment', {
  description: '以附件 ID 取回圖片或文字和本機路徑。二進位檔提供本機路徑，工作區參考讀取目前檔案內容。',
  inputSchema: { ...roomCredentials, attachment_id: z.string().uuid() },
  annotations: readOnly,
}, ({ room_id, room_token, attachment_id }) => {
  try {
    return attachmentContent(rooms.attachment(room_id, attachment_id, asAgent(room_token)));
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
});

const effortSchema = z.enum(EFFORT_LEVELS).optional().describe(`推理強度（${EFFORT_LEVELS.join(' / ')}），省略時沿用工具預設`);
const terminalModeSchema = z.enum(TERMINAL_MODES).optional().describe(`開啟終端的方式（${TERMINAL_MODES.join(' / ')}），省略時沿用 ~/.session-bridge/config.json`);

server.registerTool('start_task', {
  description: `在前台獨立終端（Windows Terminal 分頁／分割視窗）開啟指定的 CLI（${providerNames.join(' / ')}）執行協作任務，讓使用者直接追蹤進度並在原生介面處理權限確認。任務完成該回合後終端維持互動，並透過 hook 自動記錄結果與回報發起端。`,
  inputSchema: {
    provider: source,
    cwd: z.string().max(1024).optional().describe('工作目錄的絕對路徑'),
    prompt: z.string().min(1).max(32000).describe('完整交辦內容、限制與驗收條件'),
    model: z.string().max(128).optional().describe('指定該工具使用的模型名稱（如 claude-opus-4-6、sonnet、gpt-5.4），省略時使用預設'),
    effort: effortSchema,
    terminal_mode: terminalModeSchema,
    from_source: source.optional().describe('發起端工具，與 from_id 一起提供時會在完成後自動回報'),
    from_id: z.string().max(128).optional().describe('發起端 session id'),
    room_id: roomId.optional().describe('帶入啟動提示的房間；由房主另行授予成員權限'),
  },
  annotations: instructsAnotherAgent,
}, jsonResult(tasks.start));

server.registerTool('resume_task', {
  description: '以原 provider（恢復原本的原生 session）或切換到另一個 provider 開啟新終端分頁繼續任務；可一併調整 model 或 effort。',
  inputSchema: {
    id: taskId,
    provider: source.optional(),
    prompt: z.string().max(32000).optional(),
    model: z.string().max(128).optional(),
    effort: effortSchema,
    terminal_mode: terminalModeSchema,
    room_id: roomId.optional().describe('帶入啟動提示的房間；預設沿用先前房間'),
  },
  annotations: instructsAnotherAgent,
}, jsonResult(tasks.resume));

server.registerTool('get_task', {
  description: '查看任務狀態、對應的原生 session id、完成摘要與基本用量紀錄。',
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
