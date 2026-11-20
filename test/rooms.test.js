import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { pruneStorage } from '../src/cleanup.js';
import { runCli } from '../src/cli.js';
import { runHook } from '../src/hook.js';
import { createDefaultRegistry } from '../src/providers/registry.js';
import { watchRoom } from '../src/room-cli.js';
import { serveRoom } from '../src/room-web.js';
import { createRooms } from '../src/rooms.js';
import { createTaskStore } from '../src/task-store.js';
import { createTaskTools } from '../src/tasks.js';
import { AGY_ID, CLAUDE_ID, CODEX_ID } from './fixtures.js';

const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=', 'base64');
const credentials = (member) => ({ agent: true, token: member.room_token });
const setup = (t, options = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-rooms-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-room-workspace-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rooms = createRooms({ home, registry: options.registry, clock: options.clock });
  const { id } = rooms.create({ title: '協作測試', cwd, maxDepth: options.maxDepth, maxWakes: options.maxWakes });
  return { home, cwd, rooms, id };
};

const join = ({ rooms, id }, alias, source, sessionId) => rooms.add(id, { alias, source, sessionId });

test('房間交易序號、成員權杖、失敗回滾與增量讀取', async (t) => {
  const ctx = setup(t);
  const { cwd, id, rooms } = ctx;
  const codex = join(ctx, 'design', 'codex', CODEX_ID);
  assert.throws(() => join(ctx, 'Design', 'agy', AGY_ID), /別名/);
  assert.throws(() => rooms.read(id, { agent: true }), /權杖/);
  const first = await rooms.post(id, { text: '開始', actor: 'agent' });
  assert.equal(first.actor, 'human');
  assert.equal(first.seq, 1);
  await assert.rejects(rooms.post(id, { text: '失敗', reply_to_seq: 419 }), /找不到/);
  fs.writeFileSync(path.join(cwd, 'note.txt'), '資料');
  const draft = { text: '進度', actor: 'human', attachments: [{ kind: 'artifact', path: 'note.txt' }], client_message_id: 'once' };
  const second = await rooms.post(id, draft, credentials(codex));
  assert.equal(second.actor, 'agent');
  assert.equal(second.seq, 2);
  assert.equal(second.alias, 'design');
  fs.unlinkSync(path.join(cwd, 'note.txt'));
  assert.equal((await rooms.post(id, draft, credentials(codex))).seq, 2);
  assert.deepEqual(rooms.read(id, { since_seq: 1 }).messages.map(({ seq }) => seq), [2]);

  const rotated = join(ctx, 'reviewer', 'codex', CODEX_ID);
  assert.throws(() => rooms.read(id, credentials(codex)), /權杖/);
  assert.equal(rooms.read(id, credentials(rotated)).messages[1].alias, 'design');
});

