const byId = (id) => document.getElementById(id);
const messages = byId('messages');
const form = byId('compose');
const text = byId('text');
const filter = byId('filter');
const deliveryLabels = {
  pending: '等待領取', dispatching: '排隊中', queued: '已排隊',
  handed_off: '已交給 hook', skipped: '未喚醒', uncertain: '送達未確認',
};
const rendered = new Map();
let uploads = [];
let replyTo;
let posting = false;
let ready = false;
let draftId;

const element = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
};

const request = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error((await response.json()).error);
  return response.status === 204 ? null : response.json();
};

const applyFilter = () => {
  for (const { article, alias } of rendered.values()) article.hidden = Boolean(filter.value && alias !== filter.value);
};

const updateMembers = (members) => {
  const selected = filter.value;
  const aliases = new Set(['human', ...members.map((member) => member.alias), ...[...rendered.values()].map((row) => row.alias)]);
  filter.replaceChildren(new Option('全部成員', ''), ...[...aliases].sort().map((alias) =>
    new Option(alias === 'human' ? '使用者' : `@${alias}`, alias)));
  filter.value = aliases.has(selected) ? selected : '';
  applyFilter();
};

const setReply = (seq) => {
  draftId = undefined;
  replyTo = seq;
  byId('reply').hidden = !seq;
  byId('reply').firstElementChild.textContent = seq ? `回覆 #${seq}` : '';
  if (seq) text.focus();
};

const attachmentLink = (attachment) => {
  const url = `/api/attachments/${attachment.id}`;
  const item = element('li');
  const link = element('a', attachment.name);
  link.href = url;
  link.download = attachment.name;
  item.append(link);
  if (attachment.lines) item.append(`（第 ${attachment.lines.start}–${attachment.lines.end} 行）`);
  if (attachment.note) item.append(` ${attachment.note}`);
  if (attachment.mime?.startsWith('image/')) {
    const thumbnail = element('button', undefined, 'thumbnail');
    thumbnail.type = 'button';
    const image = element('img');
    image.src = url;
    image.loading = 'lazy';
    image.alt = `放大 ${attachment.name}`;
    thumbnail.append(image);
    thumbnail.addEventListener('click', () => {
      byId('full-image').src = url;
      byId('full-image').alt = attachment.name;
      byId('preview').showModal();
    });
    item.append(thumbnail);
  }
  return item;
};

const updateDelivery = (change) => {
  const row = rendered.get(change.seq);
  if (!row) return;
  const previous = row.targets.get(change.alias);
  if (previous && previous.revision >= change.revision) return;
  const item = previous?.item ?? element('li');
  item.textContent = `@${change.alias} · ${deliveryLabels[change.status] ?? change.status}${change.reason ? `（${change.reason}）` : ''}`;
  if (!previous) row.delivery.append(item);
  row.targets.set(change.alias, { item, revision: change.revision });
  row.delivery.hidden = false;
};

const renderMessage = (message) => {
  if (rendered.has(message.seq)) {
    message.delivery.forEach(updateDelivery);
    return;
  }
  const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
  byId('empty').hidden = true;
  const article = element('article');
  article.id = `message-${message.seq}`;
  const metadata = element('div', undefined, 'meta');
  const date = new Date(message.at);
  const time = element('time', date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }));
  time.dateTime = date.toISOString();
  time.title = date.toLocaleString('zh-TW');
  metadata.append(element('strong', message.actor === 'human' ? '使用者' : `@${message.alias}`),
    element('span', `#${message.seq}`), time);
  if (message.reply_to_seq) {
    const parent = element('a', `回覆 #${message.reply_to_seq}`);
    parent.href = `#message-${message.reply_to_seq}`;
    metadata.append(parent);
  }
  const reply = element('button', '回覆');
  reply.type = 'button';
  reply.addEventListener('click', () => { if (!posting) setReply(message.seq); });
  metadata.append(reply);
  article.append(metadata);
  if (message.text) article.append(element('p', message.text, 'body'));
  if (message.attachments.length) {
    const attachments = element('ul', undefined, 'attachments');
    attachments.append(...message.attachments.map(attachmentLink));
    article.append(attachments);
  }
  const delivery = element('ul', undefined, 'delivery');
  delivery.hidden = true;
  article.append(delivery);
  rendered.set(message.seq, { alias: message.alias, article, delivery, targets: new Map() });
  message.delivery.forEach(updateDelivery);
  messages.append(article);
  if (![...filter.options].some((option) => option.value === message.alias)) {
    filter.add(new Option(`@${message.alias}`, message.alias));
  }
  article.hidden = Boolean(filter.value && message.alias !== filter.value);
  if (follow) messages.scrollTop = messages.scrollHeight;
};

