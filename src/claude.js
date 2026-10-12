import fs from 'node:fs';
import path from 'node:path';

import { label, oneLine, orElse, parseJson, streamJsonl, truncate } from './util.js';

const SESSION_FILE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.jsonl$/;
const SUMMARY_MAX = 200;
const TITLE_MAX = 200;
const PROMPT_TITLE_MAX = 60;
const CWD_MAX = 500;
const HEAD_RECORDS = 500;
const TAIL_BYTES = 256 * 1024;
const UNTITLED = '(無標題)';

const isConversation = (record) =>
  (record.type === 'user' || record.type === 'assistant') && !record.isMeta && !record.isSidechain;

const toBlocks = (content) => {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : [];
};

const blocksText = (content) =>
  toBlocks(content).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');

const toPiece = (block, record) => {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
    return { role: record.type, timestamp: record.timestamp, text: block.text };
  }
  if (block.type === 'tool_use') {
    const text = truncate(oneLine(`${block.name}: ${JSON.stringify(block.input ?? {})}`), SUMMARY_MAX);
    return { role: 'tool', timestamp: record.timestamp, text };
  }
  return null;
};

// 只保留 detailIndex 那一則工具呼叫的輸入與輸出，其餘工具內容不留在記憶體
async function* claudePieces(file, detailIndex) {
  let index = 0;
  let targetToolId;
  for await (const record of streamJsonl(file)) {
    if (!isConversation(record)) continue;
    for (const block of toBlocks(record.message?.content)) {
      if (block.type === 'tool_result' && block.tool_use_id === targetToolId) {
        yield { output: blocksText(block.content) };
      }
      const piece = toPiece(block, record);
      if (!piece) continue;
      const isTarget = index === detailIndex && piece.role === 'tool';
      if (isTarget) targetToolId = block.id;
      yield { ...piece, index, ...(isTarget ? { input: block.input } : {}) };
      index += 1;
    }
  }
}

const toolDetail = (input, output) =>
  `輸入：\n${JSON.stringify(input ?? {}, null, 2)}\n\n輸出：\n${output ?? '(無輸出紀錄)'}`;

/**
 * @param {string} file
 * @param {{ detailIndex?: number }} [options] 僅對 detailIndex 那一則工具紀錄附上完整輸入與輸出
 */
export const readClaudeEntries = async (file, { detailIndex = -1 } = {}) => {
  const pieces = await Array.fromAsync(claudePieces(file, detailIndex));
  const output = pieces.find((piece) => 'output' in piece)?.output;
  return pieces
    .filter((piece) => piece.role)
    .map(({ input, ...entry }) =>
      entry.index === detailIndex && entry.role === 'tool' ? { ...entry, detail: toolDetail(input, output) } : entry);
};

const promptOf = (record) =>
  (record.type === 'user' && isConversation(record) && blocksText(record.message?.content).trim()) || undefined;

const mergeHead = (head, record) => ({
  cwd: head.cwd ?? record.cwd,
  startedAt: head.startedAt ?? record.timestamp,
  firstPrompt: head.firstPrompt ?? promptOf(record),
});

const readHead = async (file) => {
  let head = {};
  let seen = 0;
  // 沒有使用者 prompt 的 session 不值得為了標題掃完整個檔案
  for await (const record of streamJsonl(file)) {
    head = mergeHead(head, record);
    seen += 1;
    if ((head.cwd && head.startedAt && head.firstPrompt) || seen >= HEAD_RECORDS) break;
  }
  return head;
};

// Claude Code 每回合結束都會在檔尾重寫 ai-title，只讀檔尾即可，不必掃完數百 MB 的檔案
const readTailTitle = async (file, size) => {
  const length = Math.min(size, TAIL_BYTES);
  const handle = await fs.promises.open(file);
  try {
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    return buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.includes('"ai-title"'))
      .map(parseJson)
      .findLast((record) => record?.type === 'ai-title')?.aiTitle;
  } finally {
    await handle.close();
  }
};

const describeSession = async (file) => {
  const head = await readHead(file);
  if (!head.startedAt) return null;
  const { mtime, size } = await fs.promises.stat(file);
  const title = await readTailTitle(file, size);
  return {
    source: 'claude',
    id: path.basename(file, '.jsonl'),
    title: label(title, TITLE_MAX) || label(head.firstPrompt, PROMPT_TITLE_MAX) || UNTITLED,
    cwd: label(head.cwd, CWD_MAX),
    startedAt: head.startedAt,
    updatedAt: mtime.toISOString(),
    file,
  };
};

/** @param {string} root Claude Code 的 projects 目錄（預設 ~/.claude/projects） */
export const listClaudeSessions = async (root) => {
  if (!fs.existsSync(root)) return [];
  const projects = (await fs.promises.readdir(root, { withFileTypes: true })).filter((dirent) => dirent.isDirectory());
  const fileLists = await Promise.all(
    projects.map(async (project) => {
      const dir = path.join(root, project.name);
      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      return dirents
        .filter((dirent) => dirent.isFile() && SESSION_FILE.test(dirent.name))
        .map((dirent) => path.join(dir, dirent.name));
    }),
  );
  const sessions = await Promise.all(fileLists.flat().map((file) => orElse(describeSession, null)(file)));
  return sessions.filter(Boolean);
};
