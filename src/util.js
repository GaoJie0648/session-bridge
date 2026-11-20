import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
// 保留舊匯出名稱相容；新 provider 可在 adapter 中指定較寬鬆的 idPattern
export const SESSION_ID = UUID_PATTERN;
// 通用的安全 session id（允許 UUID 或英數、底線、連字號，禁止路徑穿越字元）
export const SAFE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * 進行中的 session 最後一行可能尚未寫完，無法解析的行回傳 null 而不拋錯
 * @param {string} line
 */
export const parseJson = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * @param {string} file
 * @param {(line: string) => boolean} [wanted] 在 JSON.parse 前先以原始字串過濾，避免解析用不到的大型紀錄
 * @returns {AsyncGenerator<any>}
 */
export async function* streamJsonl(file, wanted = () => true) {
  const input = fs.createReadStream(file, 'utf8');
  try {
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!line || !wanted(line)) continue;
      const record = parseJson(line);
      if (record && typeof record === 'object') yield record;
    }
  } finally {
    input.destroy();
  }
}

/** @param {string} file */
export const firstRecord = async (file) => {
  for await (const record of streamJsonl(file)) return record;
  return null;
};

/**
 * @param {string} text
 * @param {number} max
 */
export const truncate = (text, max) =>
  text.length > max ? `${text.slice(0, max)}…(共 ${text.length} 字)` : text;

/** @param {string} text */
export const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * 標題、路徑等欄位來自 session 檔內容，輸出前壓成單行並限制長度
 * @param {unknown} value
 * @param {number} max
 */
export const label = (value, max) => truncate(oneLine(String(value ?? '')), max);

/**
 * 單一 session 檔讀取失敗時改回傳 fallback，避免一個壞檔拖垮整個列表或搜尋
 * @template {unknown[]} A, R
 * @param {(...args: A) => Promise<R>} fn
 * @param {R} fallback
 */
export const orElse = (fn, fallback) => async (...args) => {
  try {
    return await fn(...args);
  } catch (error) {
    logError(error);
    return fallback;
  }
};

/** @param {unknown} error */
export const logError = (error) => {
  process.stderr.write(`[session-bridge] ${error instanceof Error ? error.message : String(error)}\n`);
};

/** @param {string} dir */
const normalizeDir = (dir) => dir.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

/**
 * @param {string} child
 * @param {string} parent
 */
export const isWithin = (child, parent) => {
  if (!child || !parent) return false;
  const [c, p] = [normalizeDir(child), normalizeDir(parent)];
  return c === p || c.startsWith(`${p}/`);
};

/** 原子寫入 JSON 檔案，避免讀取端看到寫到一半的內容 */
export const atomicJson = async (file, value) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, file);
};

/** 讀取 JSON 檔案，不存在時回傳 fallback */
export const readJsonOr = async (file, fallback = null) => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};

const pathExists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** 在 PATH 的絕對目錄中尋找第一個存在的可執行檔（相容 WindowsApps App Execution Alias） */
export const findOnPath = (names, env = process.env, platform = process.platform) => {
  const dirs = (env.Path ?? env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const candidates = Array.isArray(names) ? names : [names];
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const name of candidates) {
      const hasExt = path.extname(name) !== '';
      const suffixList = hasExt ? [''] : exts;
      for (const ext of suffixList) {
        const full = path.join(dir, `${name}${ext}`);
        if (pathExists(full)) return full;
      }
    }
  }
  return null;
};
