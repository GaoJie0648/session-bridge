import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { createTaskStore, alive } from '../src/task-store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const toolsUrl = new URL('../src/tasks.js', import.meta.url).href;
const storeUrl = new URL('../src/task-store.js', import.meta.url).href;
const controlFile = fileURLToPath(new URL('../src/control.js', import.meta.url));
const serverFile = fileURLToPath(new URL('../src/server.js', import.meta.url));
const until = async (read, check) => {
  for (let n = 0; n < 200; n += 1) { const value = await read(); if (check(value)) return value; await sleep(100); }
  throw new Error('worker condition timed out');
};

// Fake provider protocols exercise real child processes, SDK transport, locks,
// detached lifetime and the CLI without spending model quota.
const fakeCodex = `
const readline = require('node:readline');
const emit = m => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') emit({id:m.id,result:{}});
  if (m.method === 'thread/start' || m.method === 'thread/resume') emit({id:m.id,result:{thread:{id:'11111111-1111-4111-8111-111111111111'}}});
  if (m.method === 'account/rateLimits/read') emit({id:m.id,result:{}});
  if (m.method === 'turn/start') {
    emit({id:m.id,result:{turn:{id:'turn-1'}}});
    emit({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'11111111-1111-4111-8111-111111111111',command:'echo test'}});
  }
  if (m.id === 'approval' && m.result) {
    emit({method:'item/completed',params:{item:{type:'agentMessage',text:'BRIDGE_DONE'}}});
    emit({method:'turn/completed',params:{turn:{status:'completed'}}});
  }
});
`;
const fakeClaude = `
const readline = require('node:readline');
const emit = m => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') emit({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});
  if (m.type === 'user') {
    emit({type:'system',subtype:'init',session_id:'22222222-2222-4222-8222-222222222222'});
    emit({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo test'},tool_use_id:'tool-1'}});
  }
  if (m.type === 'control_response' && m.response.request_id === 'approval') {
    emit({type:'result',subtype:'success',is_error:false,result:'BRIDGE_DONE',session_id:'22222222-2222-4222-8222-222222222222'});
  }
});
`;

test('MCP publishes task tools but no approval mutation tools, and blocks recursive background starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-mcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverFile],
    env: { ...process.env, SESSION_BRIDGE_HOME: root, SESSION_BRIDGE_MANAGED: '1' }, stderr: 'pipe' });
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['start_task', 'get_task', 'list_tasks', 'resume_task', 'cancel_task', 'send_message']) {
      assert.ok(tools.some((tool) => tool.name === name));
    }
    assert.ok(tools.every((tool) => !/approve|automode/.test(tool.name)));
    const result = await client.callTool({ name: 'list_tasks', arguments: { all: true } });
    assert.deepEqual(JSON.parse(result.content[0].text), []);
    const recursive = await client.callTool({ name: 'start_task', arguments: { provider: 'claude', cwd: root, prompt: 'test' } });
    assert.equal(recursive.isError, true);
    assert.match(recursive.content[0].text, /不能再啟動/);
  } finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
});

for (const provider of ['codex', 'claude']) {
  test(`${provider}: survives launcher exit and accepts automode from a separate control process`, { timeout: 30000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-worker-'));
    const store = createTaskStore(root);
    const fake = path.join(root, 'provider.js');
    await fs.writeFile(fake, provider === 'codex' ? fakeCodex : fakeClaude);
    const env = { ...process.env, SESSION_BRIDGE_HOME: root,
      [provider === 'codex' ? 'SESSION_BRIDGE_CODEX' : 'SESSION_BRIDGE_CLAUDE']: fake };
    delete env.SESSION_BRIDGE_MANAGED;
    let id;
    try {
      const launcher = `import {createTaskTools} from ${JSON.stringify(toolsUrl)};
        import {createTaskStore} from ${JSON.stringify(storeUrl)};
        const tools = createTaskTools({store:createTaskStore(process.env.SESSION_BRIDGE_HOME)});
        const task = await tools.start({provider:${JSON.stringify(provider)},cwd:process.env.SESSION_BRIDGE_HOME,prompt:'test'});
        console.log(task.id);`;
      const started = await exec(process.execPath, ['--input-type=module', '-e', launcher], { env, windowsHide: true, timeout: 10000 });
      id = started.stdout.trim();
      const waiting = await until(() => store.read(id), (task) => task.status === 'waiting_approval' || task.status === 'failed');
      assert.equal(waiting.status, 'waiting_approval', JSON.stringify(waiting.error));
      assert.equal(alive(waiting.pid), true);
      const auto = await exec(process.execPath, [controlFile, 'auto', id, 'on', '--minutes', '1'], { env, windowsHide: true, timeout: 15000 });
      assert.equal(JSON.parse(auto.stdout).id, id);
      const completed = await until(() => store.read(id), (task) => task.status === 'completed' && !task.pid);
      assert.equal(completed.output, 'BRIDGE_DONE');
      assert.equal(completed.approvals[0].actor, 'automode');
      assert.equal(completed.automode, null);
    } finally {
      if (id) {
        const task = await store.read(id);
        if (alive(task.pid)) {
          await exec(process.execPath, [controlFile, 'cancel', id], { env, windowsHide: true, timeout: 15000 }).catch(() => {});
          await until(() => store.read(id), (current) => !alive(current.pid));
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
