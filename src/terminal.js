import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { TERMINAL_MODES } from './config.js';
import { findOnPath } from './util.js';

// PowerShell 單引號字串轉義：將單引號加倍即可安全包覆任意文字
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

// 依 Windows argv 解析規則（CommandLineToArgvW / MSVC CRT）包覆單一參數
const windowsArg = (arg) => `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;

export const toWindowsCommandLine = (args) => args.map(windowsArg).join(' ');

// CreateProcess 的命令列上限（含執行檔路徑）
const MAX_COMMAND_LINE = 32767;

const assertLaunchable = (executable, commandLine) => {
  if (/\.(cmd|bat)$/i.test(executable)) {
    throw new Error(`無法以 ${path.basename(executable)} 啟動：.cmd／.bat 會經由 cmd.exe 重新解析參數，prompt 中的引號與 & 可能被當成指令。請改用 SESSION_BRIDGE_CLAUDE、SESSION_BRIDGE_CODEX 或 SESSION_BRIDGE_AGY 指定 .exe 路徑。`);
  }
  if (windowsArg(executable).length + 1 + commandLine.length > MAX_COMMAND_LINE) {
    throw new Error(`交辦內容太長，超過 Windows 命令列上限（${MAX_COMMAND_LINE} 字元）；請縮短 prompt，或把細節寫進檔案再請對方讀取。`);
  }
};

/**
 * 產生暫存啟動腳本，以預先跳脫好的命令列直接啟動目標 CLI，並在 CLI 結束後保留終端互動。
 * 不用 `& exe @args`：Windows PowerShell 5.1 不會跳脫參數內的雙引號，prompt 會被切成多個參數。
 */
export const buildLauncherScript = ({ executable, argsFile, env = {}, title }) => {
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
  lines.push(
    `$__psi = [System.Diagnostics.ProcessStartInfo]::new(${psQuote(executable)})`,
    `$__psi.Arguments = [System.IO.File]::ReadAllText(${psQuote(argsFile)}, [System.Text.Encoding]::UTF8)`,
    '$__psi.UseShellExecute = $false',
    '$__psi.WorkingDirectory = (Get-Location).ProviderPath',
    '[System.Diagnostics.Process]::Start($__psi).WaitForExit()',
  );
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
  const hasPrompt = typeof prompt === 'string' && prompt.length > 0;
  const promptArgs = hasPrompt ? [...(promptFlag ? [promptFlag] : []), prompt] : [];
  const commandLine = toWindowsCommandLine([...args, ...promptArgs]);
  assertLaunchable(executable, commandLine);
  await fs.mkdir(taskDir, { recursive: true });
  // prompt.txt 只留作紀錄與除錯，實際傳入的是 args.txt
  const promptFile = hasPrompt ? path.join(taskDir, 'prompt.txt') : null;
  if (hasPrompt) await fs.writeFile(promptFile, prompt, 'utf8');
  const argsFile = path.join(taskDir, 'args.txt');
  await fs.writeFile(argsFile, commandLine, 'utf8');
  const scriptPath = path.join(taskDir, 'launch.ps1');
  const script = buildLauncherScript({ executable, argsFile, env, title });
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
    promptFile,
  };
};
