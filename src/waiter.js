/**
 * 等到信箱有新訊息才回傳；被較新的 waiter 取代、啟動它的 session 已結束、或輪詢次數用完時回傳空陣列
 * @param {{
 *   messaging: { takeNew: (address: object) => Promise<string[]> },
 *   mailbox: ReturnType<typeof import('./mailbox.js').createMailbox>,
 *   address: { source: string, id: string },
 *   takeMore?: () => Promise<string[]>,
 *   isAbandoned: () => boolean,
 *   sleep: () => Promise<void>,
 *   maxPolls: number,
 * }} options
 */
export const waitForMessages = async ({ messaging, mailbox, address, takeMore, isAbandoned, sleep, maxPolls }) => {
  const token = await mailbox.claimWaiter(address);
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (isAbandoned() || (await mailbox.waiterToken(address)) !== token) return [];
    const messages = await messaging.takeNew(address);
    if (takeMore) messages.push(...await takeMore());
    if (messages.length > 0) return messages;
    await sleep();
  }
  return [];
};
