// Abuse protection for a public, no-login deployment. Counters live in the same store as everything else, so
// they hold across serverless instances when storage is durable. A normal reviewer doing a few runs is never affected.

import type { Store } from "./store";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export const limits = {
  get maxDomainsPerRun() { return 10; },
  get runsPerIpPerHour() { return num(process.env.RUNS_PER_IP_PER_HOUR, 5); },
  get runsGlobalPerDay() { return num(process.env.RUNS_GLOBAL_PER_DAY, 20); },
  get discoverPerIpPerHour() { return num(process.env.DISCOVER_PER_IP_PER_HOUR, 5); },
  get discoverGlobalPerDay() { return num(process.env.DISCOVER_GLOBAL_PER_DAY, 20); },
  get maxDiscoveryResults() { return 5; },
  /** Per-company caps so one record cannot be used to burn model calls. */
  processAttempts: 3,
  contactAttempts: 3,
  sendAttempts: 5,
};
export const MAX_DOMAINS_PER_RUN = 10;

/** The client address as seen by the platform. Vercel overwrites x-forwarded-for, so the first entry is the real client. */
export function clientIp(req: Request): string {
  const v = req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "local";
  return v.split(",")[0].trim().slice(0, 64) || "local";
}

const iso = (d: Date) => d.toISOString();
const dayKey = (d: Date) => iso(d).slice(0, 10);
const hourKey = (d: Date) => iso(d).slice(0, 13);

export interface Gate {
  ok: boolean;
  reason?: string;
  retryAfterSec?: number;
}

function secondsToNextHour(d: Date) {
  return 3600 - (d.getUTCMinutes() * 60 + d.getUTCSeconds());
}
function secondsToNextDay(d: Date) {
  return 86400 - (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds());
}

async function twoLevel(
  store: Store,
  kind: string,
  ip: string,
  perIpHour: number,
  globalDay: number,
  noun: string,
  now: Date,
): Promise<Gate> {
  const perIp = await store.hit(`${kind}:h:${hourKey(now)}:${ip}`, 1);
  if (perIp > perIpHour) {
    return { ok: false, retryAfterSec: secondsToNextHour(now), reason: `Rate limit: ${perIpHour} ${noun} per hour per visitor. Try again in about ${Math.ceil(secondsToNextHour(now) / 60)} minutes.` };
  }
  const g = await store.hit(`${kind}:d:${dayKey(now)}:all`, 1);
  if (g > globalDay) {
    return { ok: false, retryAfterSec: secondsToNextDay(now), reason: `This demo has reached its daily capacity (${globalDay} ${noun} per day). Please try again tomorrow.` };
  }
  return { ok: true };
}

export function allowRun(store: Store, ip: string, now = new Date()) {
  return twoLevel(store, "runs", ip, limits.runsPerIpPerHour, limits.runsGlobalPerDay, "research runs", now);
}

export function allowDiscover(store: Store, ip: string, now = new Date()) {
  return twoLevel(store, "discover", ip, limits.discoverPerIpPerHour, limits.discoverGlobalPerDay, "discovery requests", now);
}

/** Per-record cap for expensive follow-up calls (re-process, add contact, resend). */
export async function allowAttempt(store: Store, kind: string, id: string, max: number): Promise<boolean> {
  return (await store.hit(`attempt:${kind}:${id}`, 1)) <= max;
}
