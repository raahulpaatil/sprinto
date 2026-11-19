// Step 7: send the draft through the Gmail API.
// HARD SAFETY RULE: the only allowed recipient is the owner's own inbox. Enforced here, server-side, twice
// (before the duplicate-lock claim and again inside the mailer right before the HTTP call).

import type { Store } from "./store";
import type { SendResult } from "./types";

export const OWNER_EMAIL = "rahulmp458@gmail.com";
export const ALLOWED_RECIPIENTS: readonly string[] = [OWNER_EMAIL];

export class SafetyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SafetyError";
  }
}

/** Strict allowlist: exactly one plain address, exactly equal to an allowed one. No lists, display names, aliases or CR/LF. */
export function assertAllowedRecipient(to: unknown): string {
  if (typeof to !== "string") throw new SafetyError("Recipient blocked: not a string.");
  if (/[\r\n,;<>"\s]/.test(to.trim()) || to.trim() !== to) throw new SafetyError("Recipient blocked: must be a single plain address.");
  const addr = to.toLowerCase();
  if (!ALLOWED_RECIPIENTS.includes(addr)) throw new SafetyError(`Recipient blocked: ${to} is not on the allowlist.`);
  return addr;
}

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  token: string; // SPR-xxxxxxxx, also present in the subject so Gmail search can find it
}

export class AmbiguousSendError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AmbiguousSendError";
  }
}

export interface Mailer {
  configured: boolean;
  send(msg: OutboundMessage): Promise<{ messageId: string }>;
  /** found: message with this token exists in Sent. "unverifiable": cannot check (missing scope / not configured). */
  findByToken(token: string): Promise<{ found: true; messageId: string } | { found: false } | "unverifiable">;
}

export function gmailConfigured() {
  return !!(process.env.GMAIL_CLIENT_ID?.trim() && process.env.GMAIL_CLIENT_SECRET?.trim() && process.env.GMAIL_REFRESH_TOKEN?.trim());
}

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildRaw(msg: OutboundMessage): string {
  const to = assertAllowedRecipient(msg.to);
  const subject = msg.subject.replace(/[\r\n]+/g, " ").slice(0, 200);
  const body = Buffer.from(msg.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const lines = [
    `From: ${OWNER_EMAIL}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    `X-Sprinto-Token: ${msg.token.replace(/[^A-Za-z0-9-]/g, "")}`,
    "",
    body,
  ];
  return b64url(Buffer.from(lines.join("\r\n"), "utf8"));
}

async function accessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID!.trim(),
      client_secret: process.env.GMAIL_CLIENT_SECRET!.trim(),
      refresh_token: process.env.GMAIL_REFRESH_TOKEN!.trim(),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed (HTTP ${res.status}). The refresh token may be expired or revoked.`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("Gmail token refresh returned no access token.");
  return j.access_token;
}

export const gmailMailer: Mailer = {
  get configured() {
    return gmailConfigured();
  },
  async send(msg) {
    const raw = buildRaw(msg); // re-checks the allowlist right before the network call
    const token = await accessToken(); // failing here is definitive: nothing was sent
    try {
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ raw }),
      });
      if (res.status >= 400 && res.status < 500) {
        const t = await res.text();
        throw new Error(`Gmail rejected the message (HTTP ${res.status}): ${t.slice(0, 160)}`);
      }
      if (!res.ok) throw new AmbiguousSendError(`Gmail returned HTTP ${res.status}; delivery unknown.`);
      const j = (await res.json()) as { id?: string };
      return { messageId: j.id ?? "unknown" };
    } catch (e) {
      if (e instanceof AmbiguousSendError) throw e;
      const m = e instanceof Error ? e.message : String(e);
      if (/^Gmail rejected/.test(m)) throw e;
      throw new AmbiguousSendError(`Send did not complete cleanly (${m.slice(0, 100)}); delivery unknown.`);
    }
  },
  async findByToken(tokenStr) {
    if (!gmailConfigured()) return "unverifiable";
    try {
      const token = await accessToken();
      const q = encodeURIComponent(`in:sent subject:"${tokenStr.replace(/[^A-Za-z0-9-]/g, "")}"`);
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 403 || res.status === 401) return "unverifiable";
      if (!res.ok) return "unverifiable";
      const j = (await res.json()) as { messages?: { id: string }[] };
      return j.messages?.[0] ? { found: true, messageId: j.messages[0].id } : { found: false };
    } catch {
      return "unverifiable";
    }
  },
};

