import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { defaultHome } from './config.js';
import { prepareAttachments, readAttachment, saveAttachment } from './room-attachments.js';
import { logError, SAFE_SESSION_ID, UUID_PATTERN } from './util.js';

const require = createRequire(import.meta.url);
const ALIAS = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const DISPATCH_TIMEOUT = 2 * 60 * 1000;
const MAX_PAGE = 100;
const MAX_WAKE_TARGETS = 32;
const MAX_MEMBERS = 32;

const schema = `
  CREATE TABLE room (
    title TEXT NOT NULL, workspace TEXT NOT NULL, updated_at INTEGER NOT NULL,
    max_depth INTEGER NOT NULL, max_wakes INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    expired INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
    session_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, UNIQUE (source, session_id)
  );
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, alias TEXT NOT NULL,
    text TEXT NOT NULL, at INTEGER NOT NULL, reply_to_seq INTEGER REFERENCES messages,
    root_seq INTEGER REFERENCES messages, depth INTEGER NOT NULL, member_id TEXT REFERENCES members,
    client_message_id TEXT, UNIQUE (member_id, client_message_id)
  );
  CREATE UNIQUE INDEX messages_human_retry ON messages (client_message_id) WHERE actor = 'human';
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL REFERENCES messages, data TEXT NOT NULL
  );
  CREATE INDEX attachments_seq ON attachments (seq);
  CREATE TABLE outbox (
    seq INTEGER NOT NULL REFERENCES messages, target TEXT NOT NULL COLLATE NOCASE, alias TEXT NOT NULL,
    recipient_id TEXT REFERENCES members, root_seq INTEGER NOT NULL REFERENCES messages,
    status TEXT NOT NULL, reason TEXT, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (seq, target)
  );
  CREATE UNIQUE INDEX outbox_root_recipient ON outbox (root_seq, recipient_id) WHERE status <> 'skipped';
  CREATE INDEX outbox_pending ON outbox (recipient_id, status, seq);
  CREATE INDEX outbox_revision ON outbox (revision);
`;

const hash = (token) => createHash('sha256').update(token).digest('hex');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validAlias = (alias) => ALIAS.test(alias) && !['all', 'human'].includes(alias);
const wakeMentions = (text) => [...text.matchAll(/(?<![\p{L}\p{N}_@-])@([a-z0-9][a-z0-9_-]{0,31})(?![\p{L}\p{N}_-])/giu)]
  .map((match) => match[1].toLowerCase());

const dbOpen = (file) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('群組房間需要可載入 node:sqlite 的 Node.js（Node 22.13+ 或較新的 LTS）');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return db;
};

const transaction = (db, action) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

const folder = (directory) => {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('房間目錄無效');
  return directory;
};

const matchMember = (db, token) => {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw new Error('需要有效的房間成員權杖');
  const member = db.prepare('SELECT * FROM members WHERE token_hash = ?').get(hash(token));
  if (!member) throw new Error('需要有效的房間成員權杖');
  return member;
};

const nextRevision = (db) => db.prepare('UPDATE room SET revision = revision + 1 RETURNING revision').get().revision;
const statuses = 'seq, alias, status, reason, revision';
const members = (db) => db.prepare('SELECT alias, source, session_id FROM members ORDER BY alias').all();
const deliveryStatus = (db, seq) => db.prepare(`SELECT ${statuses} FROM outbox WHERE seq = ? ORDER BY revision`).all(seq);

const hydrate = (db, message) => ({
  ...message,
  attachments: db.prepare('SELECT id, data FROM attachments WHERE seq = ? ORDER BY rowid').all(message.seq)
    .map(({ id, data }) => ({ id, ...JSON.parse(data) })),
  delivery: deliveryStatus(db, message.seq),
});

const messageQuery = 'SELECT seq, actor, alias, text, at, reply_to_seq, root_seq, depth FROM messages';
const metadata = (db) => db.prepare('SELECT * FROM room').get();
const live = (db) => {
  const room = metadata(db);
  if (!room || room.expired) throw new Error('房間已過期');
  return room;
};

const recordWakes = (db, { seq, root, depth, requests, room, sender, canRelay, now }) => {
  const byAlias = new Map(db.prepare('SELECT id, alias FROM members ORDER BY alias').all().map((m) => [m.alias, m]));
  const targets = new Set(requests);
  if (targets.delete('all')) byAlias.forEach((member) => targets.add(member.alias));
  let used = db.prepare("SELECT count(*) AS total FROM outbox WHERE root_seq = ? AND status <> 'skipped'").get(root).total;
  const already = db.prepare("SELECT 1 FROM outbox WHERE root_seq = ? AND recipient_id = ? AND status <> 'skipped'");
  const insert = db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const alias of targets) {
    const recipient = byAlias.get(alias);
    let reason = null;
    if (!recipient) reason = '找不到房間成員';
    else if (recipient.id === sender?.id) reason = '自己已在此回合';
    else if (!canRelay) reason = '接力點名須回覆一則點名給你的訊息';
    else if (depth > room.max_depth) reason = '達到接力深度上限';
    else if (already.get(root, recipient.id)) reason = '本次討論已點名此成員';
    else if (used >= room.max_wakes) reason = '達到本次討論的喚醒總額';
    else used += 1;
    insert.run(seq, alias, alias, recipient?.id ?? null, root, reason ? 'skipped' : 'pending', reason, nextRevision(db), now);
  }
};

