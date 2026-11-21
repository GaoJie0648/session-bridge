import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const runExec = promisify(execFile);

import {
  UUID_PATTERN,
  atomicJson,
  findOnPath,
  isWithin,
  label,
  oneLine,
  orElse,
  parseJson,
  readJsonOr,
  streamJsonl,
  truncate,
} from '../util.js';

const SESSION_FILE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.jsonl$/;
const SUMMARY_MAX = 200;
const TITLE_MAX = 200;
const PROMPT_TITLE_MAX = 60;
const CWD_MAX = 500;
const HEAD_RECORDS = 500;
const TAIL_BYTES = 256 * 1024;
const UNTITLED = '(無標題)';

export const defaultClaudeConfigDir = (env = process.env) =>
  env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');

export const defaultClaudeRoot = (env = process.env) =>
  path.join(defaultClaudeConfigDir(env), 'projects');

const isConversation = (record) =>
  (record.type === 'user' || record.type === 'assistant') && !record.isMeta && !record.isSidechain;

const toBlocks = (content) => {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : [];
};

const blocksText = (content) =>
  toBlocks(content)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');

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

export const readClaudeEntries = async (file, { detailIndex = -1 } = {}) => {
  const pieces = await Array.fromAsync(claudePieces(file, detailIndex));
  const output = pieces.find((piece) => 'output' in piece)?.output;
  return pieces
    .filter((piece) => piece.role)
    .map(({ input, ...entry }) =>
      entry.index === detailIndex && entry.role === 'tool' ? { ...entry, detail: toolDetail(input, output) } : entry);
};

export const readClaudeUsage = async (file) => {
  let model = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let turns = 0;
  const seenMsgIds = new Set();
  for await (const record of streamJsonl(file, (line) => line.includes('"usage"'))) {
    if (record.type !== 'assistant' || !record.message?.usage) continue;
    const msgId = record.message.id;
    if (msgId && seenMsgIds.has(msgId)) continue;
    if (msgId) seenMsgIds.add(msgId);
    const usage = record.message.usage;
    if (record.message.model) model = record.message.model;
    inputTokens += Number(usage.input_tokens ?? 0);
    outputTokens += Number(usage.output_tokens ?? 0);
    cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0);
    cacheWriteTokens += Number(usage.cache_creation_input_tokens ?? 0);
    turns += 1;
  }
  return { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns };
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
  for await (const record of streamJsonl(file)) {
    head = mergeHead(head, record);
    seen += 1;
    if ((head.cwd && head.startedAt && head.firstPrompt) || seen >= HEAD_RECORDS) break;
  }
  return head;
};

