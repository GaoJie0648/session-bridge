import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { defaultHome } from '../config.js';
import {
  UUID_PATTERN,
  atomicJson,
  findOnPath,
  label,
  oneLine,
  orElse,
  readJsonOr,
  streamJsonl,
  truncate,
} from '../util.js';

const SUMMARY_MAX = 200;
const TITLE_MAX = 200;
const PROMPT_TITLE_MAX = 60;
const CWD_MAX = 500;
const HEAD_RECORDS = 80;
const UNTITLED = '(無標題)';

export const defaultAgyRoot = (env = process.env) =>
  env.AGY_HOME ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');

export const defaultGeminiConfigDir = (env = process.env) =>
  env.GEMINI_CONFIG_DIR ?? path.join(os.homedir(), '.gemini', 'config');

// 擷取 <USER_REQUEST> 區塊內的純使用者訊息，移除系統 metadata 包裝
const extractUserRequest = (raw) => {
  const text = String(raw ?? '');
  const match = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (match ? match[1] : text).trim();
};

const summarizeToolCall = (call) =>
  truncate(oneLine(`${call.name ?? 'tool'}: ${JSON.stringify(call.args ?? {})}`), SUMMARY_MAX);

async function* agyEntries(file, detailIndex) {
  let index = 0;
  let pendingToolIndex = -1;
  let pendingToolDetail = null;
  for await (const record of streamJsonl(file)) {
    if (record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') {
      const text = extractUserRequest(record.content);
      if (text) {
        yield { index, role: 'user', timestamp: record.created_at ?? '', text };
        index += 1;
      }
      continue;
    }
    if (record.type === 'PLANNER_RESPONSE') {
      const text = String(record.content ?? '').trim();
      if (text) {
        yield { index, role: 'assistant', timestamp: record.created_at ?? '', text };
        index += 1;
      }
      if (Array.isArray(record.tool_calls)) {
        for (const call of record.tool_calls) {
          const isTarget = index === detailIndex;
          if (isTarget) {
            pendingToolIndex = index;
            pendingToolDetail = call;
          }
          yield {
            index,
            role: 'tool',
            timestamp: record.created_at ?? '',
            text: summarizeToolCall(call),
            ...(isTarget ? { _call: call } : {}),
          };
          index += 1;
        }
      }
      continue;
    }
    if (record.type === 'GENERIC' && pendingToolIndex === detailIndex && pendingToolDetail) {
      yield { _toolOutput: String(record.content ?? '') };
      pendingToolDetail = null;
    }
  }
}

export const readAgyEntries = async (file, { detailIndex = -1 } = {}) => {
  const raw = await Array.fromAsync(agyEntries(file, detailIndex));
  const output = raw.find((item) => '_toolOutput' in item)?._toolOutput;
  return raw
    .filter((item) => item.role)
    .map(({ _call, ...entry }) =>
      entry.index === detailIndex && entry.role === 'tool'
        ? { ...entry, detail: `輸入：\n${JSON.stringify(_call ?? {}, null, 2)}\n\n輸出：\n${output ?? '(無輸出紀錄)'}` }
        : entry);
};

export const readAgyUsage = async (file) => {
  let model = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let turns = 0;
  for await (const record of streamJsonl(file, (line) => line.includes('"PLANNER_RESPONSE"'))) {
    if (record.type !== 'PLANNER_RESPONSE') continue;
    if (record.model) model = record.model;
    inputTokens += Number(record.input_tokens ?? 0);
    outputTokens += Number(record.output_tokens ?? 0);
    cacheReadTokens += Number(record.cache_read_tokens ?? 0);
    turns += 1;
  }
  return { model, inputTokens, outputTokens, cacheReadTokens, turns };
};

const metaFileFor = (home, id) => path.join(home, 'meta', `agy-${id.toLowerCase()}.json`);

/** 記錄 Antigravity session 的 cwd（由 SessionStart hook 寫入，不更動 .gemini 內部檔案） */
export const recordAgySessionMeta = async (id, meta, home = defaultHome()) => {
  if (!UUID_PATTERN.test(id)) return;
  await atomicJson(metaFileFor(home, id), { id, ...meta, updatedAt: new Date().toISOString() });
};

const readHead = async (file) => {
  let startedAt;
  let firstPrompt;
  let seen = 0;
  for await (const record of streamJsonl(file)) {
    startedAt ??= record.created_at;
    if (!firstPrompt && record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') {
      firstPrompt = extractUserRequest(record.content) || undefined;
    }
    seen += 1;
    if ((startedAt && firstPrompt) || seen >= HEAD_RECORDS) break;
  }
  return { startedAt, firstPrompt };
};

const describeSession = async (id, file, home) => {
  const head = await readHead(file);
  if (!head.startedAt) return null;
  const { mtime } = await fsp.stat(file);
  const meta = await readJsonOr(metaFileFor(home, id), null).catch(() => null);
  return {
    source: 'agy',
    id,
    title: label(meta?.title ?? head.firstPrompt, PROMPT_TITLE_MAX) || label(head.firstPrompt, TITLE_MAX) || UNTITLED,
    cwd: label(meta?.cwd ?? '', CWD_MAX),
    startedAt: head.startedAt,
    updatedAt: mtime.toISOString(),
    file,
  };
};

