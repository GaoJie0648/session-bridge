import { execFile } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

import { MAX_ATTACHMENT_BYTES } from './room-attachments.js';
import { serveRoom } from './room-web.js';
import { createRooms } from './rooms.js';

const exec = promisify(execFile);
const labels = {
  pending: '等待領取', dispatching: '排隊中', queued: '已排隊',
  handed_off: '已交給 hook', skipped: '未喚醒', uncertain: '送達未確認',
};
const termSafe = (value) => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const deliveryLine = (item) =>
  `  #${item.seq} @${item.alias} ${labels[item.status] ?? item.status}${item.reason ? `（${item.reason}）` : ''}`;

const clipboardScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bridgeImage = [Windows.Forms.Clipboard]::GetImage()
if ($null -eq $bridgeImage) { throw 'Clipboard does not contain an image' }
$bridgeStream = [IO.MemoryStream]::new()
try {
  $bridgeImage.Save($bridgeStream, [Drawing.Imaging.ImageFormat]::Png)
  if ($bridgeStream.Length -gt ${MAX_ATTACHMENT_BYTES}) { throw 'Clipboard image is too large' }
  [Console]::Write([Convert]::ToBase64String($bridgeStream.ToArray()))
} finally {
  $bridgeImage.Dispose()
  $bridgeStream.Dispose()
}
`;

const clipboard = async () => {
  if (process.platform !== 'win32') throw new Error('/paste 需要 Windows 剪貼簿');
  try {
    const encoded = Buffer.from(clipboardScript, 'utf16le').toString('base64');
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      maxBuffer: Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4096, timeout: 15000, windowsHide: true,
    });
    return Buffer.from(stdout.trim(), 'base64');
  } catch {
    throw new Error('無法擷取剪貼簿圖片。請先複製 8 MiB 以內的圖片');
  }
};

const reveal = async (file) => {
  if (process.platform !== 'win32') return;
  // 選取檔案供使用者決定如何開啟，避免直接執行共享的檔案。
  try {
    await exec('explorer.exe', ['/select,', file], { timeout: 5000, windowsHide: true });
  } catch (error) {
    // Explorer 將要求交給既有視窗時可能以 1 結束。
    if (error.code !== 1) throw error;
  }
};

const toPath = (file) => file.trim().replace(/^"(.+)"$/, '$1');

export const watchRoom = async ({
  rooms, roomId, interactive = false, input = process.stdin, output = process.stdout, signal,
  readClipboard = clipboard, openFile = reveal,
}) => {
  const first = rooms.read(roomId);
  let seq = first.next_seq;
  let revision = first.revision;
  let roster = JSON.stringify(first.members);
  const snapshots = new Map();
  const colored = (code, word) => output.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${termSafe(word)}\u001b[0m` : termSafe(word);
  const render = (message) => {
    message.delivery.forEach((status) => snapshots.set(`${status.seq}/${status.alias}`, status.revision));
    const who = message.actor === 'human' ? '使用者' : `@${message.alias}`;
    const time = new Date(message.at).toLocaleTimeString('zh-TW', { hour12: false });
    const parent = message.reply_to_seq ? ` ↳ #${message.reply_to_seq}` : '';
    return [
      `#${message.seq} ${time} ${colored(message.actor === 'human' ? 32 : 36, who)}${parent} ${termSafe(message.text)}`,
      ...message.attachments.map((item) => `  [${item.kind === 'artifact' ? '快照' : '工作區參考'}] ${termSafe(item.name)} · /open ${item.id}`),
      ...message.delivery.map((item) => termSafe(deliveryLine(item))),
    ].join('\n');
  };
  const memberLine = (members) => `成員 ${members.map((member) => `@${member.alias}`).join('、') || '尚未加入 agent'}`;
  output.write(`${colored(1, first.title)}\n${memberLine(first.members)}\n`);
  if (first.messages.length) output.write(`${first.messages.map(render).join('\n')}\n`);
  if (signal?.aborted) return;

  const terminal = Boolean(input.isTTY && output.isTTY);
  const lineReader = interactive ? readline.createInterface({ input, output, terminal, prompt: '你 > ' }) : null;
  let prompting = false;
  let closed = false;
  let attachments = [];
  let commands = Promise.resolve();
  const prompt = () => {
    if (!lineReader || closed || !terminal) return;
    lineReader.prompt(true);
    prompting = true;
  };
  const print = (value) => {
    if (closed) return;
    if (prompting) {
      readline.moveCursor(output, 0, -lineReader.getCursorPos().rows);
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
    }
    output.write(`${value}\n`);
    if (prompting) prompt();
  };
  const send = async (text) => {
    await rooms.post(roomId, { text, attachments });
    attachments = [];
  };
  const attach = (item) => {
    if (attachments.length >= 4) throw new Error('最多 4 個待送附件');
    attachments.push(item);
    print('附件已準備，請輸入訊息或用 /send 送出。');
  };
  const tick = () => {
    const page = rooms.read(roomId, { since_seq: seq });
    seq = page.next_seq;
    const nextRoster = JSON.stringify(page.members);
    if (nextRoster !== roster) {
      roster = nextRoster;
      print(memberLine(page.members));
    }
    if (page.messages.length) print(page.messages.map(render).join('\n'));
    for (const status of rooms.changes(roomId, revision)) {
      revision = status.revision;
      const key = `${status.seq}/${status.alias}`;
      if ((snapshots.get(key) ?? 0) < status.revision) print(termSafe(deliveryLine(status)));
      snapshots.set(key, status.revision);
    }
  };

  await new Promise((resolve) => {
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', finish);
      process.removeListener('SIGINT', finish);
      lineReader?.close();
      commands.then(resolve);
    };
    const handle = async (line) => {
      const [command, ...rest] = line.trim().split(' ');
      const arg = rest.join(' ').trim();
      switch (command) {
        case '/exit': finish(); break;
        case '/help': print('/attach <path>、/attach --ref <path>、/paste、/open <id>、/send、/clear、/exit'); break;
        case '/clear': attachments = []; print('已清除待送附件。'); break;
        case '/send': await send(''); break;
        case '/attach':
          if (!arg || arg === '--ref') throw new Error('請提供附件路徑');
          if (arg.startsWith('--ref ')) attach({ kind: 'workspace_ref', path: toPath(arg.slice(6)) });
          else attach({ kind: 'artifact', path: path.resolve(toPath(arg)) });
          break;
        case '/paste':
          attach({ kind: 'artifact', name: 'clipboard.png', bytes: await readClipboard() });
          break;
        case '/open': {
          const item = rooms.attachment(roomId, arg, { includeBytes: false });
          print(termSafe(item.local_path));
          await openFile(item.local_path);
          break;
        }
        case '': break;
        default: await send(line);
      }
    };
    const timer = setInterval(() => {
      try { tick(); } catch (error) { print(termSafe(error.message)); finish(); }
    }, 350);
    signal?.addEventListener('abort', finish, { once: true });
    process.once('SIGINT', finish);
    lineReader?.on('line', (line) => {
      prompting = false;
      commands = commands.then(async () => {
        if (closed) return;
        try { await handle(line); tick(); } catch (error) { print(termSafe(error.message)); }
        prompt();
      });
    });
    lineReader?.on('SIGINT', finish);
    lineReader?.once('close', () => { commands.then(finish); });
    if (interactive) {
      print('輸入訊息可發言，@別名 可點名。輸入 /help 查看指令。');
      prompt();
    }
  });
};

