// Abuse protection for a public, no-login deployment. Counters live in the same store as everything else, so
// they hold across serverless instances when storage is durable. A normal reviewer doing a few runs is never affected.

import type { Store } from "./store";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

export const limits = {
  get maxDomainsPerRun() { return 10; },
  get runsPerIpPerHour() { return num(process.env.RUNS_PER_IP_PER_HOUR, 3); },
  get runsGlobalPerDay() { return num(process.env.RUNS_GLOBAL_PER_DAY, 10); },
  get ownerRunsPerDay() { return num(process.env.OWNER_RUNS_PER_DAY, 20); },
  get companiesGlobalPerDay() { return num(process.env.COMPANIES_GLOBAL_PER_DAY, 40); },
  get discoverPerIpPerHour() { return num(process.env.DISCOVER_PER_IP_PER_HOUR, 3); },
  get discoverGlobalPerDay() { return num(process.env.DISCOVER_GLOBAL_PER_DAY, 10); },
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
    return { ok: false, retryAfterSec: secondsToNextDay(now), reason: `Daily demo limit reached (${globalDay} ${noun} per day across all visitors). Please try again tomorrow.` };
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

/** Failed owner-key attempts: 8 per hour per IP. */
export async function allowOwnerLogin(store: Store, ip: string, now = new Date()): Promise<Gate> {
  const n = await store.hit(`ownerlogin:h:${hourKey(now)}:${ip}`, 1);
  return n > 8 ? { ok: false, retryAfterSec: secondsToNextHour(now), reason: "Too many attempts. Try again later." } : { ok: true };
}

/** Public runs also share a daily company budget, so ten large runs cannot exceed the free AI quota. */
export async function allowCompaniesToday(store: Store, n: number, now = new Date()): Promise<Gate> {
  const total = await store.hit(`companies:d:${dayKey(now)}:all`, n);
  return total > limits.companiesGlobalPerDay
    ? { ok: false, retryAfterSec: secondsToNextDay(now), reason: `Daily demo limit reached (${limits.companiesGlobalPerDay} companies per day across all visitors). Please try again tomorrow.` }
    : { ok: true };
}

/**
 * Owner runs have their own bounded daily counter (`runs:owner:d:<UTC day>`, default 20, env OWNER_RUNS_PER_DAY).
 * They never touch the public counters (`runs:d:<day>:all`, `runs:h:<hour>:<ip>`, `companies:d:<day>:all`), so owner testing
 * cannot eat the evaluators' allowance. The ceiling still limits damage if the owner key ever leaks.
 */
export async function allowOwnerRun(store: Store, now = new Date()): Promise<Gate> {
  const cap = num(process.env.OWNER_RUNS_PER_DAY, 20);
  const n = await store.hit(`runs:owner:d:${dayKey(now)}`, 1);
  return n > cap ? { ok: false, retryAfterSec: secondsToNextDay(now), reason: `Owner daily ceiling (${cap} runs) reached. It resets at 00:00 UTC.` } : { ok: true };
}

/** Single entry point for starting a run: owner runs and visitor runs are counted separately. */
export async function gateRun(store: Store, opts: { owner: boolean; ip: string; companies: number; now?: Date }): Promise<Gate> {
  const now = opts.now ?? new Date();
  if (opts.owner) return allowOwnerRun(store, now);
  const g = await allowRun(store, opts.ip, now);
  if (!g.ok) return g;
  return allowCompaniesToday(store, opts.companies, now);
}

/** What a visitor may still do today. Reads counters without incrementing them. */
export async function publicAllowance(store: Store, ip: string, now = new Date()) {
  const usedGlobal = await store.hit(`runs:d:${dayKey(now)}:all`, 0);
  const usedIp = await store.hit(`runs:h:${hourKey(now)}:${ip}`, 0);
  const usedCompanies = await store.hit(`companies:d:${dayKey(now)}:all`, 0);
  const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const nextHour = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1)).toISOString();
  return {
    runsLeftToday: Math.max(0, limits.runsGlobalPerDay - usedGlobal),
    runsDailyCap: limits.runsGlobalPerDay,
    runsLeftThisHourForYou: Math.max(0, limits.runsPerIpPerHour - usedIp),
    runsHourlyCap: limits.runsPerIpPerHour,
    companiesLeftToday: Math.max(0, limits.companiesGlobalPerDay - usedCompanies),
    dailyResetsAtUtc: nextDay,
    hourlyResetsAtUtc: nextHour,
  };
}

