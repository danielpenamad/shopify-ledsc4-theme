// Supabase Edge Function: csv-grep
//
// Utilidad operativa: dado un CSV en el bucket privado `ledsc4-imports`,
// devuelve las líneas que matchean un `needle`. Pensada para investigar
// preguntas tipo "¿está el SKU X en el feed del proveedor?" sin tener que
// bajar 1.2 MB de CSV a mano cada vez.
//
// Auth: verify_jwt=true (mismo patrón que sftp-sync) — solo invocable
// con anon/service-role key. El acceso al bucket privado lo hace el
// runtime con SUPABASE_SERVICE_ROLE_KEY auto-inyectado.
//
// Payload:
//   {
//     "run_id": "uuid",        // requerido si no se pasa "path"
//     "path":   "subpath/.csv", // opcional, prevalece sobre run_id
//                              // por defecto: runs/<run_id>/productos/listado_productos_ES.csv
//     "needle": "texto",       // requerido
//     "case_insensitive": true, // default true
//     "max_lines": 50          // default 50, máx 500
//   }
//
// Respuesta:
//   {
//     "path": "runs/.../listado_productos_ES.csv",
//     "needle": "...",
//     "total_lines": 2681,
//     "matched": 3,
//     "truncated": false,
//     "lines": [{ "line_no": 142, "text": "..." }, ...]
//   }

// @ts-nocheck
import { createClient } from 'jsr:@supabase/supabase-js@2';

const STORAGE_BUCKET = 'ledsc4-imports';
const MAX_LINES_HARD = 500;
const MAX_LINES_DEFAULT = 50;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid json body' }, 400);
  }

  const needle = typeof payload.needle === 'string' ? payload.needle : null;
  if (!needle || needle.length === 0) {
    return jsonResponse({ error: 'needle is required (non-empty string)' }, 400);
  }
  if (needle.length > 200) {
    return jsonResponse({ error: 'needle too long (max 200 chars)' }, 400);
  }

  // Resolver path: explícito > construido desde run_id + locale por defecto.
  let path = typeof payload.path === 'string' ? payload.path : null;
  if (!path) {
    const runId = typeof payload.run_id === 'string' ? payload.run_id : null;
    if (!runId) return jsonResponse({ error: 'either path or run_id is required' }, 400);
    path = `runs/${runId}/productos/listado_productos_ES.csv`;
  }
  // Defensa básica contra path traversal — los runs viven bajo "runs/<uuid>/".
  if (path.includes('..')) return jsonResponse({ error: 'invalid path' }, 400);

  const caseInsensitive = payload.case_insensitive !== false;
  let maxLines = Number.isFinite(payload.max_lines) ? Number(payload.max_lines) : MAX_LINES_DEFAULT;
  if (maxLines < 1) maxLines = 1;
  if (maxLines > MAX_LINES_HARD) maxLines = MAX_LINES_HARD;

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return jsonResponse({ error: 'service role env not available' }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(path);
  if (error || !data) {
    return jsonResponse({ error: `download failed: ${error?.message ?? 'no data'}`, path }, 404);
  }

  const text = await data.text();
  const lines = text.split(/\r?\n/);
  const needleCmp = caseInsensitive ? needle.toLowerCase() : needle;
  const matchedLines: { line_no: number; text: string }[] = [];
  let matchedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const hay = caseInsensitive ? lines[i].toLowerCase() : lines[i];
    if (hay.includes(needleCmp)) {
      matchedCount++;
      if (matchedLines.length < maxLines) {
        matchedLines.push({ line_no: i + 1, text: lines[i].slice(0, 2000) });
      }
    }
  }

  return jsonResponse({
    path,
    needle,
    total_lines: lines.length,
    matched: matchedCount,
    truncated: matchedCount > matchedLines.length,
    lines: matchedLines,
  });
});