export const runRoomCli = async ({
  args, values, home, registry, output = process.stdout, input = process.stdin,
}) => {
  const [action, id, alias, source, sessionId] = args;
  const rooms = createRooms({ home, registry });
  switch (action) {
    case 'create': {
      const room = rooms.create({ title: id, cwd: values.cwd });
      return values.json ? `${JSON.stringify(room, null, 2)}\n` : `已建立 ${termSafe(room.title)}\n${room.id}\n`;
    }
    case 'add': {
      const member = rooms.add(id, { alias, source, sessionId });
      return values.json ? `${JSON.stringify(member, null, 2)}\n`
        : `已加入 @${member.alias}（${member.source}）\n請私下把 room_id ${id} 和 room_token ${member.room_token} 交給該 session。\n`;
    }
    case 'list': {
      const list = rooms.list();
      if (values.json) return `${JSON.stringify(list, null, 2)}\n`;
      return list.length ? `${list.map((room) => `${room.id}  ${termSafe(room.title)}  ${room.members.length} 位 agent`).join('\n')}\n` : '目前沒有群組房間。\n';
    }
    case 'watch':
      await watchRoom({ rooms, roomId: id, interactive: values.interactive, input, output });
      return '';
    case 'serve': {
      const board = await serveRoom({ rooms, roomId: id, port: values.port === undefined ? 0 : Number(values.port) });
      return `在瀏覽器開啟以下網址。網址包含看板憑證，請勿轉貼。\n${board.url}\n`;
    }
    default: throw new Error('請用 room create、add、list、watch 或 serve（詳見 --help）');
  }
};
