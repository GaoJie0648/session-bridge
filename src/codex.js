import fs from 'node:fs';
import path from 'node:path';

import { firstRecord, label, oneLine, orElse, streamJsonl, truncate } from './util.js';

const SESSION_FILE = /-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.jsonl$/;
const SUMMARY_MAX = 200;
const TITLE_MAX = 200;
const CWD_MAX = 500;
const UNTITLED = '(無標題)';

const TOOL_SUMMARIES = {
  CommandExecution: (item) => `exec: ${[item.command ?? ''].flat().at(-1)}`,
  FileChange: (item) =>
    `file_change: ${Object.entries(item.changes ?? {}).map(([file, change]) => `${change?.type} ${file}`).join(', ')}`,
  McpToolCall: (item) => `mcp ${item.server}.${item.tool}: ${JSON.stringify(item.arguments ?? {})}`,
  Extension: (item) => `${item.kind}: ${item.query ?? ''}`,
  ImageView: (item) => `image_view: ${item.path}`,
};

const MESSAGE_ROLES = { UserMessage: 'user', AgentMessage: 'assistant' };

const messageText = (item) =>
  (item.content ?? []).map((part) => part?.text).filter(Boolean).join('\n');

const toEntry = (item) => {
  if (item.type === 'Reasoning') return null;
  const role = Object.hasOwn(MESSAGE_ROLES, item.type) ? MESSAGE_ROLES[item.type] : undefined;
  if (role) {
    const text = messageText(item);
    return text.trim() ? { role, text } : null;
  }
  const summarize = Object.hasOwn(TOOL_SUMMARIES, item.type) ? TOOL_SUMMARIES[item.type] : () => String(item.type);
  return { role: 'tool', text: truncate(oneLine(summarize(item)), SUMMARY_MAX) };
};

async function* codexEntries(file, detailIndex) {
  let index = 0;
  for await (const record of streamJsonl(file, (line) => line.includes('"item_completed"'))) {
    const item = record.payload?.item;
    const entry = record.payload?.type === 'item_completed' && item ? toEntry(item) : null;
    if (!entry) continue;
    const detail = index === detailIndex && entry.role === 'tool' ? { detail: JSON.stringify(item, null, 2) } : {};
    yield { index, role: entry.role, timestamp: record.timestamp, text: entry.text, ...detail };
    index += 1;
  }
}

/**
 * @param {string} file
 * @param {{ detailIndex?: number }} [options] 僅對 detailIndex 那一則工具紀錄附上完整內容，避免大型 session 佔滿記憶體
 */
export const readCodexEntries = (file, { detailIndex = -1 } = {}) =>
  Array.fromAsync(codexEntries(file, detailIndex));

const readTitles = async (root) => {
  const index = path.join(root, 'session_index.jsonl');
  if (!fs.existsSync(index)) return new Map();
  const records = await Array.fromAsync(streamJsonl(index));
  return new Map(records.map((record) => [record.id, record.thread_name]));
};

const describeSession = async (file, titles) => {
  const meta = await firstRecord(file);
  const payload = meta?.type === 'session_meta' ? meta.payload : null;
  // id 必須與檔名一致，避免檔案內容冒用其他 session 的 id
  if (!payload || !file.endsWith(`-${payload.id}.jsonl`)) return null;
  // source 為物件代表 subagent（如 guardian）的內部 session，不是使用者的對話
  if (payload.source && typeof payload.source === 'object') return null;
  const { mtime } = await fs.promises.stat(file);
  return {
    source: 'codex',
    id: payload.id,
    title: label(titles.get(payload.id), TITLE_MAX) || UNTITLED,
    cwd: label(payload.cwd, CWD_MAX),
    startedAt: payload.timestamp ?? meta.timestamp,
    updatedAt: mtime.toISOString(),
    file,
  };
};

/** @param {string} root Codex 的家目錄（預設 ~/.codex） */
export const listCodexSessions = async (root) => {
  const dir = path.join(root, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const dirents = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
  const files = dirents
    .filter((dirent) => dirent.isFile() && SESSION_FILE.test(dirent.name))
    .map((dirent) => path.join(dirent.parentPath, dirent.name));
  const titles = await readTitles(root);
  const sessions = await Promise.all(files.map((file) => orElse(describeSession, null)(file, titles)));
  return sessions.filter(Boolean);
};