export function tokenFor(companyId: string): string {
  let h = 0;
  for (const ch of companyId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `SPR-${h.toString(16).padStart(8, "0")}`;
}

const STALE_PENDING_MS = 2 * 60_000;

/**
 * Send one preview email to the owner's inbox, at most once per company record.
 * Order: allowlist check -> atomic lock claim -> (if a lock exists, verify Gmail before any retry) -> send.
 */
export async function sendPreview(opts: {
  companyId: string;
  to: string;
  subject: string;
  text: string;
  store: Store;
  mailer: Mailer;
  now?: () => Date;
}): Promise<SendResult> {
  const now = opts.now ?? (() => new Date());
  const at = () => now().toISOString();
  const to = assertAllowedRecipient(opts.to); // throws SafetyError before anything else happens
  if (!opts.mailer.configured) {
    return { status: "not_configured", to, note: "Gmail is not configured yet (client id / secret / refresh token missing). Nothing was sent.", at: at() };
  }
  const key = `send:${opts.companyId}`;
  const token = tokenFor(opts.companyId);
  const msg: OutboundMessage = { to, subject: `[Sprinto preview ${token}] ${opts.subject}`.slice(0, 200), text: opts.text, token };

  const claim = await opts.store.claimSend(key, opts.companyId);
  if (!claim.claimed) {
    const ex = claim.existing;
    if (ex?.state === "sent") {
      return { status: "duplicate_prevented", to, messageId: ex.messageId ?? undefined, note: "Already sent once for this company. Not sending again.", at: at() };
    }
    if (ex?.state === "pending" || ex?.state === "unknown") {
      const check = await opts.mailer.findByToken(token);
      if (check !== "unverifiable" && check.found) {
        await opts.store.setSend(key, "sent", check.messageId, "confirmed in Gmail Sent after an earlier timeout");
        return { status: "duplicate_prevented", to, messageId: check.messageId, note: "An earlier attempt had timed out, but Gmail confirms it was delivered. Not sending again.", at: at() };
      }
      if (check === "unverifiable") {
        return { status: "unknown", to, note: "An earlier send timed out and Gmail cannot confirm whether it was delivered (read access missing). Not retrying, to avoid a double send. Check your inbox.", at: at() };
      }
      const ageMs = ex.updatedAt ? now().getTime() - new Date(ex.updatedAt).getTime() : Infinity;
      if (ex.state === "pending" && ageMs < STALE_PENDING_MS) {
        return { status: "in_flight", to, note: "A send for this company is already in progress.", at: at() };
      }
      // Gmail confirms nothing was delivered: safe to retry.
      await opts.store.setSend(key, "pending", null, "retrying after Gmail confirmed no delivery");
    } else if (ex?.state === "failed") {
      await opts.store.setSend(key, "pending", null, "retrying after a definitive failure");
    }
  }

  try {
    const r = await opts.mailer.send(msg);
    await opts.store.setSend(key, "sent", r.messageId);
    return { status: "sent", to, messageId: r.messageId, note: "Preview sent to your own inbox. The prospect was not emailed.", at: at() };
  } catch (e) {
    if (e instanceof SafetyError) {
      await opts.store.setSend(key, "failed", null, "blocked by allowlist");
      return { status: "blocked", note: e.message, at: at() };
    }
    if (e instanceof AmbiguousSendError) {
      await opts.store.setSend(key, "unknown", null, e.message);
      return { status: "unknown", to, note: `${e.message} Will not resend until Gmail confirms it was not delivered.`, at: at() };
    }
    await opts.store.setSend(key, "failed", null, e instanceof Error ? e.message : String(e));
    return { status: "failed", to, note: e instanceof Error ? e.message : String(e), at: at() };
  }
}
