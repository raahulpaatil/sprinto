// Access control for a public, no-login landing page.
//  - "Owner" = holds a session issued after presenting OWNER_KEY (env). Fail closed: no key configured => nobody is owner.
//  - Every live operation (runs, discovery, Hunter, Gemini, drafts, sends, Gmail connect, stored outputs) is owner-only.
//  - Visitors get the landing page and clearly labelled static sample output. No live API calls.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OWNER_COOKIE = "sprinto_owner";
export const OWNER_SESSION_SECONDS = 12 * 3600;
const MIN_KEY = 16;

const ownerKey = () => {
  const k = process.env.OWNER_KEY?.trim();
  return k && k.length >= MIN_KEY ? k : null;
};
export const ownerConfigured = () => !!ownerKey();

const sha = (s: string) => createHash("sha256").update(s).digest();
function safeEq(a: string, b: string) {
  const x = sha(a), y = sha(b);
  return timingSafeEqual(x, y);
}
const mac = (key: string, msg: string) => createHmac("sha256", key).update(msg).digest("base64url");

export function checkOwnerKey(input: unknown): boolean {
  const k = ownerKey();
  return !!k && typeof input === "string" && input.length > 0 && input.length < 256 && safeEq(input, k);
}

export function issueOwnerCookie(now = Date.now()): { value: string; maxAge: number } | null {
  const k = ownerKey();
  if (!k) return null;
  const exp = Math.floor(now / 1000) + OWNER_SESSION_SECONDS;
  return { value: `${exp}.${mac(k, `sprinto-owner:v1:${exp}`)}`, maxAge: OWNER_SESSION_SECONDS };
}

export function cookieValue(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

/** JSON 401 for visitors on any owner-only API route. */
export function ownerOnly(req: Request): Response | null {
  if (isOwner(req)) return null;
  return new Response(JSON.stringify({ error: "Owner sign-in required. The public page shows static sample output only." }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function isOwner(req: Request, now = Date.now()): boolean {
  const k = ownerKey();
  const v = cookieValue(req, OWNER_COOKIE);
  if (!k || !v) return false;
  const [exp, sig] = v.split(".");
  if (!/^\d{9,12}$/.test(exp ?? "") || !sig) return false;
  if (Number(exp) * 1000 < now) return false;
  return safeEq(sig, mac(k, `sprinto-owner:v1:${exp}`));
}

/** HMAC-signed value so the OAuth state cookie cannot be forged or swapped. */
export function signValue(raw: string): string {
  const k = ownerKey() ?? "unconfigured";
  return `${raw}.${mac(k, `sprinto-state:${raw}`)}`;
}
export function verifySigned(signed: string): string | null {
  const i = signed.lastIndexOf(".");
  if (i < 0 || !ownerKey()) return null;
  const raw = signed.slice(0, i);
  return safeEq(signed.slice(i + 1), mac(ownerKey()!, `sprinto-state:${raw}`)) ? raw : null;
}