test('不同執行緒寫入同一個房間時序號仍唯一且遞增', { timeout: 10000 }, async (t) => {
  const { home, id, rooms } = setup(t);
  const moduleUrl = new URL('../src/rooms.js', import.meta.url).href;
  const writer = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createRooms } = await import(workerData.moduleUrl);
      const rooms = createRooms({ home: workerData.home });
      for (let i = 0; i < 8; i++) await rooms.post(workerData.id, { text: String(i) });
      parentPort.postMessage('完成');
    })().catch((error) => { throw error; });
  `;
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(writer, { eval: true, workerData: { home, id, moduleUrl } });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`Worker exit ${code}`)); });
  })));
  assert.deepEqual(rooms.read(id).messages.map(({ seq }) => seq), Array.from({ length: 24 }, (_, n) => n + 1));
});

test('中途寫入附件失敗時回滾貼文與通知並移除已寫的快照', async (t) => {
  const ctx = setup(t);
  const { rooms, home, id } = ctx;
  join(ctx, 'agy', 'agy', AGY_ID);
  const dir = path.join(home, 'rooms', id);
  const db = new DatabaseSync(path.join(dir, 'room.sqlite'));
  try {
    db.exec(`
      CREATE TRIGGER failed_attachment BEFORE INSERT ON attachments
      WHEN json_extract(NEW.data, '$.name') = 'fail.txt'
      BEGIN SELECT RAISE(ABORT, '測試寫入失敗'); END
    `);
  } finally {
    db.close();
  }
  await assert.rejects(rooms.post(id, { text: '@agy', attachments: [
    { kind: 'artifact', name: 'first.txt', bytes: Buffer.from('第一個附件') },
    { kind: 'artifact', name: 'fail.txt', bytes: Buffer.from('故障') },
  ] }), /測試寫入失敗/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'artifacts')), []);
  assert.deepEqual(rooms.read(id).messages, []);
  assert.deepEqual(rooms.take({ source: 'agy', id: AGY_ID }), []);
  assert.equal((await rooms.post(id, { text: '重試成功' })).seq, 1);
});

test('房間點名只按明確意圖喚醒，限制接力去重、深度與額度', async (t) => {
  const ctx = setup(t, { maxDepth: 1, maxWakes: 2 });
  const { rooms, id } = ctx;
  const codex = join(ctx, 'codex', 'codex', CODEX_ID);
  const claude = join(ctx, 'claude', 'claude', CLAUDE_ID);
  join(ctx, 'agy', 'agy', AGY_ID);
  assert.deepEqual((await rooms.post(id, { text: '引用 @all、@agy' }, credentials(claude))).delivery, []);
  await assert.rejects(rooms.post(id, { text: '廣播', wake: ['@ALL'] }, credentials(claude)), /僅可由人類/);
  const unsolicited = await rooms.post(id, { text: '自行接力', wake: ['agy'] }, credentials(claude));
  assert.match(unsolicited.delivery[0].reason, /須回覆/);

  const root = await rooms.post(id, { text: '@claude @unknown 請看' });
  assert.equal(root.root_seq, root.seq);
  assert.equal(root.delivery[0].status, 'pending');
  assert.match(root.delivery[1].reason, /找不到/);
  const relay = await rooms.post(id, { text: '接力', wake: ['codex', 'agy'], reply_to_seq: root.seq }, credentials(claude));
  assert.equal(relay.root_seq, root.seq);
  assert.equal(relay.delivery[0].status, 'pending');
  assert.match(relay.delivery[1].reason, /總額/);
  const duplicate = await rooms.post(id, { text: '再派一次', wake: ['codex'], reply_to_seq: root.seq }, credentials(claude));
  assert.match(duplicate.delivery[0].reason, /已點名/);
  const tooDeep = await rooms.post(id, { text: '太深', wake: ['agy'], reply_to_seq: relay.seq }, credentials(codex));
  assert.match(tooDeep.delivery[0].reason, /深度/);

  const all = await rooms.post(id, { text: '@all 請另看一題。' });
  assert.equal(all.delivery.length, 3);
  assert.equal(all.delivery.filter((entry) => entry.status === 'pending').length, 2);
});

test('Codex queue、Claude asyncRewake 與 agy 同步 hook 共用 outbox，房間不產生私訊回覆', async (t) => {
  const queued = [];
  const registry = createDefaultRegistry({ deliverToCodex: async (sessionId, text) => { queued.push({ sessionId, text }); } });
  const ctx = setup(t, { registry });
  const { rooms, id, home } = ctx;
  join(ctx, 'codex', 'codex', CODEX_ID);
  join(ctx, 'claude', 'claude', CLAUDE_ID);
  join(ctx, 'agy', 'agy', AGY_ID);
  const post = await rooms.post(id, { text: '@all 三位請看' });
  assert.equal(queued[0]?.sessionId, CODEX_ID);
  assert.match(queued[0].text, /room_read/);
  assert.equal(post.delivery.find((entry) => entry.alias === 'codex').status, 'queued');
  await runHook({ home, rooms, registry, source: 'codex', rawInput: {
    hook_event_name: 'UserPromptSubmit', session_id: CODEX_ID, prompt: queued[0].text,
  } });
  const claude = await runHook({
    home, rooms, registry, source: 'claude', sleep: async () => {}, maxPolls: 1, isAbandoned: () => false,
    rawInput: { hook_event_name: 'Stop', session_id: CLAUDE_ID },
  });
  assert.equal(claude.exitCode, 2);
  assert.match(claude.stderr, /@claude/);
  const agyArgs = { home, rooms, registry, source: 'agy', rawInput: { hookEventName: 'Stop', conversationId: AGY_ID } };
  assert.equal(JSON.parse((await runHook(agyArgs)).stdout).decision, 'continue');
  assert.deepEqual(JSON.parse((await runHook(agyArgs)).stdout), {});
  const after = rooms.read(id);
  assert.equal(after.messages.length, 1);
  assert.ok(after.messages[0].delivery.every(({ status }) => status === 'handed_off'));
  assert.equal(fs.existsSync(path.join(home, `agy-${AGY_ID}`, 'new')), false);
});

test('排隊回執失敗時保留貼文及未確認狀態，重試不重送', async (t) => {
  let attempts = 0;
  const registry = createDefaultRegistry({ deliverToCodex: async () => { attempts += 1; throw new Error('失去回執'); } });
  const ctx = setup(t, { registry });
  const { rooms, id } = ctx;
  join(ctx, 'coder', 'codex', CODEX_ID);
  const draft = { text: '@coder 請看', client_message_id: 'human-retry' };
  const first = await rooms.post(id, draft);
  assert.equal(first.delivery[0].status, 'uncertain');
  assert.equal((await rooms.post(id, draft)).seq, first.seq);
  assert.equal(rooms.read(id).messages.length, 1);
  assert.equal(attempts, 1);
});

test('快照內容獨立、工作區參照可讀行號、附件打開時檢查越界', async (t) => {
  const ctx = setup(t);
  const { rooms, id, cwd, home } = ctx;
  const agent = join(ctx, 'agy', 'agy', AGY_ID);
  const file = path.join(cwd, 'screenshot.png');
  fs.writeFileSync(file, screenshot);
  fs.writeFileSync(path.join(cwd, 'sample.txt'), '第一行\n第二行\n第三行');
  const post = await rooms.post(id, { attachments: [
    { kind: 'artifact', path: 'screenshot.png', name: '../../picture.png' },
    { kind: 'workspace_ref', path: 'sample.txt', lines: { start: 2, end: 2 }, note: '關鍵行' },
  ] }, credentials(agent));
  const [snapshot, ref] = post.attachments;
  assert.equal(snapshot.name, 'picture.png');
  assert.equal(snapshot.path, '1-picture.png');
  assert.equal(snapshot.mime, 'image/png');
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ref.path, 'sample.txt');
  fs.unlinkSync(file);
  const saved = rooms.attachment(id, snapshot.id);
  assert.deepEqual(saved.bytes, screenshot);
  const outside = path.join(home, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  for (const kind of ['workspace_ref', 'artifact']) {
    await assert.rejects(rooms.post(id, { attachments: [{ kind, path: outside }] }, credentials(agent)), /位於允許/);
  }
  if (process.platform !== 'win32') {
    const symlink = path.join(cwd, 'sample.txt');
    fs.unlinkSync(symlink);
    fs.symlinkSync(outside, symlink);
    assert.throws(() => rooms.attachment(id, ref.id), /位於允許/);
  }
  fs.writeFileSync(saved.local_path, '已修改');
  assert.throws(() => rooms.attachment(id, snapshot.id), /已變更/);
});

test('stdio MCP 以標準 ImageContent 與文字回傳附件', { timeout: 10000 }, async (t) => {
  const ctx = setup(t);
  const { rooms, id, cwd, home } = ctx;
  const m = join(ctx, 'claude', 'claude', CLAUDE_ID);
  fs.writeFileSync(path.join(cwd, 'sample.txt'), '第一行\n第二行\n第三行');
  const result = await rooms.post(id, { attachments: [
    { kind: 'artifact', name: 'screen.png', bytes: screenshot },
    { kind: 'workspace_ref', path: 'sample.txt', lines: { start: 2, end: 2 } },
  ] });
  const client = new Client({ name: 'room-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
    env: { SESSION_BRIDGE_HOME: home },
  });
  try {
    await client.connect(transport);
    const auth = { room_id: id, room_token: m.room_token };
    const tools = await client.listTools();
    assert.equal(tools.tools.filter(({ name }) => name.startsWith('room_')).length, 3);
    const read = await client.callTool({ name: 'room_read', arguments: { ...auth, since_seq: 0 } });
    assert.equal(JSON.parse(read.content[0].text).messages[0].attachments.length, 2);
    const posted = await client.callTool({ name: 'room_post', arguments: { ...auth, actor: 'human', text: '@all 引文' } });
    const message = JSON.parse(posted.content[0].text);
    assert.equal(message.actor, 'agent');
    assert.deepEqual(message.delivery, []);
    const [image, text] = await Promise.all(result.attachments.map(({ id: attachment_id }) =>
      client.callTool({ name: 'room_get_attachment', arguments: { ...auth, attachment_id } })));
    assert.match(image.content[0].text, /本機路徑/);
    assert.deepEqual(image.content[1], { type: 'image', data: screenshot.toString('base64'), mimeType: 'image/png' });
    assert.equal(text.content[1].text, '第二行');
  } finally {
    await client.close();
  }
});

test('CLI 建房、加成員、列出房間並從互動看板貼截圖及發言', async (t) => {
  const { home, cwd } = setup(t);
  const args = { home };
  const created = JSON.parse(await runCli(['room', 'create', 'CLI 房間', '--cwd', cwd, '--json'], args));
  const added = JSON.parse(await runCli(['room', 'add', created.id, 'agy', 'agy', AGY_ID, '--json'], args));
  assert.match(added.room_token, /^[a-f0-9]{48}$/);
  assert.match(await runCli(['room', 'list'], args), /CLI 房間/);
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.on('data', (chunk) => { transcript += chunk.toString(); });
  fs.writeFileSync(path.join(cwd, 'tmp.txt'), '稍後快照');
  const rooms = createRooms({ home });
  const launched = watchRoom({ rooms, roomId: created.id, interactive: true, input, output, readClipboard: async () => screenshot });
  input.end(`/attach "${path.join(cwd, 'tmp.txt')}"\n/paste\n@agy 給你截圖\n`);
  await launched;
  const [post] = rooms.read(created.id).messages;
  assert.equal(post.text, '@agy 給你截圖');
  assert.equal(post.attachments[1].mime, 'image/png');
  assert.match(transcript, /等待領取/);
  let openPath;
  const openInput = new PassThrough();
  const open = watchRoom({ rooms, roomId: created.id, interactive: true, input: openInput, output,
    openFile: async (file) => { openPath = file; } });
  openInput.end(`/open ${post.attachments[0].id}\n/exit\n`);
  await open;
  assert.equal(path.basename(openPath), '1-tmp.txt');
});

test('Web POST 驗證本機來源與身分，SSE 串流依游標補播，圖片可預覽', { timeout: 10000 }, async (t) => {
  const { rooms, id } = setup(t);
  await rooms.post(id, { text: '已在游標前' });
  const board = await serveRoom({ rooms, roomId: id });
  const url = new URL(board.url);
  const endpoints = (route) => new URL(route, url);
  const controller = new AbortController();
  try {
    const page = await fetch(endpoints('/'));
    assert.match(await page.text(), /<script src="\/room.js"/);
    assert.equal((await fetch(endpoints('/api/messages'))).status, 401);
    const session = await fetch(endpoints('/api/session'), {
      method: 'POST', headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}` },
    });
    assert.equal(session.status, 204);
    const Cookie = session.headers.get('set-cookie').split(';')[0];
    const body = JSON.stringify({ text: '人類貼圖', actor: 'agent',
      attachments: [{ kind: 'artifact', name: '貼圖.png', data: screenshot.toString('base64') }] });
    const headers = { Cookie, Origin: url.origin, 'Content-Type': 'application/json' };
    const rejected = await fetch(endpoints('/api/messages'), { method: 'POST', headers: { ...headers, Origin: 'https://example.org' }, body });
    assert.equal(rejected.status, 403);
    const events = await fetch(endpoints('/api/events?since_seq=0'), {
      headers: { Cookie, 'Last-Event-ID': '1' }, signal: controller.signal,
    });
    assert.match(events.headers.get('content-type'), /text\/event-stream/);
    const posted = await fetch(endpoints('/api/messages'), { method: 'POST', headers, body });
    assert.equal(posted.status, 201);
    const data = await posted.json();
    assert.equal(data.actor, 'human');
    assert.equal(data.seq, 2);
    const reader = events.body.getReader();
    let buffer = '';
    while (!buffer.includes('人類貼圖')) {
      const part = await reader.read();
      assert.equal(part.done, false);
      buffer += Buffer.from(part.value).toString('utf8');
    }
    assert.match(buffer, /id: 2\nevent: message/);
    assert.doesNotMatch(buffer, /已在游標前/);
    const image = await fetch(endpoints(`/api/attachments/${data.attachments[0].id}`), { headers: { Cookie } });
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), screenshot);
  } finally {
    controller.abort();
    await board.close();
  }
});

