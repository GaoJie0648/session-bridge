import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  UUID_PATTERN,
  atomicJson,
  findOnPath,
  firstRecord,
  label,
  oneLine,
  orElse,
  readJsonOr,
  streamJsonl,
  truncate,
} from '../util.js';

const run = promisify(execFile);
const QUEUE_TIMEOUT_MS = 30_000;
const SESSION_FILE = /-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.jsonl$/;
const SUMMARY_MAX = 200;
const TITLE_MAX = 200;
const CWD_MAX = 500;
const UNTITLED = '(無標題)';

export const defaultCodexRoot = (env = process.env) => env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

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

export const readCodexEntries = (file, { detailIndex = -1 } = {}) =>
  Array.fromAsync(codexEntries(file, detailIndex));

export const readCodexUsage = async (file) => {
  let model = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let turns = 0;
  let rateLimits = null;
  for await (const record of streamJsonl(file, (line) => line.includes('"token_count"') || line.includes('"turn_context"'))) {
    if (record.type === 'turn_context') {
      if (record.payload?.model) model = record.payload.model;
      turns += 1;
    }
    if (record.type === 'event_msg' && record.payload?.type === 'token_count') {
      const total = record.payload.info?.total_token_usage;
      if (total) {
        inputTokens = Number(total.input_tokens ?? inputTokens);
        outputTokens = Number(total.output_tokens ?? outputTokens);
        cacheReadTokens = Number(total.cached_input_tokens ?? cacheReadTokens);
      }
      if (record.payload.rate_limits) rateLimits = record.payload.rate_limits;
    }
  }
  return { model, inputTokens, outputTokens, cacheReadTokens, turns, rateLimits };
};

const readTitles = async (root) => {
  const index = path.join(root, 'session_index.jsonl');
  if (!fs.existsSync(index)) return new Map();
  const records = await Array.fromAsync(streamJsonl(index));
  return new Map(records.map((record) => [record.id, record.thread_name]));
};

