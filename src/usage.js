import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseJson } from './util.js';

export const WARN_PERCENT = 80;
export const URGENT_PERCENT = 90;
// Codex 每回合都會在 rollout 檔尾寫入 rate_limits，只讀檔尾，避免每次工具呼叫都掃完整個檔案
const TAIL_BYTES = 256 * 1024;
// statusline 只在畫面更新時寫入快照，太舊的快照不能代表目前用量
const STALE_MS = 10 * 60 * 1000;
const WINDOW_NAMES = { 300: '5h', 10080: '7d' };
const LEVELS = ['warn', 'urgent'];

const ifMissing = (fallback) => (error) => {
  if (error.code === 'ENOENT') return fallback;
  throw error;
};

const windowName = (minutes) => WINDOW_NAMES[minutes] ?? `${minutes}m`;

const toWindow = (name, usedPercent, resetsAt) =>
  typeof usedPercent === 'number' ? { name, usedPercent, resetsAt: typeof resetsAt === 'number' ? resetsAt : null } : null;

/** @param {any} rateLimits Codex rollout 中 token_count 事件的 rate_limits */
export const fromCodexRateLimits = (rateLimits) =>
  [rateLimits?.primary, rateLimits?.secondary]
    .filter(Boolean)
    .map((window) => toWindow(windowName(window.window_minutes), window.used_percent, window.resets_at))
    .filter(Boolean);

/** @param {any} input Claude Code statusline 的 stdin JSON */
export const fromClaudeStatus = (input) =>
  [
    toWindow('5h', input?.rate_limits?.five_hour?.used_percentage, input?.rate_limits?.five_hour?.resets_at),
    toWindow('7d', input?.rate_limits?.seven_day?.used_percentage, input?.rate_limits?.seven_day?.resets_at),
  ].filter(Boolean);

/** @param {string} file Codex rollout 檔 */
export const readCodexUsage = async (file) => {
  const handle = await fs.open(file);
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    const record = buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line.includes('"rate_limits"'))
      .map(parseJson)
      .findLast((candidate) => candidate?.payload?.rate_limits);
    return record ? fromCodexRateLimits(record.payload.rate_limits) : [];
  } finally {
    await handle.close();
  }
};

/** @param {{ name: string, usedPercent: number }[]} windows */
export const formatUsage = (windows) => windows.map((window) => `${window.name} ${Math.round(window.usedPercent)}%`).join(' · ');

export const levelOf = ({ usedPercent }) =>
  usedPercent >= URGENT_PERCENT ? 'urgent' : usedPercent >= WARN_PERCENT ? 'warn' : null;

const formatReset = (resetsAt) =>
  resetsAt ? new Date(resetsAt * 1000).toLocaleString('zh-TW', { hour12: false }) : '時間未知';

const describe = (windows) =>
  windows.map((window) => `${window.name} 用量已達 ${Math.round(window.usedPercent)}%（${formatReset(window.resetsAt)} 重置）`).join('；');

const PEER_NAMES = { codex: 'Codex CLI', claude: 'Claude Code' };

/**
 * @param {{ self: { source: string, id: string }, level: string, windows: any[], peer?: { source: string, id: string } | null, peerLimited?: boolean }} alert
 */
export const renderAlert = ({ self, level, windows, peer, peerLimited }) => {
  const head = `[session-bridge 用量提醒] ${describe(windows)}。`;
  if (level === 'warn') {
    return `${head}請規劃在合適的段落收尾：先完成手上的步驟，不要開始大型的新步驟，並讓目前進度保持可交接的狀態。`;
  }
  const stop = `${head}額度即將用完，請立刻停在安全點：完成或還原正在進行的修改，不要留下改到一半的檔案，也不要再開始新的步驟。`;
  const summary = '目標、已完成、未完成、下一步、相關檔案與尚未驗證的地方';
  if (!peer || peerLimited) {
    const reason = peer ? `另一邊（${PEER_NAMES[peer.source]}）的用量也已達 ${URGENT_PERCENT}%` : `這個專案找不到另一邊（${PEER_NAMES[self.source === 'codex' ? 'claude' : 'codex']}）的 session`;
    return `${stop}${reason}，不要交接；把${summary}寫在回覆裡，然後停止並請使用者決定後續。`;
  }
  const params = `from_source=${self.source}、from_id=${self.id}、to_source=${peer.source}、to_id=${peer.id}、expects_reply=true`;
  return `${stop}接著用 session-bridge 的 send_message 把工作交接給同專案最近的 ${PEER_NAMES[peer.source]} session（${params}），內容寫清楚${summary}。送出後停止，並告訴使用者已交接。`;
};

