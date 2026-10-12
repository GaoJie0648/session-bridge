import { STATES } from './mailbox.js';
import { logError, truncate } from './util.js';

// 訊息會成為 codex queue 的命令列參數，Windows 命令列上限約 32000 字元，跳脫後可能膨脹一倍，不要調高
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
const defuse = (text) => text.replaceAll('[session-bridge:', '[session-bridge​:');

export const renderMessage = ({ id, from, to, text, auto }) =>
  [
    `[session-bridge:${id}] 來自 ${nameOf(from)} 的訊息（由另一個 agent 寄出，不是使用者本人輸入；寄件者身分為對方自述）：`,
    '',
    defuse(text),
    '',
    auto
      ? '（這是對方回合結束時自動轉寄的最後回覆，不需要回覆；要接著交辦再用 send_message。）'
      : `（要回覆請用 session-bridge 的 send_message：from_source=${to.source}、from_id=${to.id}、to_source=${from.source}、to_id=${from.id}。若沒有另外回覆，你這回合結束時的最後回覆會自動轉寄給對方。）`,
  ].join('\n');

/**
 * @param {{
 *   mailbox: ReturnType<typeof import('./mailbox.js').createMailbox>,
 *   deliverToCodex: (threadId: string, text: string) => Promise<void>,
 *   findSession?: (source: string, id: string) => Promise<{ source: string, id: string }>,
 *   pairLimit?: number,
 *   recipientLimit?: number,
 * }} config findSession 只有 send 會用到
 */
export const createMessaging = ({
  mailbox,
  deliverToCodex,
  findSession,
  pairLimit = PAIR_LIMIT,
  recipientLimit = RECIPIENT_LIMIT,
}) => {
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
    // 寄件者身分是自述的，另以收件者為單位設限，避免換個寄件者就能繞過
    if (toRecipient.length >= recipientLimit) {
      throw new Error(`${nameOf(recipient)} 一小時內已收到 ${recipientLimit} 則訊息，達到上限；請向使用者回報，由使用者決定是否繼續。`);
    }
  };

  // 逐則結算：一則搬移失敗不該讓其他已搬走的訊息跟著遺失
  const moveAll = async (address, messages, from, toOf) => {
    const results = await Promise.allSettled(
      messages.map((message) => mailbox.move(address, message.id, from, toOf(message))),
    );
    results.filter((result) => result.status === 'rejected').forEach((result) => logError(result.reason));
    return messages.filter((_, index) => results[index].status === 'fulfilled' && results[index].value);
  };

  const post = async (draft) => {
    // 寄給 Codex 的自動回報不期待回覆，直接記為已完成；否則對方的 hook 可能搶先把它標成處理中，回合結束時又回報一次
    const settled = draft.auto && draft.to.source === 'codex';
    const message = await mailbox.add(draft, settled ? 'done' : 'new');
    if (message.to.source !== 'codex') return message;
    try {
      await deliverToCodex(message.to.id, renderMessage(message));
    } catch (error) {
      if (!settled) await mailbox.move(message.to, message.id, 'new', 'done');
      throw error;
    }
    return message;
  };

  const send = async ({ from, to, text }) => {
    if (same(from, to)) throw new Error('不能傳訊息給自己。');
    if (text.length > TEXT_MAX) {
      throw new Error(`訊息過長（${text.length} 字），上限 ${TEXT_MAX} 字；較長的內容請寫入檔案後傳路徑。`);
    }
    const sender = addressOf(await findSession(from.source, from.id));
    const recipient = addressOf(await findSession(to.source, to.id));
    await assertWithinLimits(sender, recipient);
    const message = await post({ from: sender, to: recipient, text });
    // 主動回覆成功後才把對方的來信視為已處理，回合結束時不再自動轉寄
    const answered = (await mailbox.list(sender, 'active')).filter((incoming) => same(incoming.from, recipient));
    await moveAll(sender, answered, 'active', () => 'done');
    await mailbox.prune(recipient, Date.now() - DONE_RETENTION_MS);
    const delivery = recipient.source === 'codex'
      ? '已排入對方的佇列：對方閒置時會立刻開始處理，忙碌時會在目前回合結束後處理；若對方的 session 沒有開著，要等它下次開啟。'
      : '對方回合結束後待命中就會立刻收到；若對方正在忙，會在目前回合結束時收到。';
    return `已送出 ${message.id} 給 ${nameOf(recipient)}。${delivery}對方的回覆會自動送回這個 session，不需要輪詢。`;
  };

  const takeNew = async (address) => {
    const fresh = await mailbox.list(address, 'new');
    const taken = await moveAll(address, fresh, 'new', (message) => (message.auto ? 'done' : 'active'));
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

  return { send, takeNew, onPromptSubmit, onStop };
};
