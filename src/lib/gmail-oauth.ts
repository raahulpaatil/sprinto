// Shared helpers for the in-app Gmail connect flow (/api/gmail/start and /api/gmail/callback).
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const COOKIE = "sprinto_gmail_oauth";

/** The exact redirect URI to register in Google Cloud Console. GMAIL_REDIRECT_URI overrides the derived one. */
export function redirectUri(req: Request): string {
  const fixed = process.env.GMAIL_REDIRECT_URI?.trim();
  if (fixed) return fixed;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}/api/gmail/callback`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function htmlPage(title: string, message: string, status = 200, ok = true): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | Sprinto</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px}h1{font-size:22px}.ok{color:#14733a}.bad{color:#b42318}a{color:inherit}</style></head>
<body><h1 class="${ok ? "ok" : "bad"}">${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Back to Sprinto</a></p></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