test('預設清理保護 rooms，選用房間保留期才清除過期資料', async (t) => {
  const day = 86400000;
  const now = Date.now();
  const { home, cwd, id } = setup(t, { clock: () => now - 30 * day });
  const roomsRoot = path.join(home, 'rooms');
  fs.utimesSync(roomsRoot, (now - 31 * day) / 1000, (now - 31 * day) / 1000);
  await pruneStorage({ home, now });
  const rooms = createRooms({ home });
  assert.equal(rooms.info(id).id, id);
  const fresh = rooms.create({ title: '仍在使用', cwd });
  assert.equal((await pruneStorage({ home, now, roomsDays: 14 })).roomsRemoved, 1);
  assert.equal(rooms.info(fresh.id).id, fresh.id);
  assert.throws(() => rooms.info(id), /找不到/);
});

test('start_task 與恢復已有原生 session 的 resume_task 都傳入房間 ID', async (t) => {
  const { rooms, home, cwd, id } = setup(t);
  const specs = [];
  const store = createTaskStore(home);
  const tasks = createTaskTools({ store, rooms, defaultCwd: cwd, launcher: async (spec) => {
    specs.push(spec);
    return { launcher: 'test' };
  } });
  const task = await tasks.start({ provider: 'codex', prompt: '開始工作', room_id: id });
  assert.equal(task.roomId, id);
  assert.match(specs[0].prompt, new RegExp(id));
  await store.update(task.id, { sessions: { codex: CODEX_ID } });
  await tasks.resume({ id: task.id, prompt: '繼續' });
  assert.match(specs[1].prompt, new RegExp(id));
});