const notice = ({ roomId, seq, alias }) =>
  `[session-bridge 房間 ${roomId} #${seq}] @${alias}，你收到房間點名。請用 room_read(room_id="${roomId}", since_seq=${seq - 1}) 和你的成員權杖取得貼文，再以 room_post 的 reply_to_seq=${seq} 明確貼回房間。`;

const roomMarker = /^\[session-bridge 房間 ([a-f0-9-]{36}) #(\d+)\]/i;

export const createRooms = ({ home = defaultHome(), registry, clock = Date.now } = {}) => {
  const root = path.resolve(home, 'rooms');
  const roomDir = (id) => {
    if (!UUID_PATTERN.test(String(id ?? ''))) throw new Error('無效的 room id');
    return path.join(root, id.toLowerCase());
  };

  const withRoom = (id, action) => {
    const dir = roomDir(id);
    const file = path.join(dir, 'room.sqlite');
    if (!fs.existsSync(file)) throw new Error(`找不到房間：${id}`);
    folder(root);
    folder(dir);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('房間資料庫無效');
    const db = dbOpen(file);
    try {
      return action(db, dir);
    } finally {
      db.close();
    }
  };

  const ids = () => {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(folder(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && UUID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  };

  const create = ({ title, cwd = process.cwd(), maxDepth = 2, maxWakes = 8 }) => {
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('房間名稱需為 1–120 字');
    if (!integer(maxDepth, 0, 10) || !integer(maxWakes, 1, 64)) throw new Error('喚醒上限無效');
    const workspace = fs.realpathSync(cwd);
    if (!fs.statSync(workspace).isDirectory()) throw new Error('工作目錄須為目錄');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    folder(root);
    const id = randomUUID();
    const dir = roomDir(id);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'artifacts'), { mode: 0o700 });
    const db = dbOpen(path.join(dir, 'room.sqlite'));
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      transaction(db, () => {
        db.exec(schema);
        db.prepare('INSERT INTO room (title, workspace, updated_at, max_depth, max_wakes) VALUES (?, ?, ?, ?, ?)')
          .run(title.trim(), workspace, clock(), maxDepth, maxWakes);
      });
    } finally {
      db.close();
    }
    return { id, title: title.trim(), workspace };
  };

  const info = (id) => withRoom(id, (db) => {
    const { title, workspace, updated_at, revision } = live(db);
    return { id: id.toLowerCase(), title, workspace, updated_at, revision, members: members(db) };
  });

  const list = () => ids().flatMap((id) => {
    try { return [info(id)]; } catch { return []; }
  });

  const add = (id, { alias, source, sessionId }) => {
    const name = String(alias ?? '').toLowerCase();
    if (!validAlias(name)) throw new Error('無效或保留的成員別名');
    if (typeof source !== 'string' || typeof sessionId !== 'string' || !PROVIDER.test(source) || !SAFE_SESSION_ID.test(sessionId)
      || (registry && !registry.isValidSessionId(source, sessionId))) throw new Error('無效的 session 位址');
    return withRoom(id, (db) => transaction(db, () => {
      live(db);
      const address = sessionId.toLowerCase();
      const collision = db.prepare('SELECT * FROM members WHERE alias = ?').get(name);
      if (collision && (collision.source !== source || collision.session_id !== address)) {
        throw new Error(`別名 @${name} 已使用`);
      }
      const previous = db.prepare('SELECT id FROM members WHERE source = ? AND session_id = ?').get(source, address);
      if (!previous && db.prepare('SELECT count(*) AS total FROM members').get().total >= MAX_MEMBERS) {
        throw new Error('房間成員已達上限');
      }
      const token = randomBytes(24).toString('hex');
      if (previous) db.prepare('UPDATE members SET alias = ?, token_hash = ? WHERE id = ?').run(name, hash(token), previous.id);
      else db.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?)').run(randomUUID(), name, source, address, hash(token));
      db.prepare('UPDATE room SET updated_at = ?').run(clock());
      return { alias: name, source, session_id: address, room_token: token };
    }));
  };

  const read = (id, { since_seq, limit = 40, token, agent = false } = {}) => withRoom(id, (db) => {
    const room = live(db);
    if (agent) matchMember(db, token);
    if (!integer(limit, 1, MAX_PAGE) || (since_seq !== undefined && !integer(since_seq, 0, Number.MAX_SAFE_INTEGER))) {
      throw new Error('讀取游標或數量無效');
    }
    const page = since_seq === undefined
      ? db.prepare(`${messageQuery} ORDER BY seq DESC LIMIT ?`).all(limit).reverse()
      : db.prepare(`${messageQuery} WHERE seq > ? ORDER BY seq LIMIT ?`).all(since_seq, limit);
    return {
      room_id: id.toLowerCase(), title: room.title, members: members(db), revision: room.revision,
      next_seq: page.at(-1)?.seq ?? since_seq ?? 0, messages: page.map((message) => hydrate(db, message)),
    };
  });

  const updateDelivery = (db, seq, alias, status, reason = null) =>
    db.prepare('UPDATE outbox SET status = ?, reason = ?, revision = ?, updated_at = ? WHERE seq = ? AND target = ?')
      .run(status, reason, nextRevision(db), clock(), seq, alias);

  const staleDispatches = (db) => db.prepare(
    "SELECT seq, alias FROM outbox WHERE status = 'dispatching' AND updated_at < ?",
  ).all(clock() - DISPATCH_TIMEOUT);
  const expireDispatches = (db) => {
    for (const job of staleDispatches(db)) updateDelivery(db, job.seq, job.alias, 'uncertain', '未收到排隊回執');
  };

  const dispatch = async (id) => {
    const deliver = registry?.has('codex') && registry.get('codex').deliverMessage;
    if (!deliver) return;
    const jobs = withRoom(id, (db) => transaction(db, () => {
      live(db);
      expireDispatches(db);
      const pending = db.prepare(`
        SELECT o.seq, o.alias, m.session_id FROM outbox o JOIN members m ON m.id = o.recipient_id
        WHERE m.source = 'codex' AND o.status = 'pending' ORDER BY o.seq LIMIT 32
      `).all();
      for (const job of pending) updateDelivery(db, job.seq, job.alias, 'dispatching');
      return pending;
    }));
    await Promise.all(jobs.map(async ({ seq, alias, session_id }) => {
      let status = 'queued';
      let reason = null;
      try {
        await deliver(session_id, notice({ roomId: id, seq, alias }));
      } catch {
        status = 'uncertain';
        reason = '未收到排隊回執，請由房間讀取';
      }
      withRoom(id, (db) => transaction(db, () => {
        const job = db.prepare('SELECT status FROM outbox WHERE seq = ? AND target = ?').get(seq, alias);
        if (job?.status === 'dispatching') updateDelivery(db, seq, alias, status, reason);
      }));
    }));
  };

  const post = async (id, draft, { agent = false, token } = {}) => {
    const { text = '', attachments = [], reply_to_seq, client_message_id } = draft;
    if (!Array.isArray(attachments) || typeof text !== 'string' || text.length > 8000 || (!text.trim() && !attachments.length)) {
      throw new Error('貼文須含文字或附件，文字最多 8000 字');
    }
    const requests = agent ? (draft.wake ?? []) : [...new Set(wakeMentions(text))];
    if (!Array.isArray(requests) || requests.length > MAX_WAKE_TARGETS
      || requests.some((alias) => typeof alias !== 'string' || !ALIAS.test(alias.replace(/^@/, '').toLowerCase()))) {
      throw new Error('點名清單無效');
    }
    const aliases = [...new Set(requests.map((alias) => alias.replace(/^@/, '').toLowerCase()))];
    if (agent && aliases.includes('all')) throw new Error('@all 僅可由人類點名');
    if (reply_to_seq !== undefined && !integer(reply_to_seq, 1, Number.MAX_SAFE_INTEGER)) throw new Error('回覆序號無效');
    if (client_message_id !== undefined && (typeof client_message_id !== 'string'
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(client_message_id))) throw new Error('貼文重試識別碼無效');
    const seq = withRoom(id, (db, dir) => {
      const room = live(db);
      let sender = agent ? matchMember(db, token) : null;
      const existing = () => client_message_id && (sender
        ? db.prepare('SELECT seq FROM messages WHERE member_id = ? AND client_message_id = ?').get(sender.id, client_message_id)
        : db.prepare("SELECT seq FROM messages WHERE actor = 'human' AND client_message_id = ?").get(client_message_id));
      const prior = existing();
      if (prior) return prior.seq;
      const prepared = prepareAttachments(attachments, room.workspace, { agent });
      const created = [];
      try {
        return transaction(db, () => {
          live(db);
          if (sender) sender = matchMember(db, token);
          const duplicate = existing();
          if (duplicate) return duplicate.seq;
          const parent = reply_to_seq === undefined ? null : db.prepare('SELECT * FROM messages WHERE seq = ?').get(reply_to_seq);
          if (reply_to_seq !== undefined && !parent) throw new Error('找不到要回覆的貼文');
          const depth = agent && parent ? parent.depth + 1 : 0;
          const canRelay = !agent || (parent && db.prepare(
            "SELECT 1 FROM outbox WHERE seq = ? AND recipient_id = ? AND status <> 'skipped'",
          ).get(parent.seq, sender.id));
          const now = clock();
          const { lastInsertRowid: seq } = db.prepare(`
            INSERT INTO messages (actor, alias, text, at, reply_to_seq, depth, member_id, client_message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(agent ? 'agent' : 'human', sender?.alias ?? 'human', text, now, reply_to_seq ?? null,
            depth, sender?.id ?? null, client_message_id ?? null);
          const root = (agent && parent?.root_seq) || seq;
          db.prepare('UPDATE messages SET root_seq = ? WHERE seq = ?').run(root, seq);
          if (prepared.length) {
            const directory = folder(path.join(dir, 'artifacts'));
            for (const attachment of prepared) saveAttachment(db, directory, seq, attachment, created);
          }
          recordWakes(db, { seq, root, depth, requests: aliases, room, sender, canRelay, now });
          db.prepare('UPDATE room SET updated_at = ?').run(now);
          return seq;
        });
      } catch (error) {
        for (const file of created) {
          try { fs.rmSync(file, { force: true }); } catch (cleanupError) { logError(cleanupError); }
        }
        throw error;
      }
    });
    try { await dispatch(id); } catch (error) { logError(error); }
    return withRoom(id, (db) => hydrate(db, db.prepare(`${messageQuery} WHERE seq = ?`).get(seq)));
  };

  const changes = (id, revision = 0) => withRoom(id, (db) => {
    live(db);
    if (staleDispatches(db).length) transaction(db, () => expireDispatches(db));
    return db.prepare(`SELECT ${statuses} FROM outbox WHERE revision > ? ORDER BY revision LIMIT 100`).all(revision);
  });

  const acknowledge = ({ source, id, prompt }) => {
    const match = String(prompt ?? '').match(roomMarker);
    if (source !== 'codex' || !match || !integer(Number(match[2]), 1, Number.MAX_SAFE_INTEGER)) return;
    withRoom(match[1], (db) => transaction(db, () => {
      live(db);
      const job = db.prepare(`
        SELECT o.seq, o.alias FROM outbox o JOIN members m ON m.id = o.recipient_id
        WHERE m.source = ? AND m.session_id = ? AND o.seq = ?
          AND o.status IN ('queued', 'dispatching', 'uncertain')
      `).get(source, id.toLowerCase(), Number(match[2]));
      if (job) updateDelivery(db, job.seq, job.alias, 'handed_off');
    }));
  };

  const take = ({ source, id }) => ids().flatMap((roomId) => {
    try {
      return withRoom(roomId, (db) => {
        live(db);
        const member = db.prepare('SELECT id FROM members WHERE source = ? AND session_id = ?').get(source, id.toLowerCase());
        if (!member) return [];
        const select = db.prepare(`
          SELECT seq, alias FROM outbox WHERE recipient_id = ? AND status = 'pending' ORDER BY seq LIMIT 8
        `);
        if (!select.get(member.id)) return [];
        return transaction(db, () => {
          live(db);
          return select.all(member.id).map(({ seq, alias }) => {
            updateDelivery(db, seq, alias, 'handed_off');
            return notice({ roomId, seq, alias });
          });
        });
      });
    } catch {
      return [];
    }
  });

  const attachment = (id, attachmentId, { agent = false, token, includeBytes = true } = {}) =>
    withRoom(id, (db, dir) => {
      const room = live(db);
      if (agent) matchMember(db, token);
      const item = db.prepare('SELECT data FROM attachments WHERE id = ?').get(attachmentId);
      if (!item) throw new Error('找不到附件');
      const record = { id: attachmentId, ...JSON.parse(item.data) };
      return readAttachment(record, folder(path.join(dir, 'artifacts')), room.workspace, { includeBytes });
    });

  const prune = (before) => ids().filter((id) => {
    try {
      const expired = withRoom(id, (db) => transaction(db, () => {
        const room = metadata(db);
        if (room.expired) return true;
        if (room.updated_at >= before || db.prepare("SELECT 1 FROM outbox WHERE status = 'dispatching' AND updated_at >= ?")
          .get(clock() - DISPATCH_TIMEOUT)) return false;
        db.exec('UPDATE room SET expired = 1');
        return true;
      }));
      if (!expired) return false;
      const dir = folder(roomDir(id));
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }).length;

  return { create, info, list, add, read, post, dispatch, acknowledge, changes, take, attachment, prune };
};
