import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { defaultHome } from './config.js';
import { SAFE_SESSION_ID, parseJson } from './util.js';

export const STATES = ['new', 'active', 'done'];
const PROVIDER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MESSAGE_ID = /^\d+-[0-9a-f]{8}$/;

export const defaultMailboxRoot = defaultHome;

// 位址會組成目錄名稱，必須先擋掉不合法的 source 或 session id
const boxName = ({ source, id }) => {
  if (!PROVIDER_NAME.test(String(source ?? '')) || !SAFE_SESSION_ID.test(String(id ?? ''))) {
    throw new Error(`不是有效的 session 位址：${source} ${id}`);
  }
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
export const createMailbox = (root = defaultMailboxRoot()) => {
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

  const add = async ({ from, to, text, auto = false, expectsReply = !auto, fromCwd }, state = 'new') => {
    const now = Date.now();
    const id = `${now}-${randomUUID().slice(0, 8)}`;
    const message = {
      id,
      from,
      to,
      text,
      auto,
      expectsReply,
      ...(fromCwd ? { fromCwd } : {}),
      sentAt: new Date(now).toISOString(),
    };
    const dir = stateDir(to, state);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, fileName(message.id));
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

  return { root, list, add, move, prune, claimWaiter, waiterToken };
};