const describeSession = async (file, titles) => {
  const meta = await firstRecord(file);
  const payload = meta?.type === 'session_meta' ? meta.payload : null;
  if (!payload || !file.endsWith(`-${payload.id}.jsonl`)) return null;
  if (payload.source && typeof payload.source === 'object') return null;
  const { mtime } = await fsp.stat(file);
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

export const listCodexSessions = async (root = defaultCodexRoot()) => {
  const dir = path.join(root, 'sessions');
  if (!fs.existsSync(dir)) return [];
  const dirents = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  const files = dirents
    .filter((dirent) => dirent.isFile() && SESSION_FILE.test(dirent.name))
    .map((dirent) => path.join(dirent.parentPath, dirent.name));
  const titles = await readTitles(root);
  const sessions = await Promise.all(files.map((file) => orElse(describeSession, null)(file, titles)));
  return sessions.filter(Boolean);
};

const windowsCodexCommand = (env) => {
  const dirs = (env.Path ?? env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const firstExisting = (...segments) =>
    dirs.map((dir) => path.join(dir, ...segments)).find((candidate) => fs.existsSync(candidate));
  const executable = firstExisting('codex.exe');
  if (executable) return [executable];
  const script = firstExisting('node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (script) return [process.execPath, script];
  const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const standardExe = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  if (fs.existsSync(standardExe)) return [standardExe];
  const standardScript = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(standardScript)) return [process.execPath, standardScript];
  throw new Error('找不到 codex 指令；請確認 Codex CLI 已安裝，或以環境變數 SESSION_BRIDGE_CODEX 指定 codex 執行檔路徑。');
};

export const resolveCodexCommand = (env = process.env, platform = process.platform) => {
  const override = env.SESSION_BRIDGE_CODEX;
  if (override) return override.endsWith('.js') ? [process.execPath, override] : [override];
  return platform === 'win32' ? windowsCodexCommand(env) : ['codex'];
};

export const createCodexQueue = (env = process.env, platform = process.platform) => async (threadId, text) => {
  const [command, ...prefix] = resolveCodexCommand(env, platform);
  try {
    await run(command, [...prefix, 'queue', '--thread', threadId, '--message', text], {
      timeout: QUEUE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    const detail = String(error.stderr ?? '').trim().slice(0, 200);
    throw new Error(`codex queue 失敗（${error.code ?? '未知錯誤'}）${detail ? `：${detail}` : ''}`);
  }
};

export const createCodexProvider = ({
  root,
  deliver,
  env = process.env,
  platform = process.platform,
} = {}) => ({
  name: 'codex',
  displayName: 'Codex CLI',
  idPattern: UUID_PATTERN,
  supportsInboxWaiter: false,
  deliverMessage: deliver ?? createCodexQueue(env, platform),
  listSessions: () => listCodexSessions(root ?? defaultCodexRoot(env)),
  readEntries: readCodexEntries,
  readUsage: readCodexUsage,
  buildManagedSpec: () => {
    const [executable, ...prefix] = resolveCodexCommand(env, platform);
    return { executable, args: [...prefix, 'app-server', '--listen', 'stdio://'], kind: 'codex' };
  },
  buildLaunchSpec: ({ cwd, model, effort, resumeSessionId }) => {
    const [executable, ...prefix] = resolveCodexCommand(env, platform);
    const args = [...prefix];
    if (resumeSessionId) {
      args.push('resume');
      if (model) args.push('-c', `model="${model}"`);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      args.push(resumeSessionId);
    } else {
      if (cwd) args.push('-C', cwd);
      if (model) args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    }
    return {
      executable,
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
  formatHookOutput: ({ event, injectText }) => {
    if (event === 'SessionStart' && injectText) {
      return { stdout: injectText, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  installHook: async (hookScriptPath) => {
    const hooksFile = path.join(defaultCodexRoot(env), 'hooks.json');
    const current = (await readJsonOr(hooksFile, {})) ?? {};
    const hooks = current.hooks && typeof current.hooks === 'object' ? { ...current.hooks } : {};
    const cmd = `node "${hookScriptPath.replaceAll('\\', '/')}" codex`;
    const isBridgeHook = (entry) => JSON.stringify(entry).includes('session-bridge') && JSON.stringify(entry).includes('hook.js');
    const filterOthers = (list) => (Array.isArray(list) ? list.filter((item) => !isBridgeHook(item)) : []);
    hooks.SessionStart = [...filterOthers(hooks.SessionStart), { hooks: [{ type: 'command', command: cmd, timeout: 15 }] }];
    hooks.UserPromptSubmit = [...filterOthers(hooks.UserPromptSubmit), { hooks: [{ type: 'command', command: cmd, timeout: 15 }] }];
    hooks.Stop = [...filterOthers(hooks.Stop), { hooks: [{ type: 'command', command: cmd, timeout: 60 }] }];
    await atomicJson(hooksFile, { ...current, hooks });
    return hooksFile;
  },
  installMcp: async (serverScriptPath) => {
    const [bin, ...prefix] = resolveCodexCommand(env, platform);
    const script = serverScriptPath.replaceAll('\\', '/');
    await run(bin, [...prefix, 'mcp', 'remove', 'session-bridge'], { timeout: 15_000, windowsHide: true }).catch(() => {});
    await run(bin, [...prefix, 'mcp', 'add', 'session-bridge', '--', 'node', script], { timeout: 15_000, windowsHide: true });
    return 'codex mcp';
  },
  doctor: async () => {
    let bin = null;
    let cmd = null;
    try {
      cmd = resolveCodexCommand(env, platform);
      bin = cmd.join(' ');
    } catch {
      const found = findOnPath(['codex'], env, platform);
      if (found) {
        cmd = [found];
        bin = found;
      }
    }
    const hooksFile = path.join(defaultCodexRoot(env), 'hooks.json');
    const hooksData = await readJsonOr(hooksFile, null).catch(() => null);
    const hooksConfigured = Boolean(hooksData?.hooks && JSON.stringify(hooksData.hooks).includes('hook.js'));
    let mcpConfigured = false;
    if (cmd) {
      mcpConfigured = await run(cmd[0], [...cmd.slice(1), 'mcp', 'get', 'session-bridge'], { timeout: 5_000, windowsHide: true })
        .then(() => true)
        .catch(() => false);
    }
    return {
      provider: 'codex',
      executable: bin,
      executableOk: Boolean(bin),
      mcpConfigured,
      hooksFile,
      hooksConfigured,
      sessionsDir: path.join(root ?? defaultCodexRoot(env), 'sessions'),
      sessionsDirExists: fs.existsSync(path.join(root ?? defaultCodexRoot(env), 'sessions')),
    };
  },
});
