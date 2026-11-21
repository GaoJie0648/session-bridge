import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { buildLauncherScript, launchInTerminal, toWindowsCommandLine } from '../src/terminal.js';

const isWindows = process.platform === 'win32';
const TRICKY = [
  '',
  'plain',
  '例如 "the character in image 1 in the pose of image 2"。',
  'line1\nline2\r\n"quoted" end',
  'trailing backslash C:\\dir\\',
  'escaped \\"quote\\" and \\\\"double\\\\"',
  '%PATH% $env:PATH `tick` ^caret & | <>',
];

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-bridge-term-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const writeEcho = async () => {
  const echo = path.join(dir, 'echo.js');
  const out = path.join(dir, 'argv.json');
  await fs.writeFile(echo, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`);
  return { echo, out };
};

describe('windows command line quoting', () => {
  test('every argument survives the Windows argv parser unchanged', { skip: !isWindows }, async () => {
    const { echo, out } = await writeEcho();
    // verbatim 模式下 Node 不會替程式路徑加引號，改從 node.exe 所在目錄以檔名啟動
    const result = spawnSync(path.basename(process.execPath), [toWindowsCommandLine([echo, ...TRICKY])], {
      cwd: path.dirname(process.execPath), windowsVerbatimArguments: true,
    });
    assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), TRICKY);
  });

  test('quotes every argument and doubles backslashes only before quotes', () => {
    assert.equal(toWindowsCommandLine(['a b', 'C:\\x\\', 'say "hi"']), '"a b" "C:\\x\\\\" "say \\"hi\\""');
  });
});

describe('launcher script', () => {
  test('starts the CLI with a prebuilt command line instead of PowerShell argument passing', () => {
    const script = buildLauncherScript({
      executable: 'C:\\agy\\agy.exe',
      argsFile: 'C:\\tmp\\args.txt',
      env: { SESSION_BRIDGE_TASK_ID: 'task-1' },
      title: "bridge:agy 'quoted'",
    });

    assert.match(script, /\$env:SESSION_BRIDGE_TASK_ID = 'task-1'/);
    assert.match(script, /ProcessStartInfo\]::new\('C:\\agy\\agy\.exe'\)/);
    assert.match(script, /ReadAllText\('C:\\tmp\\args\.txt'/);
    assert.match(script, /'bridge:agy ''quoted'''/);
    assert.doesNotMatch(script, /@__args/);
  });

  const fakeSpawn = (onSpawn = () => {}) => (command, args) => {
    onSpawn(args);
    return { once: (event, fn) => event === 'spawn' && fn(), unref: () => {}, pid: 1 };
  };
  const launch = (overrides) => launchInTerminal({
    taskDir: dir, cwd: dir, title: 't', executable: process.execPath, args: [],
    mode: 'tab', wtPath: null, platform: 'win32', spawnFn: fakeSpawn(), ...overrides,
  });

  test('refuses batch files, whose arguments cmd.exe would re-parse', async () => {
    for (const executable of ['C:\\npm\\claude.cmd', 'C:\\x\\agy.BAT']) {
      await assert.rejects(launch({ executable, prompt: 'p' }), /\.cmd.*\.bat|SESSION_BRIDGE_/);
    }
  });

  test('fails clearly when the prompt exceeds the Windows command-line limit', async () => {
    await assert.rejects(launch({ prompt: 'x'.repeat(33000) }), /命令列.*上限/);
  });

  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    test(`${shell} passes a prompt with quotes and newlines as one argument`, { skip: !isWindows }, async (t) => {
      const { echo, out } = await writeEcho();
      const prompt = TRICKY.join(' ');
      let spawned;
      await launch({ args: [echo, '--model', 'm'], prompt, promptFlag: '-i', spawnFn: fakeSpawn((args) => { spawned = args; }) });
      const scriptPath = spawned.at(-1);
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { cwd: dir });
      if (result.error?.code === 'ENOENT') {
        t.skip(`${shell} 未安裝`);
        return;
      }
      assert.equal(result.status, 0, String(result.stderr));
      assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), ['--model', 'm', '-i', prompt]);
    });
  }
});