export const listAgySessions = async (root = defaultAgyRoot(), home = defaultHome()) => {
  if (!fs.existsSync(root)) return [];
  const dirents = await fsp.readdir(root, { withFileTypes: true });
  const candidates = dirents
    .filter((dirent) => dirent.isDirectory() && UUID_PATTERN.test(dirent.name))
    .map((dirent) => ({
      id: dirent.name,
      file: path.join(root, dirent.name, '.system_generated', 'logs', 'transcript.jsonl'),
    }))
    .filter(({ file }) => fs.existsSync(file));
  const sessions = await Promise.all(
    candidates.map(({ id, file }) => orElse(describeSession, null)(id, file, home)),
  );
  return sessions.filter(Boolean);
};

export const resolveAgyCommand = (env = process.env, platform = process.platform) => {
  if (env.SESSION_BRIDGE_AGY) return env.SESSION_BRIDGE_AGY;
  const fromPath = findOnPath(['agy'], env, platform);
  if (fromPath) return fromPath;
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const candidate = path.join(localAppData, 'agy', 'bin', 'agy.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'agy';
};

export const createAgyProvider = ({
  root,
  home = defaultHome(),
  env = process.env,
  platform = process.platform,
} = {}) => ({
  name: 'agy',
  displayName: 'Antigravity CLI',
  idPattern: UUID_PATTERN,
  supportsInboxWaiter: false,
  supportsSyncInboxCheck: true,
  listSessions: () => listAgySessions(root ?? defaultAgyRoot(env), home),
  readEntries: readAgyEntries,
  readUsage: readAgyUsage,
  buildManagedSpec: () => ({
    executable: resolveAgyCommand(env, platform), args: ['acp', '--stdio'], kind: 'acp',
  }),
  buildLaunchSpec: ({ model, effort, resumeSessionId }) => {
    const args = [];
    if (resumeSessionId) args.push('--conversation', resumeSessionId);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return {
      executable: resolveAgyCommand(env, platform),
      args,
      promptFlag: '-i',
    };
  },
  parseHookInput: (raw) => ({
    event: raw?.hookEventName ?? '',
    sessionId: raw?.conversationId ?? '',
    cwd: raw?.cwd ?? raw?.workspacePaths?.[0] ?? '',
    transcriptPath: raw?.transcriptPath ?? '',
    lastMessage: undefined,
    prompt: raw?.lastUserInput,
  }),
  formatHookOutput: ({ event, injectText, wakeMessages }) => {
    if (event === 'SessionStart' && injectText) {
      return {
        stdout: JSON.stringify({
          injectSteps: [{ systemMessage: { systemMessage: injectText } }],
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (event === 'PreInvocation' && wakeMessages?.length) {
      return {
        stdout: JSON.stringify({
          injectSteps: [{ systemMessage: { systemMessage: wakeMessages.join('\n\n---\n\n') } }],
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (event === 'Stop' && wakeMessages?.length) {
      return {
        stdout: JSON.stringify({
          decision: 'continue',
          reason: wakeMessages.join('\n\n---\n\n'),
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '{}', stderr: '', exitCode: 0 };
  },
  installHook: async (hookScriptPath) => {
    const hooksFile = path.join(defaultGeminiConfigDir(env), 'hooks.json');
    const current = (await readJsonOr(hooksFile, {})) ?? {};
    const cmd = `node "${hookScriptPath.replaceAll('\\', '/')}" agy`;
    const next = {
      ...current,
      'session-bridge': {
        enabled: true,
        SessionStart: [{ type: 'command', command: cmd, timeout: 15 }],
        PreInvocation: [{ type: 'command', command: cmd, timeout: 15 }],
        Stop: [{ type: 'command', command: cmd, timeout: 30 }],
      },
    };
    await atomicJson(hooksFile, next);
    return hooksFile;
  },
  installMcp: async (serverScriptPath) => {
    const mcpFile = path.join(defaultGeminiConfigDir(env), 'mcp_config.json');
    const current = (await readJsonOr(mcpFile, {})) ?? {};
    const mcpServers = current.mcpServers && typeof current.mcpServers === 'object' ? { ...current.mcpServers } : {};
    mcpServers['session-bridge'] = {
      command: 'node',
      args: [serverScriptPath.replaceAll('\\', '/')],
    };
    await atomicJson(mcpFile, { ...current, mcpServers });
    return mcpFile;
  },
  doctor: async () => {
    const bin = env.SESSION_BRIDGE_AGY ?? findOnPath(['agy'], env, platform);
    const hooksFile = path.join(defaultGeminiConfigDir(env), 'hooks.json');
    const hooksData = await readJsonOr(hooksFile, null).catch(() => null);
    const hooksConfigured = Boolean(hooksData?.['session-bridge']);
    const mcpFile = path.join(defaultGeminiConfigDir(env), 'mcp_config.json');
    const mcpData = await readJsonOr(mcpFile, null).catch(() => null);
    const mcpConfigured = Boolean(mcpData?.mcpServers?.['session-bridge']);
    return {
      provider: 'agy',
      executable: bin,
      executableOk: Boolean(bin),
      mcpFile,
      mcpConfigured,
      hooksFile,
      hooksConfigured,
      sessionsDir: root ?? defaultAgyRoot(env),
      sessionsDirExists: fs.existsSync(root ?? defaultAgyRoot(env)),
    };
  },
});