/** @param {string} root session-bridge 的家目錄 */
export const createUsageStore = (root, now = Date.now) => {
  const dir = path.join(root, 'usage');

  const writeJson = async (file, value) => {
    await fs.mkdir(dir, { recursive: true });
    // 先寫暫存檔再改名，讀取端不會看到寫到一半的內容
    await fs.writeFile(`${file}.tmp`, JSON.stringify(value));
    await fs.rename(`${file}.tmp`, file);
  };
  const readJson = async (file) => parseJson(await fs.readFile(file, 'utf8').catch(ifMissing(''))) ?? null;

  const snapshotFile = (source) => path.join(dir, `${source}.json`);

  const saveSnapshot = (source, windows) => writeJson(snapshotFile(source), { source, updatedAt: now(), windows });

  /** 過期快照與已重置的時窗不採用 */
  const loadSnapshot = async (source) => {
    const snapshot = await readJson(snapshotFile(source));
    if (!snapshot || now() - snapshot.updatedAt > STALE_MS) return [];
    return snapshot.windows.filter((window) => !window.resetsAt || window.resetsAt * 1000 > now());
  };

  /**
   * 回傳尚未提醒過的時窗，並記錄為已提醒；同一時窗、同一重置時間、同一級別只提醒一次
   * @param {string} name 去重範圍，例如 session 位址或帳號
   */
  const takeUnalerted = async (name, windows) => {
    const file = path.join(dir, `alerted-${name}.json`);
    const alerted = new Set((await readJson(file)) ?? []);
    const fresh = windows.filter((window) => !alerted.has(`${window.name}:${window.resetsAt}:${levelOf(window)}`));
    if (fresh.length === 0) return [];
    // 直接到達 urgent 時連同 warn 一起記錄，之後不會再補發較低的級別
    const keys = fresh.flatMap((window) =>
      LEVELS.slice(0, LEVELS.indexOf(levelOf(window)) + 1).map((level) => `${window.name}:${window.resetsAt}:${level}`),
    );
    // 已重置時窗的紀錄不再需要，順便清掉
    const live = [...alerted, ...keys].filter((key) => {
      const resetsAt = key.split(':')[1];
      return resetsAt === 'null' || Number(resetsAt) * 1000 > now();
    });
    await writeJson(file, [...new Set(live)]);
    return fresh;
  };

  return { saveSnapshot, loadSnapshot, takeUnalerted };
};

/**
 * @param {{
 *   store: ReturnType<typeof createUsageStore>,
 *   findPeer: (self: { source: string, id: string }) => Promise<{ source: string, id: string } | null>,
 *   notify?: (title: string, text: string) => void,
 * }} config
 */
export const createUsageAlerts = ({ store, findPeer, notify = () => {} }) => {
  /**
   * @param {{ source: string, id: string }} self
   * @param {any[]} windows 目前的用量
   * @returns {Promise<string | null>} 要注入給 agent 的提醒；沒有新提醒時回傳 null
   */
  const check = async (self, windows) => {
    const limited = windows.filter(levelOf);
    const fresh = await store.takeUnalerted(`${self.source}-${self.id.toLowerCase()}`, limited);
    if (fresh.length === 0) return null;
    const level = fresh.some((window) => levelOf(window) === 'urgent') ? 'urgent' : 'warn';
    // 桌面通知以帳號為單位去重，多個 session 同時開著也只跳一次
    if ((await store.takeUnalerted(`${self.source}-account`, fresh)).length > 0) {
      notify(`${PEER_NAMES[self.source]} 用量${level === 'urgent' ? '即將用完' : '偏高'}`, describe(fresh));
    }
    if (level === 'warn') return renderAlert({ self, level, windows: fresh });
    const peer = await findPeer(self);
    const peerLimited = peer ? (await store.loadSnapshot(peer.source)).some((window) => levelOf(window) === 'urgent') : false;
    return renderAlert({ self, level, windows: fresh, peer, peerLimited });
  };

  return { check };
};

// 以環境變數傳入文字，避免內容被當成 PowerShell 語法執行
const TOAST_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  '$texts = $xml.GetElementsByTagName("text")',
  '$texts.Item(0).AppendChild($xml.CreateTextNode($env:SESSION_BRIDGE_TOAST_TITLE)) > $null',
  '$texts.Item(1).AppendChild($xml.CreateTextNode($env:SESSION_BRIDGE_TOAST_TEXT)) > $null',
  '$app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('; ');

/** Windows 桌面通知；失敗不影響 hook，其他平台或 SESSION_BRIDGE_NOTIFY=0 時略過 */
export const notifyDesktop = (title, text) => {
  if (process.platform !== 'win32' || process.env.SESSION_BRIDGE_NOTIFY === '0') return;
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, SESSION_BRIDGE_TOAST_TITLE: title, SESSION_BRIDGE_TOAST_TEXT: text },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 通知只是輔助，失敗時仍以注入給 agent 的提醒為主
  }
};
