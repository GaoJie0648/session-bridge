import { SAFE_SESSION_ID } from '../util.js';
import { createAgyProvider } from './agy.js';
import { createClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';

/**
 * 建立可擴充的 Provider 註冊表
 * @param {Array<object>} providers
 */
export const createRegistry = (providers) => {
  const map = new Map(providers.map((provider) => [provider.name, provider]));
  const names = [...map.keys()];

  const get = (name) => {
    const provider = map.get(name);
    if (!provider) throw new Error(`不支援的 provider：${name}（可用：${names.join('、')}）`);
    return provider;
  };

  const has = (name) => map.has(name);
  const all = () => [...map.values()];

  const isValidSessionId = (source, id) => {
    if (typeof id !== 'string' || !id) return false;
    const provider = map.get(source);
    if (!provider) return false;
    return (provider.idPattern ?? SAFE_SESSION_ID).test(id);
  };

  return { names, get, has, all, isValidSessionId };
};

/** 預設內建三方 Provider（Claude Code、Codex CLI、Antigravity CLI） */
export const createDefaultRegistry = ({
  codexRoot,
  claudeRoot,
  agyRoot,
  home,
  deliverToCodex,
  env = process.env,
  platform = process.platform,
} = {}) =>
  createRegistry([
    createCodexProvider({ root: codexRoot, deliver: deliverToCodex, env, platform }),
    createClaudeProvider({ root: claudeRoot, env, platform }),
    createAgyProvider({ root: agyRoot, home, env, platform }),
  ]);
