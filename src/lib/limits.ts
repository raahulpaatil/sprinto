// Abuse limits for a public, no-login deployment. Counters live in the same store as everything else.

import type { Store } from "./store";

export const MAX_DOMAINS_PER_RUN = 10;
export const MAX_COMPANIES_PER_IP_PER_DAY = 40;
export const MAX_COMPANIES_GLOBAL_PER_DAY = 250;
export const MAX_DISCOVER_PER_IP_PER_DAY = 15;

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  return (xf?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim().slice(0, 64);
}

function day() {
  return new Date().toISOString().slice(0, 10);
}

export async function allowCompanies(store: Store, ip: string, n: number): Promise<{ ok: boolean; reason?: string }> {
  const perIp = await store.hit(`companies:${day()}:${ip}`, n);
  if (perIp > MAX_COMPANIES_PER_IP_PER_DAY) return { ok: false, reason: `Daily limit reached (${MAX_COMPANIES_PER_IP_PER_DAY} companies per visitor per day). Try again tomorrow.` };
  const global = await store.hit(`companies:${day()}:all`, n);
  if (global > MAX_COMPANIES_GLOBAL_PER_DAY) return { ok: false, reason: "This demo has hit its daily capacity. Try again tomorrow." };
  return { ok: true };
}

export async function allowDiscover(store: Store, ip: string): Promise<boolean> {
  return (await store.hit(`discover:${day()}:${ip}`, 1)) <= MAX_DISCOVER_PER_IP_PER_DAY;
}