const syncComposer = () => {
  byId('send').disabled = !ready || posting || (!text.value.trim() && !uploads.length);
  byId('files').disabled = posting;
  text.readOnly = posting;
  byId('uploads').replaceChildren(...uploads.map((file, index) => {
    const item = element('li', `${file.name} `);
    const remove = element('button', '移除');
    remove.type = 'button';
    remove.disabled = posting;
    remove.addEventListener('click', () => {
      draftId = undefined;
      uploads.splice(index, 1);
      syncComposer();
    });
    item.append(remove);
    return item;
  }));
};

const queueFiles = (files) => {
  if (posting) return;
  const next = [...uploads, ...files];
  const mb = 1024 * 1024;
  if (next.length > 4 || next.some((file) => file.size > 8 * mb)
    || next.reduce((bytes, file) => bytes + file.size, 0) > 16 * mb) {
    byId('error').textContent = '最多 4 個附件，每個 8 MiB，合計 16 MiB。';
    return;
  }
  byId('error').textContent = '';
  uploads = next;
  draftId = undefined;
  syncComposer();
};

const encode = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(`無法讀取 ${file.name}`));
  reader.onload = () => resolve({ kind: 'artifact', name: file.name, data: reader.result.split(',')[1] });
  reader.readAsDataURL(file);
});

filter.addEventListener('change', applyFilter);
text.addEventListener('input', () => { draftId = undefined; syncComposer(); });
byId('cancel-reply').addEventListener('click', () => { if (!posting) setReply(); });
byId('files').addEventListener('change', (event) => {
  queueFiles(event.target.files);
  event.target.value = '';
});
window.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
  if (files.length && !posting) { event.preventDefault(); queueFiles(files); }
});
window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  form.classList.add('dragging');
});
window.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) form.classList.remove('dragging');
});
window.addEventListener('drop', (event) => {
  form.classList.remove('dragging');
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  queueFiles(event.dataTransfer.files);
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (byId('send').disabled) return;
  posting = true;
  byId('error').textContent = '';
  draftId ??= crypto.randomUUID();
  const clientMessageId = draftId;
  const reply = replyTo;
  syncComposer();
  try {
    const attachments = await Promise.all(uploads.map(encode));
    await request('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.value, attachments, reply_to_seq: reply, client_message_id: clientMessageId }),
    });
    text.value = '';
    uploads = [];
    setReply();
  } catch (error) {
    byId('error').textContent = error.message;
  } finally {
    posting = false;
    syncComposer();
  }
});

const connect = async () => {
  const token = location.hash.slice(1);
  if (/^[a-f0-9]{64}$/.test(token)) {
    await request('/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    history.replaceState(null, '', '/');
  }
  const page = await request('/api/messages');
  byId('title').textContent = page.title;
  updateMembers(page.members);
  page.messages.forEach(renderMessage);
  const stream = new EventSource(`/api/events?since_seq=${page.next_seq}`);
  stream.addEventListener('open', () => {
    byId('connection').textContent = '即時連線中';
    ready = true;
    syncComposer();
  });
  stream.addEventListener('message', (event) => renderMessage(JSON.parse(event.data)));
  stream.addEventListener('delivery', (event) => updateDelivery(JSON.parse(event.data)));
  stream.addEventListener('members', (event) => updateMembers(JSON.parse(event.data)));
  stream.addEventListener('error', () => {
    byId('connection').textContent = '連線中斷，正在重連';
  });
  stream.addEventListener('unavailable', () => {
    stream.close();
    ready = false;
    byId('connection').textContent = '房間暫時無法開啟';
    syncComposer();
  });
};
connect().catch((error) => { byId('connection').textContent = error.message; });
