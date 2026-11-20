import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_POST_ATTACHMENTS = 4;
export const MAX_POST_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const realFile = (root, requested) => {
  if (typeof requested !== 'string' || !requested) throw new Error('附件須提供有效路徑');
  const file = root ? path.resolve(root, requested) : path.resolve(requested);
  if (root && !inside(root, file)) throw new Error('附件路徑須位於允許的目錄內');
  if (root && process.platform === 'win32' && path.relative(root, file).includes(':')) {
    throw new Error('附件路徑不可使用替代資料流');
  }
  const real = fs.realpathSync(file);
  if (root && !inside(root, real)) throw new Error('附件路徑須位於允許的目錄內');
  if (!fs.statSync(real).isFile()) throw new Error('附件須為一般檔案');
  return real;
};

const readBytes = (file, max = MAX_ATTACHMENT_BYTES) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) throw new Error('附件須為大小上限內的一般檔案');
    const chunks = [];
    let total = 0;
    while (total <= max) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total));
      const size = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      total += size;
      chunks.push(chunk.subarray(0, size));
    }
    if (total > max) throw new Error('附件超過大小上限');
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(fd);
  }
};

const safeName = (name) => {
  const leaf = String(name ?? 'file').split(/[\\/]/).pop();
  const clean = leaf.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  return [...clean].slice(0, 54).join('') || 'file';
};

const textOf = (bytes) => {
  if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const imageMime = (bytes) => {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const attachmentMime = (bytes) => imageMime(bytes) ?? (textOf(bytes) !== null ? 'text/plain' : 'application/octet-stream');

const previewMime = (file) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(12);
    return imageMime(header.subarray(0, fs.readSync(fd, header)));
  } finally {
    fs.closeSync(fd);
  }
};

export const isPreviewImage = (mime) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);

export const prepareAttachments = (drafts, workspace, { agent } = {}) => {
  if (!Array.isArray(drafts) || drafts.length > MAX_POST_ATTACHMENTS) throw new Error('每則貼文最多 4 個附件');
  let total = 0;
  return drafts.map((draft) => {
    if (draft?.kind === 'workspace_ref' && typeof draft.path === 'string') {
      const file = realFile(workspace, draft.path);
      const lines = draft.lines;
      if (lines && (!Number.isSafeInteger(lines.start) || !Number.isSafeInteger(lines.end)
        || lines.start < 1 || lines.start > lines.end)) throw new Error('附件行號範圍無效');
      if (draft.note !== undefined && (typeof draft.note !== 'string' || draft.note.length > 1000)) {
        throw new Error('附件備註最多 1000 字');
      }
      return {
        kind: draft.kind, name: path.basename(file), path: path.relative(workspace, file),
        lines: lines ?? null, note: draft.note ?? null, mime: previewMime(file),
      };
    }
    if (draft?.kind !== 'artifact') throw new Error('無效的附件類別');
    const bytes = !agent && Buffer.isBuffer(draft.bytes)
      ? draft.bytes
      : readBytes(realFile(agent ? workspace : null, draft.path));
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('附件超過 8 MiB');
    total += bytes.length;
    if (total > MAX_POST_ATTACHMENT_BYTES) throw new Error('每則貼文的附件總大小不得超過 16 MiB');
    return {
      kind: draft.kind, name: safeName(draft.name ?? draft.path), bytes, mime: attachmentMime(bytes),
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
};

export const saveAttachment = (db, directory, seq, prepared, created) => {
  const { bytes, ...record } = prepared;
  const id = randomUUID();
  if (bytes) {
    let file = path.join(directory, `${seq}-${record.name}`);
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      file = path.join(directory, `${seq}-${id.slice(0, 8)}-${record.name}`);
      fd = fs.openSync(file, 'wx', 0o600);
    }
    created.push(file);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    record.path = path.basename(file);
  }
  db.prepare('INSERT INTO attachments VALUES (?, ?, ?)').run(id, seq, JSON.stringify(record));
  return { id, ...record };
};

export const readAttachment = (record, directory, workspace, { includeBytes = true } = {}) => {
  const artifact = record.kind === 'artifact';
  const file = realFile(artifact ? directory : workspace, record.path);
  if (!includeBytes) return { ...record, local_path: file };
  const bytes = readBytes(file);
  if (artifact && createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
    throw new Error('房間快照內容已變更');
  }
  return { ...record, local_path: file, mime: attachmentMime(bytes), bytes };
};

export const attachmentContent = ({ bytes, mime, local_path: file, lines }) => {
  const content = [{ type: 'text', text: `本機路徑：${file}` }];
  if (isPreviewImage(mime)) content.push({ type: 'image', data: bytes.toString('base64'), mimeType: mime });
  if (mime === 'text/plain') {
    const text = textOf(bytes);
    const selected = lines ? text.split(/\r?\n/).slice(lines.start - 1, lines.end).join('\n') : text;
    content.push({ type: 'text', text: selected.slice(0, MAX_TEXT_BYTES) });
  }
  return { content };
};
