/**
 * One RCON round trip that never throws — the readiness probe the tooling CLIs share.
 *
 * The rcon-client (4.2) behaviours it is built around ({@link AUTH_FAILED_MESSAGE} holds the
 * password-rejection one):
 * - After the TCP connect phase, rcon-client re-emits socket errors on the `Rcon` instance, and
 *   an `error` emit with no listener crashes the process (PF-83). A port that accepts and then
 *   resets lands in exactly that window, as docker-proxy does while the server behind it is not
 *   listening yet (unprobed), so the listener is attached before `connect()`: the crash becomes a
 *   failed probe. The pending packet promise still settles — the socket close rejects it, the
 *   packet timeout backstops it.
 * - A packet timeout, during the auth exchange or on the command, leaves the client's socket
 *   open, so a failed probe destroys it rather than leak it (PF-84).
 */

import { Rcon } from 'rcon-client';

/** Where to probe. */
export type RconProbeTarget = {
  /** RCON host. */
  readonly host: string;
  /** RCON port. */
  readonly port: number;
  /** RCON password. */
  readonly password: string;
};

/**
 * How far a failed probe got: `connect` — no authenticated session (refused,
 * reset, or the auth exchange failed); `auth` — the server answered and
 * rejected the password; `send` — authenticated, then the command or the close
 * failed, so the command may still have been delivered.
 */
type RconProbeStage = 'connect' | 'auth' | 'send';

/** A probe's outcome. */
export type RconProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly stage: RconProbeStage; readonly error: unknown };

/** rcon-client's rejection message when the server refuses the password. */
const AUTH_FAILED_MESSAGE = 'Authentication failed';

/**
 * Connect, authenticate, send one command and close. The command's response
 * body is ignored — the round trip itself is the signal.
 *
 * @returns Resolves to `ok`, or to how far the probe got and why it failed —
 *   the socket-level error when there was one, since the rejection is often a
 *   generic "Connection closed" derived from it.
 */
export async function probeRcon(
  target: RconProbeTarget,
  command: string,
): Promise<RconProbeResult> {
  const client = new Rcon({ host: target.host, port: target.port, password: target.password });
  let socketError: unknown;
  client.on('error', (error: unknown) => {
    socketError = error;
  });
  let stage: 'connect' | 'send' = 'connect';
  try {
    await client.connect();
    stage = 'send';
    await client.send(command);
    await client.end();
    return { ok: true };
  } catch (error) {
    client.socket?.destroy();
    const rejected = stage === 'connect' && isAuthFailure(error);
    return { ok: false, stage: rejected ? 'auth' : stage, error: socketError ?? error };
  }
}

/**
 * Whether a `connect()` rejection is the server refusing the password.
 *
 * @returns `true` for rcon-client's authentication failure.
 */
function isAuthFailure(error: unknown): boolean {
  return error instanceof Error && error.message === AUTH_FAILED_MESSAGE;
}
