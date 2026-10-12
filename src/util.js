import fs from 'node:fs';
import readline from 'node:readline';

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
    process.stderr.write(`[session-bridge] ${error instanceof Error ? error.message : String(error)}\n`);
    return fallback;
  }
};

/** @param {string} dir */
const normalizeDir = (dir) => dir.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

/**
 * @param {string} child
 * @param {string} parent
 */
export const isWithin = (child, parent) => {
  const [c, p] = [normalizeDir(child), normalizeDir(parent)];
  return c === p || c.startsWith(`${p}/`);
};
