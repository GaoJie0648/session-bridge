import { listClaudeSessions, readClaudeEntries } from './claude.js';
import { listCodexSessions, readCodexEntries } from './codex.js';
import { createMessaging } from './messaging.js';
import { SESSION_ID, isWithin, oneLine, orElse, truncate } from './util.js';

const DETAIL_MAX = 20000;
const SNIPPET_RADIUS = 60;
const HITS_PER_SESSION = 3;

const localTime = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('sv-SE').slice(0, 16);
};

const sessionLabel = (session) => `${session.source} ${session.id}「${session.title}」`;

const renderSession = (session) =>
  `${session.source} ${session.id}  ${localTime(session.updatedAt)}  ${session.cwd}\n  ${session.title}`;

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
 *   codexRoot: string,
 *   claudeRoot: string,
 *   defaultCwd: string,
 *   mailbox?: ReturnType<typeof import('./mailbox.js').createMailbox>,
 *   deliverToCodex?: (threadId: string, text: string) => Promise<void>,
 * }} config mailbox 與 deliverToCodex 只有訊息工具會用到
 */
export const createTools = ({ codexRoot, claudeRoot, defaultCwd, mailbox, deliverToCodex }) => {
  const sources = {
    codex: { list: () => listCodexSessions(codexRoot), read: readCodexEntries },
    claude: { list: () => listClaudeSessions(claudeRoot), read: readClaudeEntries },
  };

  const listInScope = async ({ source = 'all', cwd = defaultCwd, all = false }) => {
    const names = source === 'all' ? Object.keys(sources) : [source];
    const lists = await Promise.all(names.map((name) => sources[name].list()));
    return lists
      .flat()
      .filter((session) => all || isWithin(session.cwd, cwd))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const scopeHint = ({ cwd = defaultCwd, all = false }) =>
    all ? '' : `（範圍：${cwd}；傳入 all=true 可涵蓋所有專案）`;

  const findSession = async (source, id) => {
    const sessions = SESSION_ID.test(id) && sources[source] ? await sources[source].list() : [];
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

  const readSession = async ({ source, id, offset, limit = 30, maxChars = 2000 }) => {
    const session = await findSession(source, id);
    const entries = await sources[source].read(session.file);
    if (entries.length === 0) return `${sessionLabel(session)}\n這個 session 沒有對話內容。`;
    const start = offset ?? Math.max(0, entries.length - limit);
    if (start >= entries.length) throw new Error(`offset ${start} 超出範圍，可用範圍為 0–${entries.length - 1}`);
    const page = entries.slice(start, start + limit);
    const earlier = start > 0 ? `；較早的內容請用 offset=${Math.max(0, start - limit)}` : '';
    const later = start + limit < entries.length ? `；較新的內容請用 offset=${start + limit}` : '';
    const header = `${sessionLabel(session)} cwd=${session.cwd}\n共 ${entries.length} 則，顯示 [${start}]–[${page.at(-1).index}]${earlier}${later}`;
    return `${header}\n\n${page.map((entry) => renderEntry(entry, maxChars)).join('\n\n')}`;
  };

  const getEntry = async ({ source, id, index }) => {
    const session = await findSession(source, id);
    const entries = await sources[source].read(session.file, { detailIndex: index });
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
      const entries = await orElse(sources[session.source].read, [])(session.file);
      hits = [...hits, ...findHits(session, entries, needle)];
    }
    if (hits.length === 0) return `沒有符合「${query}」的內容 ${scopeHint(scope)}`;
    return hits.slice(0, limit).join('\n');
  };

  const messaging = createMessaging({ mailbox, deliverToCodex, findSession });

  const sendMessage = ({ from_source, from_id, to_source, to_id, text }) =>
    messaging.send({ from: { source: from_source, id: from_id }, to: { source: to_source, id: to_id }, text });

  const checkInbox = async ({ id }) => {
    const session = await findSession('claude', id);
    const messages = await messaging.takeNew({ source: 'claude', id: session.id });
    return messages.length > 0 ? messages.join('\n\n---\n\n') : '沒有新訊息。';
  };

  return { listSessions, readSession, getEntry, searchSessions, sendMessage, checkInbox };
};