const readTailTitle = async (file, size) => {
  const length = Math.min(size, TAIL_BYTES);
  const handle = await fsp.open(file);
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
  const { mtime, size } = await fsp.stat(file);
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

export const listClaudeSessions = async (root = defaultClaudeRoot()) => {
  if (!fs.existsSync(root)) return [];
  const projects = (await fsp.readdir(root, { withFileTypes: true })).filter((dirent) => dirent.isDirectory());
  const fileLists = await Promise.all(
    projects.map(async (project) => {
      const dir = path.join(root, project.name);
      const dirents = await fsp.readdir(dir, { withFileTypes: true });
      return dirents
        .filter((dirent) => dirent.isFile() && SESSION_FILE.test(dirent.name))
        .map((dirent) => path.join(dir, dirent.name));
    }),
  );
  const sessions = await Promise.all(fileLists.flat().map((file) => orElse(describeSession, null)(file)));
  return sessions.filter(Boolean);
};

export const resolveClaudeCommand = (env = process.env, platform = process.platform) => {
  if (env.SESSION_BRIDGE_CLAUDE) return env.SESSION_BRIDGE_CLAUDE;
  const fromPath = findOnPath(['claude'], env, platform);
  if (fromPath) return fromPath;
  if (platform === 'win32') {
    const candidate = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'claude';
};

export const createClaudeProvider = ({ root, env = process.env, platform = process.platform } = {}) => ({
  name: 'claude',
  displayName: 'Claude Code',
  idPattern: UUID_PATTERN,
  supportsInboxWaiter: true,
  workspaceTrust: async (cwd) => {
    const userHome = os.homedir();
    if (isWithin(cwd, userHome) && isWithin(userHome, cwd)) return false;
    const configFile = env.CLAUDE_CONFIG_DIR
      ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
      : path.join(userHome, '.claude.json');
    const config = await readJsonOr(configFile, null).catch(() => null);
    const project = Object.entries(config?.projects ?? {}).find(([dir]) =>
      isWithin(cwd, dir) && isWithin(dir, cwd));
    return project?.[1]?.hasTrustDialogAccepted;
  },
  listSessions: () => listClaudeSessions(root ?? defaultClaudeRoot(env)),
  readEntries: readClaudeEntries,
  readUsage: readClaudeUsage,
  buildLaunchSpec: ({ model, effort, resumeSessionId }) => {
    const args = [];
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return {
      executable: resolveClaudeCommand(env, platform),
      args,
      promptFlag: null,
    };
  },
  parseHookInput: (raw) => ({
    event: raw?.hook_event_name ?? '',
    sessionId: raw?.session_id ?? '',
    cwd: raw?.cwd ?? '',
    transcriptPath: raw?.transcript_path ?? '',
    lastMessage: typeof raw?.last_assistant_message === 'string' ? raw.last_assistant_message : undefined,
    prompt: raw?.prompt,
  }),
  formatHookOutput: ({ event, injectText, wakeMessages }) => {
    if (event === 'SessionStart' && injectText) {
      return { stdout: injectText, stderr: '', exitCode: 0 };
    }
    if (event === 'Stop' && wakeMessages?.length) {
      // Claude Code 的 asyncRewake hook 以結束碼 2 喚醒模型，stderr 內容會交給它
      // Claude Code 會把這段標成 Stop hook blocking error，第一行先講明來意
      const notice = 'session-bridge 協作通知（不是錯誤）：以下是其他 session 送來的訊息。';
      return { stdout: '', stderr: `${notice}\n\n${wakeMessages.join('\n\n---\n\n')}`, exitCode: 2 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  installHook: async (hookScriptPath) => {
    const settingsFile = path.join(defaultClaudeConfigDir(env), 'settings.json');
    const current = (await readJsonOr(settingsFile, {})) ?? {};
    const hooks = current.hooks && typeof current.hooks === 'object' ? { ...current.hooks } : {};
    const script = hookScriptPath.replaceAll('\\', '/');
    const isBridgeHook = (entry) => JSON.stringify(entry).includes('session-bridge') && JSON.stringify(entry).includes('hook.js');
    const filterOthers = (list) => (Array.isArray(list) ? list.filter((item) => !isBridgeHook(item)) : []);
    hooks.SessionStart = [
      ...filterOthers(hooks.SessionStart),
      { hooks: [{ type: 'command', command: 'node', args: [script, 'claude'], timeout: 15 }] },
    ];
    hooks.Stop = [
      ...filterOthers(hooks.Stop),
      { hooks: [{ type: 'command', command: 'node', args: [script, 'claude'], asyncRewake: true, timeout: 21700 }] },
    ];
    await atomicJson(settingsFile, { ...current, hooks });
    return settingsFile;
  },
  installMcp: async (serverScriptPath) => {
    const bin = resolveClaudeCommand(env, platform);
    const script = serverScriptPath.replaceAll('\\', '/');
    await runExec(bin, ['mcp', 'remove', 'session-bridge', '-s', 'user'], { timeout: 15_000, windowsHide: true }).catch(() => {});
    await runExec(bin, ['mcp', 'add', '--scope', 'user', 'session-bridge', '--', 'node', script], { timeout: 15_000, windowsHide: true });
    return 'claude mcp (user scope)';
  },
  doctor: async () => {
    const bin = env.SESSION_BRIDGE_CLAUDE ?? findOnPath(['claude'], env, platform);
    const settingsFile = path.join(defaultClaudeConfigDir(env), 'settings.json');
    const settings = await readJsonOr(settingsFile, null).catch(() => null);
    const hooksConfigured = Boolean(settings?.hooks && JSON.stringify(settings.hooks).includes('hook.js'));
    let mcpConfigured = false;
    if (bin) {
      mcpConfigured = await runExec(bin, ['mcp', 'get', 'session-bridge'], { timeout: 5_000, windowsHide: true })
        .then(() => true)
        .catch(() => false);
    }
    return {
      provider: 'claude',
      executable: bin,
      executableOk: Boolean(bin),
      mcpConfigured,
      hooksFile: settingsFile,
      hooksConfigured,
      sessionsDir: root ?? defaultClaudeRoot(env),
      sessionsDirExists: fs.existsSync(root ?? defaultClaudeRoot(env)),
    };
  },
});
