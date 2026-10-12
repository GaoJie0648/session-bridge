import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const QUEUE_TIMEOUT_MS = 30_000;

// npm 在 Windows 裝的 codex 是 .cmd，只能經 shell 執行；為了不讓訊息內容被 shell 解析，改以 node 直接執行它包裝的 codex.js
const windowsCommand = (env) => {
  // 相對路徑會解析到目前的專案目錄，那裡的 codex 不可信
  const dirs = (env.Path ?? env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const firstExisting = (...segments) =>
    dirs.map((dir) => path.join(dir, ...segments)).find((candidate) => fs.existsSync(candidate));
  const script = firstExisting('node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (script) return [process.execPath, script];
  const executable = firstExisting('codex.exe');
  if (executable) return [executable];
  throw new Error('找不到 codex 指令；請確認 Codex CLI 已安裝，或以環境變數 SESSION_BRIDGE_CODEX 指定 codex 執行檔路徑。');
};

/** @returns {string[]} 執行檔與前置參數 */
export const resolveCodexCommand = (env = process.env, platform = process.platform) => {
  const override = env.SESSION_BRIDGE_CODEX;
  if (override) return override.endsWith('.js') ? [process.execPath, override] : [override];
  return platform === 'win32' ? windowsCommand(env) : ['codex'];
};

/** 以 `codex queue` 把訊息送進既有的 Codex session：閒置時會喚醒它，忙碌時排在目前回合之後 */
export const createCodexQueue = (env = process.env) => async (threadId, text) => {
  const [command, ...prefix] = resolveCodexCommand(env);
  try {
    await run(command, [...prefix, 'queue', '--thread', threadId, '--message', text], {
      timeout: QUEUE_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    // execFile 的錯誤訊息會帶出整條命令列，也就是整段訊息本文
    const detail = String(error.stderr ?? '').trim().slice(0, 200);
    throw new Error(`codex queue 失敗（${error.code ?? '未知錯誤'}）${detail ? `：${detail}` : ''}`);
  }
};
