import { fileURLToPath } from 'node:url';

import { maybeAutoPrune } from './cleanup.js';
import { STATES } from './mailbox.js';
import { logError, truncate } from './util.js';

const cliScriptPath = fileURLToPath(new URL('./cli.js', import.meta.url)).replaceAll('\\', '/');

// 訊息可能成為 CLI 參數，保留安全上限
const TEXT_MAX = 8000;
const PAIR_LIMIT = 30;
const RECIPIENT_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NO_TEXT_REPLY = '（對方的回合已結束，但沒有文字回覆。）';
const MARKER = /\[session-bridge:(\d+-[0-9a-f]{8})\]/g;

const same = (a, b) => a.source === b.source && a.id.toLowerCase() === b.id.toLowerCase();
const nameOf = ({ source, id }) => `${source} ${id}`;
const addressOf = ({ source, id }) => ({ source, id });

// 本文若夾帶標記，收件端的 hook 會誤把別則訊息標成處理中
const defuse = (text) => text.replaceAll('[session-bridge:', '[session-bridge\u200b:');

// 舊版寄出的訊息沒有 expectsReply 欄位，視為要回覆
const wantsReply = ({ auto, expectsReply }) => !auto && expectsReply !== false;

const verifyHint = (from) =>
  `如需核對是否為使用者本人授權或確認原話，請直接呼叫 session-bridge 的 read_session(source="${from.source}", id="${from.id}", roles=["user"]) 查證後直接執行，無需再詢問使用者。`;

const footerOf = (message) => {
  const { from, to } = message;
  const replyWith = `send_message：from_source=${to.source}、from_id=${to.id}、to_source=${from.source}、to_id=${from.id}`;
  if (message.auto) {
    return '（這是對方回合結束時自動轉寄的最後回覆，不需要回覆；要接著交辦再用 send_message。）';
  }
  if (!wantsReply(message)) {
    return `（${verifyHint(from)}不需要回覆，你這回合的回覆也不會轉寄給對方；有事要告訴對方再用 session-bridge 的 ${replyWith}。）`;
  }
  return `（${verifyHint(from)}要回覆請用 session-bridge 的 ${replyWith}；若沒有另外回覆，你這回合結束時的最後回覆會自動轉寄給對方。）`;
};

export const renderMessage = (message) => {
  const cwdPart = message.fromCwd ? `（cwd=${message.fromCwd}）` : '';
  return [
    `[session-bridge:${message.id}] 來自 ${nameOf(message.from)} 的協作訊息${cwdPart}：`,
    '',
    defuse(message.text),
    '',
    footerOf(message),
  ].join('\n');
};

/**
 * @param {{
 *   mailbox: ReturnType<typeof import('./mailbox.js').createMailbox>,
 *   registry?: ReturnType<typeof import('./providers/registry.js').createRegistry>,
 *   deliverToCodex?: (threadId: string, text: string) => Promise<void>,
 *   findSession?: (source: string, id: string) => Promise<{ source: string, id: string, cwd?: string }>,
 *   pairLimit?: number,
 *   recipientLimit?: number,
 * }} config
 */
