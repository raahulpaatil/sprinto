// Step 4: find a point of contact with the Hunter Domain Search API. Called only after a company qualifies.
// The key comes from HUNTER_API_KEY. No key / no suitable person => a recorded skip, never a made-up contact.

import type { Contact } from "./types";

export interface LookupCtx {
  runId: string;
  companyId: string;
}
export type ContactFinder = (domain: string, ctx?: LookupCtx) => Promise<{ contact?: Contact; skip?: string }>;

export function hunterConfigured() {
  return !!process.env.HUNTER_API_KEY?.trim();
}

interface HunterEmail {
  value?: string;
  confidence?: number;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  seniority?: string | null;
  department?: string | null;
  verification?: { status?: string | null } | null;
}

const TIERS: { re: RegExp; score: number; why: string }[] = [
  { re: /(compliance|grc|governance|risk|ciso|chief information security|information security|head of security|security (lead|manager|director|engineer)|vp.*security|head of trust|trust)/i, score: 100, why: "owns compliance / security" },
  { re: /(cto|chief technology|vp.*engineering|head of engineering|engineering (director|manager|lead)|director.*engineering|vp of eng)/i, score: 80, why: "engineering leadership" },
  { re: /(founder|co-founder|cofounder|ceo|chief executive)/i, score: 70, why: "founder / CEO" },
  { re: /(coo|chief operating|head of (it|operations)|it (director|manager))/i, score: 50, why: "operations / IT leadership" },
];

export function rankContacts(emails: HunterEmail[]): { contact?: Contact; reason: string } {
  const usable = emails.filter((e) => {
    if (!e.first_name?.trim() || !e.last_name?.trim()) return false; // need a real name
    if (!e.position?.trim()) return false; // need a real role
    if (!e.value) return false;
    if (e.verification?.status === "invalid") return false;
    return true;
  });
  let best: { e: HunterEmail; score: number; why: string } | null = null;
  for (const e of usable) {
    const tier = TIERS.find((t) => t.re.test(e.position ?? ""));
    if (!tier) continue;
    const score = tier.score + (e.confidence ?? 0) / 10 + (e.verification?.status === "valid" ? 3 : 0);
    if (!best || score > best.score) best = { e, score, why: tier.why };
  }
  if (!best) {
    return { reason: `Hunter returned ${emails.length} people, but none with a full name and a compliance, security, engineering-leadership or founder role.` };
  }
  const e = best.e;
  return {
    reason: "",
    contact: {
      name: `${e.first_name!.trim()} ${e.last_name!.trim()}`,
      role: e.position!.trim(),
      email: e.value,
      confidence: e.confidence,
      source: "hunter",
      why: `Role ${best.why}`,
    },
  };
}

export const hunterContacts: ContactFinder = async (domain) => {
  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key) return { skip: "No HUNTER_API_KEY is configured, so no contact was looked up. No contact was invented." };
  const base = "https://api.hunter.io/v2/domain-search";
  const attempts = [
    `${base}?domain=${encodeURIComponent(domain)}&limit=10&seniority=senior,executive`,
    `${base}?domain=${encodeURIComponent(domain)}&limit=10`,
  ];
  let lastErr = "";
  for (const url of attempts) {
    try {
      const res = await fetch(url, { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(12_000) });
      if (res.status === 401 || res.status === 403) return { skip: `Hunter rejected the API key (HTTP ${res.status}).` };
      if (res.status === 429) return { skip: "Hunter rate limit or monthly quota reached (HTTP 429). Try again later." };
      if (res.status === 402) return { skip: "Hunter plan has no credits left (HTTP 402). Not upgrading." };
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue; // retry once without the filter in case the plan rejects it
      }
      const data = (await res.json()) as { data?: { emails?: HunterEmail[] } };
      const emails = data.data?.emails ?? [];
      if (emails.length === 0) return { skip: "Hunter found no people at this domain." };
      const r = rankContacts(emails);
      return r.contact ? { contact: r.contact } : { skip: r.reason };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { skip: `Hunter lookup failed (${lastErr || "unknown error"}). No contact was invented.` };
};

export interface HunterAccount {
  plan: string | null;
  used: number | null;
  available: number | null;
  resetDate: string | null;
}

/** Free call (does not use credits). Returns numbers only; the key is never exposed. */
export async function hunterAccount(): Promise<HunterAccount | null> {
  const key = process.env.HUNTER_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch("https://api.hunter.io/v2/account", { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { plan_name?: string; reset_date?: string; requests?: { searches?: { used?: number; available?: number }; credits?: { used?: number; available?: number } } } };
    const r = j.data?.requests?.credits ?? j.data?.requests?.searches; // credits is the current free-plan counter (50/month)
    return { plan: j.data?.plan_name ?? null, used: r?.used ?? null, available: r?.available ?? null, resetDate: j.data?.reset_date ?? null };
  } catch {
    return null;
  }
}

/** Credits left according to Hunter itself, read fresh before every lookup (the account call is free). null = could not be verified. */
export async function hunterRemaining(): Promise<number | null> {
  const a = await hunterAccount();
  return a && a.available !== null && a.used !== null ? a.available - a.used : null;
}
