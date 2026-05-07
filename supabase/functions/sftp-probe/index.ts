// Supabase Edge Function: sftp-probe (THROWAWAY)
//
// Validates the 6 LedsC4 SFTP secrets and the host key fingerprint
// before building anything I4 on top. Lists the BASE_PATH once and
// reports back. NO downloads. NO writes. NO secrets logged.
//
// Lifecycle: this function is intended to be deleted (or moved to a
// scratch branch) once the secrets are confirmed working. See
// supabase/functions/sftp-probe/README.md.
//
// Library choice: `npm:ssh2-sftp-client` wraps `npm:ssh2`. We use the
// wrapper for its high-level `list()` API but pass `hostVerifier`
// straight through to the underlying ssh2 client config — that's where
// the byte-by-byte host key comparison happens.
//
// Host key parsing:
//   The LEDSC4_SFTP_HOST_KEY secret is in standard known_hosts format:
//     "<host> <type> <base64-blob>"
//   ssh2's hostVerifier callback receives the host's public key as a
//   Buffer in raw SSH wire format — which is exactly what's
//   base64-encoded in field 3 of known_hosts. So we split on whitespace,
//   take the third field, and decode it to a Buffer for comparison.
//
// Output JSON shape:
//   { status, host_key_match, listing, error_message, error_stage,
//     elapsed_ms }
// where listing is truncated at 50 entries.

// @ts-nocheck — Deno + npm: compat doesn't ship with full TS types here.
import SftpClient from 'npm:ssh2-sftp-client@10.0.3';
import { Buffer } from 'node:buffer';

const REQUIRED_SECRETS = [
  'LEDSC4_SFTP_HOST',
  'LEDSC4_SFTP_PORT',
  'LEDSC4_SFTP_USER',
  'LEDSC4_SFTP_PASSWORD',
  'LEDSC4_SFTP_BASE_PATH',
  'LEDSC4_SFTP_HOST_KEY',
] as const;

const LIST_LIMIT = 50;
const CONNECT_TIMEOUT_MS = 10_000;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Parse "host <type> <base64>" → Buffer of the wire-format public key.
function parseKnownHostsLine(line: string): { type: string; key: Buffer } {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) {
    throw new Error(
      `LEDSC4_SFTP_HOST_KEY does not look like a known_hosts line ` +
        `(expected "host type base64", got ${parts.length} fields)`,
    );
  }
  const type = parts[1];
  const blob = parts[2];
  const key = Buffer.from(blob, 'base64');
  if (key.length === 0) throw new Error('LEDSC4_SFTP_HOST_KEY base64 blob is empty');
  return { type, key };
}

Deno.serve(async (_req: Request) => {
  const t0 = Date.now();
  const result: Record<string, unknown> = {
    status: 'error',
    host_key_match: null as boolean | null,
    listing: null as unknown,
    error_message: null as string | null,
    error_stage: 'unknown',
    elapsed_ms: 0,
  };

  // 1. Load secrets. If any missing, fail loudly with the NAME (never value).
  const missing: string[] = [];
  const secrets: Record<string, string> = {};
  for (const name of REQUIRED_SECRETS) {
    const v = Deno.env.get(name);
    if (!v) missing.push(name);
    else secrets[name] = v;
  }
  if (missing.length > 0) {
    result.error_stage = 'secret_load';
    result.error_message = `Missing secrets: ${missing.join(', ')}`;
    result.elapsed_ms = Date.now() - t0;
    return jsonResponse(result, 500);
  }

  // 2. Parse known_hosts line.
  let expectedKey: Buffer;
  try {
    const parsed = parseKnownHostsLine(secrets.LEDSC4_SFTP_HOST_KEY);
    expectedKey = parsed.key;
    console.log(`[sftp-probe] expected host key parsed: type=${parsed.type} bytes=${parsed.key.length}`);
  } catch (err) {
    result.error_stage = 'secret_load';
    result.error_message = `Failed to parse LEDSC4_SFTP_HOST_KEY: ${(err as Error).message}`;
    result.elapsed_ms = Date.now() - t0;
    return jsonResponse(result, 500);
  }

  // 3. Connect with hostVerifier doing byte-by-byte comparison.
  const sftp = new SftpClient('sftp-probe');
  let hostKeyVerified = false;
  let stage: string = 'connect';

  try {
    await sftp.connect({
      host: secrets.LEDSC4_SFTP_HOST,
      port: Number(secrets.LEDSC4_SFTP_PORT),
      username: secrets.LEDSC4_SFTP_USER,
      password: secrets.LEDSC4_SFTP_PASSWORD,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // ssh2 calls this with the host's public key as Buffer (wire format).
      // Returning false aborts the handshake before authentication is sent
      // — passwords never leave us if the key doesn't match.
      hostVerifier: (key: Buffer) => {
        // Byte-by-byte comparison against the parsed known_hosts blob.
        const match =
          key.length === expectedKey.length &&
          key.equals(expectedKey);
        hostKeyVerified = match;
        if (!match) {
          console.error(
            `[sftp-probe] HOST KEY MISMATCH: presented bytes=${key.length}, expected bytes=${expectedKey.length}`,
          );
        }
        return match;
      },
    });

    result.host_key_match = hostKeyVerified;
    stage = 'list';

    // 4. List BASE_PATH (first level only — flag subdirectories if any).
    const entries = await sftp.list(secrets.LEDSC4_SFTP_BASE_PATH);
    const subdirs = entries.filter((e: any) => e.type === 'd').map((e: any) => e.name);
    if (subdirs.length > 0) {
      console.log(`[sftp-probe] WARN: BASE_PATH contains subdirectories (not expected): ${subdirs.join(', ')}`);
    }
    const truncated = entries.length > LIST_LIMIT;
    const limited = entries.slice(0, LIST_LIMIT).map((e: any) => ({
      name: e.name,
      type: e.type, // '-' file, 'd' dir, 'l' symlink
      size: e.size,
      modifyTime: e.modifyTime, // ms epoch
    }));

    result.status = 'ok';
    result.listing = {
      total_entries: entries.length,
      truncated,
      shown: limited.length,
      subdirectories_present: subdirs.length > 0 ? subdirs : null,
      entries: limited,
    };
    result.error_stage = null;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Heuristic stage detection — ssh2 wraps everything as Error.
    if (!hostKeyVerified && /host(key)? verification|host\s*key/i.test(msg)) {
      result.error_stage = 'host_key';
      result.host_key_match = false;
    } else if (/auth|password|permission denied/i.test(msg)) {
      result.error_stage = 'auth';
    } else if (stage === 'list') {
      result.error_stage = 'list';
    } else {
      result.error_stage = stage; // 'connect' or 'list'
    }
    result.error_message = msg;
  } finally {
    try {
      await sftp.end();
    } catch (_e) {
      // Ignore close errors — already in error path.
    }
    result.elapsed_ms = Date.now() - t0;
  }

  return jsonResponse(result, result.status === 'ok' ? 200 : 502);
});