export const createMessaging = ({
  mailbox,
  registry,
  deliverToCodex,
  findSession,
  pairLimit = PAIR_LIMIT,
  recipientLimit = RECIPIENT_LIMIT,
}) => {
  const deliverOf = (source) => {
    if (registry?.has(source)) return registry.get(source).deliverMessage ?? null;
    if (source === 'codex' && deliverToCodex) return deliverToCodex;
    return null;
  };

  const received = async (address, since) =>
    (await Promise.all(STATES.map((state) => mailbox.list(address, state, since)))).flat();

  const assertWithinLimits = async (sender, recipient) => {
    const since = Date.now() - RATE_WINDOW_MS;
    const [toRecipient, toSender] = await Promise.all([received(recipient, since), received(sender, since)]);
    const exchanged =
      toRecipient.filter((message) => same(message.from, sender)).length +
      toSender.filter((message) => same(message.from, recipient)).length;
    if (exchanged >= pairLimit) {
      throw new Error(`這兩個 session 一小時內已互傳 ${pairLimit} 則訊息，達到上限；請向使用者回報，由使用者決定是否繼續。`);
    }
    if (toRecipient.length >= recipientLimit) {
      throw new Error(`${nameOf(recipient)} 一小時內已收到 ${recipientLimit} 則訊息，達到上限；請向使用者回報，由使用者決定是否繼續。`);
    }
  };

  const moveAll = async (address, messages, from, toOf) => {
    const results = await Promise.allSettled(
      messages.map((message) => mailbox.move(address, message.id, from, toOf(message))),
    );
    results.filter((result) => result.status === 'rejected').forEach((result) => logError(result.reason));
    return messages.filter((_, index) => results[index].status === 'fulfilled' && results[index].value);
  };

  const post = async (draft) => {
    const deliver = deliverOf(draft.to.source);
    const settled = !wantsReply(draft) && Boolean(deliver);
    const message = await mailbox.add(draft, settled ? 'done' : 'new');
    if (!deliver) return message;
    try {
      await deliver(message.to.id, renderMessage(message));
    } catch (error) {
      if (!settled) await mailbox.move(message.to, message.id, 'new', 'done');
      throw error;
    }
    return message;
  };

  const send = async ({ from, to, text, expectsReply }) => {
    if (same(from, to)) throw new Error('不能傳訊息給自己。');
    if (text.length > TEXT_MAX) {
      throw new Error(`訊息過長（${text.length} 字），上限 ${TEXT_MAX} 字；較長的內容請寫入檔案後傳路徑。`);
    }
    const senderSession = await findSession(from.source, from.id);
    const recipientSession = await findSession(to.source, to.id);
    const sender = addressOf(senderSession);
    const recipient = addressOf(recipientSession);
    await assertWithinLimits(sender, recipient);
    const answered = (await mailbox.list(sender, 'active')).filter((incoming) => same(incoming.from, recipient));
    const message = await post({
      from: sender,
      to: recipient,
      fromCwd: senderSession.cwd,
      text,
      expectsReply: expectsReply ?? answered.length === 0,
    });
    await moveAll(sender, answered, 'active', () => 'done');
    await mailbox.prune(recipient, Date.now() - DONE_RETENTION_MS);
    if (mailbox.root) await maybeAutoPrune(mailbox.root);

    const hasDirectDelivery = Boolean(deliverOf(recipient.source));
    const delivery = hasDirectDelivery
      ? '已排入對方的佇列：對方閒置時會立刻開始處理，忙碌時會在目前回合結束後處理；若對方的 session 沒有開著，要等它下次開啟。'
      : '已送入對方的信箱：若對方已設定自動收信 hook 會於回合結束時收到，否則可呼叫 check_inbox 讀取。';
    const senderProvider = registry?.has(sender.source) ? registry.get(sender.source) : null;
    const senderNeedsWaitHint = Boolean(
      message.expectsReply && senderProvider && !senderProvider.deliverMessage && !senderProvider.supportsInboxWaiter,
    );
    const followUp = message.expectsReply
      ? senderNeedsWaitHint
        ? `對方回覆後會送入你的信箱（回合結束或下次呼叫時由 hook 自動帶入）；若希望閒置時自動喚醒收信，可在背景執行：node "${cliScriptPath}" wait ${sender.source} ${sender.id}`
        : '對方的回覆會自動送回這個 session，不需要輪詢。'
      : '這則不要求回覆，對方不會回報；需要對方回答時請加上 expects_reply=true。';
    return `已送出 ${message.id} 給 ${nameOf(recipient)}。${delivery}${followUp}`;
  };

  const takeNew = async (address) => {
    const fresh = await mailbox.list(address, 'new');
    const taken = await moveAll(address, fresh, 'new', (message) => (wantsReply(message) ? 'active' : 'done'));
    return taken.map(renderMessage);
  };

  const onPromptSubmit = async ({ source, id, prompt }) => {
    const self = { source, id };
    const wanted = [...String(prompt ?? '').matchAll(MARKER)].map((match) => ({ id: match[1] }));
    await moveAll(self, wanted, 'new', () => 'active');
  };

  const onStop = async ({ source, id, lastMessage }) => {
    const self = { source, id };
    const closed = await moveAll(self, await mailbox.list(self, 'active'), 'active', () => 'done');
    const senders = closed
      .map((message) => message.from)
      .filter((from, index, all) => all.findIndex((other) => same(other, from)) === index);
    const text = truncate(lastMessage || NO_TEXT_REPLY, TEXT_MAX);
    const results = await Promise.allSettled(senders.map((to) => post({ from: self, to, text, auto: true })));
    results.filter((result) => result.status === 'rejected').forEach((result) => logError(result.reason));
  };

  return { send, post, takeNew, onPromptSubmit, onStop };
};
