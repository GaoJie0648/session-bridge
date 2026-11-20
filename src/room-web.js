import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

import { MAX_ATTACHMENT_BYTES, MAX_POST_ATTACHMENT_BYTES, isPreviewImage } from './room-attachments.js';
import { UUID_PATTERN } from './util.js';

const assets = {
  '/': ['room.html', 'text/html; charset=utf-8'],
  '/room.css': ['room.css', 'text/css; charset=utf-8'],
  '/room.js': ['room.js', 'text/javascript; charset=utf-8'],
};
const maxBody = Math.ceil(MAX_POST_ATTACHMENT_BYTES / 3) * 4 + 65536;

const respond = (res, status, body) => {
  if (body === undefined) { res.writeHead(status).end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
};

const readJson = async (req) => {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('需要 JSON 請求');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBody) {
      req.resume();
      throw new Error('上傳超過大小上限');
    }
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('無效的貼文資料');
  return body;
};

const webAttachment = (item) => {
  if (item?.kind !== 'artifact' || typeof item.name !== 'string' || item.name.length > 256
    || typeof item.data !== 'string' || item.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) {
    throw new Error('上傳附件格式無效或過大');
  }
  const bytes = Buffer.from(item.data, 'base64');
  if (bytes.toString('base64') !== item.data) throw new Error('上傳附件格式無效');
  return { kind: 'artifact', name: item.name, bytes };
};

const cursorOf = (raw) => {
  if (raw === null || raw === undefined) return undefined;
  const cursor = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(cursor)) throw new Error('游標無效');
  return cursor;
};

const stream = (res, rooms, roomId, start, active) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.flushHeaders();
  let seq = start;
  let revision = 0;
  let lastBeat = Date.now();
  let roster;
  const tick = () => {
    if (res.destroyed || res.writableEnded || res.writableNeedDrain) return;
    try {
      const page = rooms.read(roomId, { since_seq: seq, limit: 30 });
      const nextRoster = JSON.stringify(page.members);
      if (nextRoster !== roster) {
        roster = nextRoster;
        if (!res.write(`event: members\ndata: ${roster}\n\n`)) return;
      }
      for (const message of page.messages) {
        seq = message.seq;
        if (!res.write(`id: ${seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`)) return;
      }
      for (const change of rooms.changes(roomId, revision)) {
        revision = change.revision;
        if (!res.write(`event: delivery\ndata: ${JSON.stringify(change)}\n\n`)) return;
      }
      if (Date.now() - lastBeat > 15000) {
        res.write(': keepalive\n\n');
        lastBeat = Date.now();
      }
    } catch {
      res.write('event: unavailable\ndata: {}\n\n');
      res.end();
    }
  };
  const timer = setInterval(tick, 350);
  active.add(res);
  res.once('close', () => { clearInterval(timer); active.delete(res); });
  tick();
};

export const serveRoom = async ({ rooms, roomId, port = 0 }) => {
  rooms.info(roomId);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('通訊埠無效');
  const secret = randomBytes(32).toString('hex');
  const cookie = `bridge_${randomBytes(8).toString('hex')}`;
  const equal = (text = '') => text.length === secret.length && timingSafeEqual(Buffer.from(text, 'latin1'), Buffer.from(secret));
  const active = new Set();
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'");
    if (`http://${req.headers.host}` !== origin) { respond(res, 403, { error: '請使用本機看板網址' }); return; }
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [name, mime] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': mime }).end(readFileSync(new URL(`./web/${name}`, import.meta.url)));
        return;
      }
      if (req.method === 'POST' && req.headers.origin !== origin) { respond(res, 403, { error: '請從本機看板送出' }); return; }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        if (!equal(req.headers.authorization?.replace(/^Bearer /, ''))) {
          respond(res, 401, { error: '看板憑證無效' }); return;
        }
        res.setHeader('Set-Cookie', `${cookie}=${secret}; HttpOnly; SameSite=Strict; Path=/`);
        respond(res, 204);
        return;
      }
      const session = req.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookie}=`));
      if (!equal(session?.slice(cookie.length + 1))) { respond(res, 401, { error: '請使用 CLI 顯示的完整網址開啟看板' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        respond(res, 200, rooms.read(roomId, { since_seq: cursorOf(url.searchParams.get('since_seq')) }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const start = cursorOf(req.headers['last-event-id'] ?? url.searchParams.get('since_seq')) ?? 0;
        stream(res, rooms, roomId, start, active);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/messages') {
        const { text, attachments = [], reply_to_seq, client_message_id } = await readJson(req);
        if (!Array.isArray(attachments) || attachments.length > 4) throw new Error('每則貼文最多 4 個附件');
        respond(res, 201, await rooms.post(roomId, {
          text, reply_to_seq, client_message_id, attachments: attachments.map(webAttachment),
        }));
        return;
      }
      const prefix = '/api/attachments/';
      const id = url.pathname.slice(prefix.length);
      if (req.method === 'GET' && url.pathname.startsWith(prefix) && UUID_PATTERN.test(id)) {
        const item = rooms.attachment(roomId, id);
        const image = isPreviewImage(item.mime);
        res.writeHead(200, {
          'Content-Type': image ? item.mime : 'application/octet-stream',
          'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name.toWellFormed()).replace(/'/g, '%27')}`,
        }).end(item.bytes);
        return;
      }
      respond(res, 404, { error: '找不到看板資源' });
    } catch (error) {
      if (!res.headersSent) respond(res, 400, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve, reject) => {
    for (const response of active) response.end();
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
  return { url: `${origin}/#${secret}`, close };
};
