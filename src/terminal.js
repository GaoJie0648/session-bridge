import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { TERMINAL_MODES } from './config.js';
import { findOnPath } from './util.js';

// PowerShell 單引號字串轉義：將單引號加倍即可安全包覆任意文字
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * 產生暫存啟動腳本，由檔案讀入 prompt 再以原生參數啟動目標 CLI，
 * 避免 Windows 命令列長度上限與多層引號跳脫問題，並在 CLI 結束後保留終端互動。
 */
export const buildLauncherScript = ({ executable, args, promptFile, promptFlag, env = {}, title }) => {
  const lines = [
    '$ErrorActionPreference = "Continue"',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  ];
  if (title) lines.push(`$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    lines.push(`$env:${key} = ${psQuote(value)}`);
  }
  lines.push(`$__args = @(${args.map(psQuote).join(', ')})`);
  if (promptFile) {
    lines.push(`$__prompt = [System.IO.File]::ReadAllText(${psQuote(promptFile)}, [System.Text.Encoding]::UTF8)`);
    if (promptFlag) lines.push(`$__args += ${psQuote(promptFlag)}`);
    lines.push('$__args += $__prompt');
  }
  lines.push(`& ${psQuote(executable)} @__args`);
  return `${lines.join('\r\n')}\r\n`;
};

const resolveShell = (env, platform) => {
  if (platform !== 'win32') return process.env.SHELL || 'sh';
  return findOnPath(['pwsh.exe', 'powershell.exe'], env, platform) ?? 'powershell.exe';
};

export const detectWindowsTerminal = (env = process.env, platform = process.platform) => {
  if (platform !== 'win32') return null;
  const fromPath = findOnPath(['wt.exe'], env, platform);
  if (fromPath) return fromPath;
  const localAppData = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const candidate = path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
  try {
    fsSync.lstatSync(candidate);
    return candidate;
  } catch {
    return null;
  }
};

/** 組合終端啟動指令與參數（方便測試與除錯） */
export const buildTerminalCommand = ({
  scriptPath,
  cwd,
  title,
  mode = 'tab',
  splitDirection = 'auto',
  wtPath,
  shellPath,
  platform = process.platform,
}) => {
  if (!TERMINAL_MODES.includes(mode)) throw new Error(`無效的 terminal mode：${mode}`);
  const shell = shellPath ?? resolveShell(process.env, platform);
  const shellArgs = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];

  if (platform === 'win32' && wtPath) {
    if (mode === 'window') {
      return {
        command: wtPath,
        args: ['new-tab', '--title', title, '-d', cwd, shell, ...shellArgs],
        launcher: 'wt:window',
      };
    }
    if (mode === 'split') {
      const dirFlag = splitDirection === 'horizontal' ? ['-H'] : splitDirection === 'vertical' ? ['-V'] : [];
      return {
        command: wtPath,
        args: ['-w', '0', 'split-pane', ...dirFlag, '--title', title, '-d', cwd, shell, ...shellArgs],
        launcher: 'wt:split',
      };
    }
    return {
      command: wtPath,
      args: ['-w', '0', 'new-tab', '--title', title, '-d', cwd, shell, ...shellArgs],
      launcher: 'wt:tab',
    };
  }

  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', 'start', title || 'session-bridge', '/D', cwd, shell, ...shellArgs],
      launcher: 'cmd:start',
    };
  }

  // 非 Windows 平台 fallback（以一般 detached 子行程啟動）
  return {
    command: shell,
    args: [scriptPath],
    launcher: 'posix:shell',
  };
};

/**
 * 寫出啟動腳本並開啟獨立可見的終端畫面
 */
export const launchInTerminal = async ({
  taskDir,
  cwd,
  title,
  executable,
  args = [],
  prompt,
  promptFlag,
  env = {},
  mode = 'tab',
  splitDirection = 'auto',
  spawnFn = spawn,
  wtPath = detectWindowsTerminal(),
  shellPath,
  platform = process.platform,
}) => {
  await fs.mkdir(taskDir, { recursive: true });
  let promptFile;
  if (typeof prompt === 'string' && prompt.length > 0) {
    promptFile = path.join(taskDir, 'prompt.txt');
    await fs.writeFile(promptFile, prompt, 'utf8');
  }
  const scriptPath = path.join(taskDir, 'launch.ps1');
  const script = buildLauncherScript({ executable, args, promptFile, promptFlag, env, title });
  await fs.writeFile(scriptPath, `\uFEFF${script}`, 'utf8');

  const spec = buildTerminalCommand({ scriptPath, cwd, title, mode, splitDirection, wtPath, shellPath, platform });
  const child = spawnFn(spec.command, spec.args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return {
    launcher: spec.launcher,
    pid: child.pid ?? null,
    scriptPath,
    promptFile: promptFile ?? null,
  };
};
