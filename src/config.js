import os from 'node:os';
import path from 'node:path';

import { atomicJson, readJsonOr } from './util.js';

export const TERMINAL_MODES = ['tab', 'split', 'window'];
export const EXECUTION_MODES = ['managed', 'terminal'];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const defaultHome = () => process.env.SESSION_BRIDGE_HOME ?? path.join(os.homedir(), '.session-bridge');

export const DEFAULT_CONFIG = {
  terminal: {
    mode: 'tab',
    splitDirection: 'auto',
  },
  defaults: {
    claude: { model: null, effort: null },
    codex: { model: null, effort: null },
    agy: { model: null, effort: null },
  },
  retention: {
    tasksDays: 14,
    doneMessagesDays: 7,
  },
};

const mergeConfig = (raw) => {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    terminal: {
      ...DEFAULT_CONFIG.terminal,
      ...(input.terminal && typeof input.terminal === 'object' ? input.terminal : {}),
    },
    defaults: {
      claude: { ...DEFAULT_CONFIG.defaults.claude, ...(input.defaults?.claude ?? {}) },
      codex: { ...DEFAULT_CONFIG.defaults.codex, ...(input.defaults?.codex ?? {}) },
      agy: { ...DEFAULT_CONFIG.defaults.agy, ...(input.defaults?.agy ?? {}) },
      ...(input.defaults ?? {}),
    },
    retention: {
      ...DEFAULT_CONFIG.retention,
      ...(input.retention && typeof input.retention === 'object' ? input.retention : {}),
    },
  };
};

export const configPath = (home = defaultHome()) => path.join(home, 'config.json');

export const loadConfig = async (home = defaultHome()) => {
  const raw = await readJsonOr(configPath(home), null);
  return mergeConfig(raw);
};

export const saveConfig = async (config, home = defaultHome()) => {
  const merged = mergeConfig(config);
  await atomicJson(configPath(home), merged);
  return merged;
};

/** 合併呼叫端參數與設定檔預設值 */
export const resolveProviderOptions = (config, provider, overrides = {}) => {
  const preset = config?.defaults?.[provider] ?? {};
  const model = overrides.model ?? preset.model ?? undefined;
  const effort = overrides.effort ?? preset.effort ?? undefined;
  if (effort && !EFFORT_LEVELS.includes(effort)) {
    throw new Error(`無效的 effort：${effort}（可用值：${EFFORT_LEVELS.join('、')}）`);
  }
  return {
    model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
    effort,
  };
};
