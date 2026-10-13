// Explicit, opt-in live check. Uses the user's CLI authentication and a tiny
// model request per provider; never included in npm test.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodex } from '../src/codex-agent.js';
import { runClaude } from '../src/claude-agent.js';

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'session-bridge-live-'));
try {
  for (const [provider, run] of Object.entries({ codex: runCodex, claude: runClaude })) {
    const task = { provider, cwd, sessions: {} };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const result = await run(task, {
        prompt: 'Reply with exactly BRIDGE_OK. Do not use any tools, read or write files, or run commands.',
        signal: controller.signal,
        approve: async () => ({ decision: 'deny' }), invalidate: async () => {},
        event: async (event) => {
          if (event.type === 'session') task.sessions[provider] = event.id;
          if (event.type === 'session' || event.type === 'quota') process.stdout.write(`${provider}: ${event.type} received\n`);
        },
      });
      process.stdout.write(`${provider}: ${JSON.stringify(result)}\n`);
      if (result.status !== 'completed' || !result.output.includes('BRIDGE_OK')) process.exitCode = 1;
    } catch (error) { process.stdout.write(`${provider}: ${error.message}\n`); process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
} finally { await fs.rm(cwd, { recursive: true, force: true }); }
