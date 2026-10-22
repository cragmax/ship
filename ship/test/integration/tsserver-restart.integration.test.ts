/**
 * Real processes stand in for a Claude Code session: a `node` "session" whose children are an
 * idle process (the teardown's stand-in), a semantic `tsserver.js` and a `partialSemantic` one,
 * beside a `tsserver.js` outside the session. `sessionImage: 'node.exe'` names the stand-in.
 *
 * @integrationTier standalone
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPidAlive } from '../../../src/contracts/index.js';
import { restartSessionTsserver } from '../../src/cli/commands/tsserver-restart.js';

const WIN32 = process.platform === 'win32';
const TIMEOUT = { timeout: 30_000 };

const IDLE = 'setInterval(() => {}, 1000);';

// The session spawns its children and prints their pids as one JSON line.
const SESSION = `
import { spawn } from 'node:child_process';
const dir = process.argv[2];
const opts = { stdio: 'ignore' };
const run = (args) => spawn(process.execPath, args, opts).pid;
const pids = {
  teardown: run(['-e', ${JSON.stringify(IDLE)}]),
  semantic: run([dir + '/tsserver.js', '--useInferredProjectPerProjectRoot']),
  syntax: run([dir + '/tsserver.js', '--serverMode', 'partialSemantic']),
};
console.log(JSON.stringify(pids));
${IDLE}
`;

interface SessionPids {
  readonly teardown: number;
  readonly semantic: number;
  readonly syntax: number;
}

let dir: string;
const spawned: ChildProcess[] = [];
const pidsToKill: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ph-tsserver-'));
  writeFileSync(join(dir, 'tsserver.js'), IDLE);
  writeFileSync(join(dir, 'session.mjs'), SESSION);
});

afterEach(() => {
  for (const pid of pidsToKill.splice(0)) killQuietly(pid);
  for (const child of spawned.splice(0)) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

function killQuietly(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
}

function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error('the process did not start');
  return child.pid;
}

/** Start the stand-in session and read its children's pids. */
async function startSession(): Promise<{ session: number; pids: SessionPids }> {
  const child = spawn(process.execPath, [join(dir, 'session.mjs'), dir], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  spawned.push(child);
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const pids = JSON.parse(line) as SessionPids;
    pidsToKill.push(pids.teardown, pids.semantic, pids.syntax);
    lines.close();
    return { session: pidOf(child), pids };
  }
  throw new Error('the session printed no pids');
}

describe.skipIf(!WIN32)('restartSessionTsserver against real processes', () => {
  it('kills only the semantic tsserver under the nearest session ancestor', TIMEOUT, async () => {
    const outside = spawn(process.execPath, [join(dir, 'tsserver.js')], { stdio: 'ignore' });
    spawned.push(outside);
    const { session, pids } = await startSession();

    const record = restartSessionTsserver({
      disabled: false,
      selfPid: pids.teardown,
      sessionImage: 'node.exe',
    });

    expect(record).toEqual({ outcome: 'restarted', session, killed: [pids.semantic] });
    await expect.poll(() => isPidAlive(pids.semantic)).toBe(false);
    expect(isPidAlive(pids.syntax)).toBe(true);
    expect(isPidAlive(pidOf(outside))).toBe(true);
    expect(isPidAlive(session)).toBe(true);
  });
});
