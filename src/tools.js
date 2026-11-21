import { createMessaging } from './messaging.js';
import { createDefaultRegistry } from './providers/registry.js';
import { isWithin, oneLine, orElse, truncate } from './util.js';

const DETAIL_MAX = 20000;
const SNIPPET_RADIUS = 60;
const HITS_PER_SESSION = 3;
const MESSAGE_STATES = {
  new: '已送達信箱，對方尚未讀取。',
  active: '對方已讀取，處理中；回合結束（或背景工作全部完成）時，最後回覆會自動轉寄給你。',
  done: '已結案：對方已回覆，或這是不需回覆的通知。',
};

const localTime = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('sv-SE').slice(0, 16);
};

const sessionLabel = (session) => `${session.source} ${session.id}「${session.title}」`;

const renderSession = (session) =>
  `${session.source} ${session.id}  ${localTime(session.updatedAt)}  ${session.cwd || '(未知 cwd)'}\n  ${session.title}`;

const renderEntry = (entry, maxChars) =>
  `[${entry.index}] ${localTime(entry.timestamp)} ${entry.role}\n${truncate(entry.text, maxChars)}`;

const snippet = (text, position, length) => {
  const start = Math.max(0, position - SNIPPET_RADIUS);
  const end = Math.min(text.length, position + length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${oneLine(text.slice(start, end))}${end < text.length ? '…' : ''}`;
};

const findHits = (session, entries, needle) =>
  entries
    .filter((entry) => entry.role !== 'tool')
    .map((entry) => ({ entry, position: entry.text.toLowerCase().indexOf(needle) }))
    .filter(({ position }) => position >= 0)
    .slice(0, HITS_PER_SESSION)
    .map(({ entry, position }) =>
      `${session.source} ${session.id} [${entry.index}] ${entry.role}「${session.title}」\n  ${snippet(entry.text, position, needle.length)}`);

/**
 * @param {{
 *   registry?: ReturnType<typeof createDefaultRegistry>,
 *   codexRoot?: string,
 *   claudeRoot?: string,
 *   agyRoot?: string,
 *   defaultCwd: string,
 *   mailbox?: ReturnType<typeof import('./mailbox.js').createMailbox>,
 *   deliverToCodex?: (threadId: string, text: string) => Promise<void>,
 * }} config
 */
export const createTools = ({
  registry,
  codexRoot,
  claudeRoot,
  agyRoot,
  defaultCwd,
  mailbox,
  deliverToCodex,
}) => {
  const providers = registry ?? createDefaultRegistry({
    codexRoot,
    claudeRoot,
    agyRoot,
    home: mailbox?.root,
    deliverToCodex,
  });

  const listInScope = async ({ source = 'all', cwd = defaultCwd, all = false }) => {
    const targets = source === 'all' ? providers.all() : [providers.get(source)];
    const lists = await Promise.all(targets.map((provider) => orElse(provider.listSessions, [])()));
    return lists
      .flat()
      .filter((session) => all || isWithin(session.cwd, cwd))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const scopeHint = ({ cwd = defaultCwd, all = false }) =>
    all ? '' : `（範圍：${cwd}；傳入 all=true 可涵蓋所有專案）`;

  const findSession = async (source, id) => {
    if (!providers.isValidSessionId(source, id)) {
      throw new Error(`找不到 ${source} session：${id}（請先用 list_sessions 取得 id）`);
    }
    const sessions = await providers.get(source).listSessions();
    const session = sessions.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
    if (!session) throw new Error(`找不到 ${source} session：${id}（請先用 list_sessions 取得 id）`);
    return session;
  };

  const listSessions = async ({ limit = 20, ...scope }) => {
    const sessions = await listInScope(scope);
    if (sessions.length === 0) return `找不到 session ${scopeHint(scope)}`;
    const shown = sessions.slice(0, limit);
    const footer = sessions.length > shown.length ? `\n\n共 ${sessions.length} 個，僅顯示最新 ${shown.length} 個。` : '';
    return `${shown.map(renderSession).join('\n')}${footer}`;
  };

  const readSession = async ({ source, id, offset, limit = 30, maxChars = 2000, roles }) => {
    const session = await findSession(source, id);
    const recorded = await providers.get(source).readEntries(session.file);
    if (recorded.length === 0) return `${sessionLabel(session)}\n這個 session 沒有對話內容。`;
    const entries = roles ? recorded.filter((entry) => roles.includes(entry.role)) : recorded;
    const wanted = roles?.join('、');
    if (entries.length === 0) return `${sessionLabel(session)}\n共 ${recorded.length} 則，沒有 ${wanted} 的紀錄。`;
    const picked = roles ? `，其中 ${wanted} 有 ${entries.length} 則` : '';
    const start = offset ?? Math.max(0, entries.length - limit);
    if (start >= entries.length) throw new Error(`offset ${start} 超出範圍，可用範圍為 0–${entries.length - 1}`);
    const page = entries.slice(start, start + limit);
    const earlier = start > 0 ? `；較早的內容請用 offset=${Math.max(0, start - limit)}` : '';
    const later = start + limit < entries.length ? `；較新的內容請用 offset=${start + limit}` : '';
    const header = `${sessionLabel(session)} cwd=${session.cwd || '(未知)'}\n共 ${recorded.length} 則${picked}，顯示 [${start}]–[${page.at(-1).index}]${earlier}${later}`;
    return `${header}\n\n${page.map((entry) => renderEntry(entry, maxChars)).join('\n\n')}`;
  };

  const getEntry = async ({ source, id, index }) => {
    const session = await findSession(source, id);
    const entries = await providers.get(source).readEntries(session.file, { detailIndex: index });
    if (entries.length === 0) throw new Error('這個 session 沒有對話內容。');
    const entry = entries[index];
    if (!entry) throw new Error(`index ${index} 超出範圍，可用範圍為 0–${entries.length - 1}`);
    const header = `${sessionLabel(session)} [${entry.index}] ${localTime(entry.timestamp)} ${entry.role}`;
    return `${header}\n${truncate(entry.detail ?? entry.text, DETAIL_MAX)}`;
  };

  const searchSessions = async ({ query, limit = 20, ...scope }) => {
    const needle = query.toLowerCase();
    const sessions = await listInScope(scope);
    let hits = [];
    for (const session of sessions) {
      if (hits.length >= limit) break;
      const entries = await orElse(providers.get(session.source).readEntries, [])(session.file);
      hits = [...hits, ...findHits(session, entries, needle)];
    }
    if (hits.length === 0) return `沒有符合「${query}」的內容 ${scopeHint(scope)}`;
    return hits.slice(0, limit).join('\n');
  };

  const messaging = createMessaging({ mailbox, registry: providers, findSession });

  const sendMessage = ({ from_source, from_id, to_source, to_id, text, expects_reply }) =>
    messaging.send({
      from: { source: from_source, id: from_id },
      to: { source: to_source, id: to_id },
      text,
      expectsReply: expects_reply,
    });

  const checkInbox = async ({ source = 'claude', id }) => {
    const session = await findSession(source, id);
    const messages = await messaging.takeNew({ source, id: session.id });
    return messages.length > 0 ? messages.join('\n\n---\n\n') : '沒有新訊息。';
  };

  const messageStatus = async ({ to_source, to_id, message_id }) => {
    const session = await findSession(to_source, to_id);
    const found = await mailbox.find({ source: to_source, id: session.id }, message_id);
    if (!found) throw new Error(`找不到訊息 ${message_id}（可能寄錯收件 session，或已結案超過保留期限而被清除）`);
    const meaning = MESSAGE_STATES[found.state];
    return `訊息 ${message_id}（寄出於 ${localTime(found.message.sentAt)}）：${meaning}`;
  };

  return { listSessions, readSession, getEntry, searchSessions, sendMessage, checkInbox, messageStatus };
};
