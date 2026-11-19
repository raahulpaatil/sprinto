import { NextResponse } from "next/server";
import { checkOwnerKey, issueOwnerCookie, OWNER_COOKIE, ownerConfigured } from "@/lib/access";
import { allowOwnerLogin, clientIp } from "@/lib/limits";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Exchanges OWNER_KEY for a 12-hour HttpOnly session cookie. The key is never stored in the browser. */
export async function POST(req: Request) {
  if (!ownerConfigured()) return NextResponse.json({ error: "Owner access is not configured on this server." }, { status: 503 });
  const gate = await allowOwnerLogin(getStore(), clientIp(req));
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec ?? 3600) } });
  let key: unknown;
  try {
    key = ((await req.json()) as { key?: unknown }).key;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!checkOwnerKey(key)) return NextResponse.json({ error: "Wrong key." }, { status: 401 });
  const c = issueOwnerCookie()!;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(OWNER_COOKIE, c.value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: c.maxAge });
  return res;
}
