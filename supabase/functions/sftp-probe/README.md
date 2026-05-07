# sftp-probe (THROWAWAY)

**This function is throwaway**. It exists only to validate the 6 LedsC4 SFTP secrets and the host key fingerprint before building anything I4 on top.

## What it does

1. Loads `LEDSC4_SFTP_HOST/PORT/USER/PASSWORD/BASE_PATH/HOST_KEY` from `Deno.env`. Reports missing secret NAMES (never values).
2. Parses `LEDSC4_SFTP_HOST_KEY` as a known_hosts line (`host type base64`) and decodes the base64 blob to a Buffer.
3. Connects via `npm:ssh2-sftp-client` (which wraps `npm:ssh2`), passing a `hostVerifier` that does a byte-by-byte comparison against the parsed Buffer. If it doesn't match, the handshake aborts before authentication is sent.
4. Lists `BASE_PATH` (first level only). Flags subdirectories if any are unexpectedly present.
5. Returns JSON: `{ status, host_key_match, listing, error_message, error_stage, elapsed_ms }`. Listing truncated to 50 entries.

## Lifecycle

- Lives on branch `claude/scratch-sftp-probe`.
- Once the secrets are confirmed working (and we have the listing of files we expect from the client), this function is to be **deleted** before merging anything I4-related to `main`.
- The `[functions.sftp-probe]` block in `supabase/config.toml` should also go.

## Restrictions

- Zero downloads, zero writes — only `list()`.
- Zero secrets logged. Stage names and byte counts only.
- Listing capped at 50 entries.
