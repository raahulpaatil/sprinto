import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { gmailClientConfigured, OWNER_EMAIL } from "@/lib/gmail";
import { COOKIE, GMAIL_SCOPE, htmlPage, redirectUri } from "@/lib/gmail-oauth";
import { clientIp } from "@/lib/limits";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Redirects to Google's consent screen (gmail.send only, offline access). */
export async function GET(req: Request) {
  if (process.env.GMAIL_REFRESH_TOKEN?.trim()) {
    return htmlPage("Gmail already configured", "A refresh token is set in the server environment, so the connect flow is skipped.");
  }
  if (!gmailClientConfigured()) {
    return htmlPage("Gmail not set up", "GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET are not set on the server yet.", 503, false);
  }
  const store = getStore();
  const hour = new Date().toISOString().slice(0, 13);
  if ((await store.hit(`gmailstart:${hour}:${clientIp(req)}`, 1)) > 10) {
    return htmlPage("Too many attempts", "Please wait an hour and try again.", 429, false);
  }
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID!.trim(),
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    login_hint: OWNER_EMAIL,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const res = NextResponse.redirect(url.toString(), 302);
  res.cookies.set(COOKIE, `${state}.${verifier}`, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/gmail", maxAge: 600 });
  return res;
}
