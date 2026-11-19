import { timingSafeEqual } from "node:crypto";
import { gmailClientConfigured, storeRefreshToken } from "@/lib/gmail";
import { COOKIE, GMAIL_SCOPE, htmlPage, redirectUri } from "@/lib/gmail-oauth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

function cookieValue(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Exchanges the authorization code for tokens and stores the refresh token (encrypted) server-side. Never displays it. */
export async function GET(req: Request) {
  const clear = (r: Response) => {
    r.headers.append("set-cookie", `${COOKIE}=; Path=/api/gmail; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return r;
  };
  if (!gmailClientConfigured()) return htmlPage("Gmail not set up", "GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are not set on the server.", 503, false);
  const q = new URL(req.url).searchParams;
  const err = q.get("error");
  if (err) return clear(htmlPage("Gmail not connected", `Google reported: ${err.replace(/[^a-z_ -]/gi, "").slice(0, 60)}. Nothing was changed.`, 400, false));
  const cookie = cookieValue(req, COOKIE);
  const [state, verifier] = (cookie ?? "").split(".");
  const code = q.get("code");
  const gotState = q.get("state");
  if (!cookie || !state || !verifier || !code || !gotState || !same(state, gotState)) {
    return clear(htmlPage("Gmail not connected", "The sign-in session expired or did not match. Start again from /api/gmail/start.", 400, false));
  }
  let j: { refresh_token?: string; scope?: string; error?: string };
  try {
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({
        code,
        client_id: process.env.GMAIL_CLIENT_ID!.trim(),
        client_secret: process.env.GMAIL_CLIENT_SECRET!.trim(),
        redirect_uri: redirectUri(req),
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    j = await tr.json();
  } catch {
    return clear(htmlPage("Gmail not connected", "Could not reach Google to finish connecting. Try again.", 502, false));
  }
  if (!j.refresh_token) {
    return clear(htmlPage("Gmail not connected", `Google did not return a refresh token${j.error ? ` (${j.error.replace(/[^a-z_]/gi, "")})` : ""}. Check the redirect URI and client secret, then try again.`, 400, false));
  }
  if (!(j.scope ?? "").includes(GMAIL_SCOPE)) {
    return clear(htmlPage("Gmail not connected", "The send permission was not granted. Start again and allow it.", 400, false));
  }
  await storeRefreshToken(getStore(), j.refresh_token);
  return clear(htmlPage("Gmail connected", "Sprinto can now send previews. They go only to the owner's own inbox, never to a prospect."));
}
