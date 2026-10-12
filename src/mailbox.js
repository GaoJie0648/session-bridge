import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SESSION_ID, parseJson } from './util.js';

export const SOURCES = ['codex', 'claude'];
export const STATES = ['new', 'active', 'done'];

const MESSAGE_ID = /^\d+-[0-9a-f]{8}$/;

export const defaultMailboxRoot = () => process.env.SESSION_BRIDGE_HOME ?? path.join(os.homedir(), '.session-bridge');

// 位址會組成目錄名稱，必須先擋掉不是 session id 的輸入
const boxName = ({ source, id }) => {
  if (!SOURCES.includes(source) || !SESSION_ID.test(id)) throw new Error(`不是有效的 session 位址：${source} ${id}`);
  return `${source}-${id.toLowerCase()}`;
};

const fileName = (messageId) => {
  if (!MESSAGE_ID.test(messageId)) throw new Error(`不是有效的訊息 id：${messageId}`);
  return `${messageId}.json`;
};

const ifMissing = (fallback) => (error) => {
  if (error.code === 'ENOENT') return fallback;
  throw error;
};

const sentAtOf = (name) => Number(name.split('-')[0]);

/**
 * 每個 session 一個信箱目錄，訊息依狀態放在 new / active / done 子目錄，以改名搬移確保只被取走一次
 * @param {string} root
 */
export const createMailbox = (root) => {
  const boxDir = (address) => path.join(root, boxName(address));
  const stateDir = (address, state) => path.join(boxDir(address), state);
  const waiterFile = (address) => path.join(boxDir(address), 'waiter');

  const namesIn = async (dir) => (await fs.readdir(dir).catch(ifMissing([]))).filter((name) => name.endsWith('.json'));

  const list = async (address, state, since = 0) => {
    const dir = stateDir(address, state);
    const wanted = (await namesIn(dir)).filter((name) => sentAtOf(name) >= since).toSorted();
    const contents = await Promise.all(wanted.map((name) => fs.readFile(path.join(dir, name), 'utf8').catch(ifMissing(''))));
    return contents.map(parseJson).filter(Boolean);
  };

  const add = async ({ from, to, text, auto = false }, state = 'new') => {
    const now = Date.now();
    const message = { id: `${now}-${randomUUID().slice(0, 8)}`, from, to, text, auto, sentAt: new Date(now).toISOString() };
    const dir = stateDir(to, state);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, fileName(message.id));
    // 先寫暫存檔再改名，讀取端不會看到寫到一半的訊息
    await fs.writeFile(`${file}.tmp`, JSON.stringify(message));
    await fs.rename(`${file}.tmp`, file);
    return message;
  };

  /** @returns {Promise<boolean>} 訊息已被別人搬走時回傳 false */
  const move = async (address, messageId, from, to) => {
    await fs.mkdir(stateDir(address, to), { recursive: true });
    const name = fileName(messageId);
    return fs
      .rename(path.join(stateDir(address, from), name), path.join(stateDir(address, to), name))
      .then(() => true, ifMissing(false));
  };

  /** 刪除早於 before（毫秒時間戳）的已完成訊息 */
  const prune = async (address, before) => {
    const dir = stateDir(address, 'done');
    const expired = (await namesIn(dir)).filter((name) => sentAtOf(name) < before);
    await Promise.all(expired.map((name) => fs.unlink(path.join(dir, name)).catch(ifMissing(undefined))));
  };

  const claimWaiter = async (address) => {
    const token = randomUUID();
    await fs.mkdir(boxDir(address), { recursive: true });
    await fs.writeFile(waiterFile(address), token);
    return token;
  };

  const waiterToken = (address) => fs.readFile(waiterFile(address), 'utf8').catch(ifMissing(''));

  return { list, add, move, prune, claimWaiter, waiterToken };
};
