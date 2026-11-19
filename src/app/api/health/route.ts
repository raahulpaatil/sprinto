import { NextResponse } from "next/server";
import { geminiConfigured } from "@/lib/gemini";
import { gmailStatus, OWNER_EMAIL } from "@/lib/gmail";
import { clientIp, limits, publicAllowance } from "@/lib/limits";
import { hunterAccount, hunterConfigured, type HunterAccount } from "@/lib/hunter";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
const NS = { "cache-control": "no-store" };

// Hunter's account endpoint is free but external, so the page's status call reuses one reading for a minute.
let hunterCache: { at: number; v: HunterAccount | null } | null = null;
async function hunterReading() {
  if (hunterCache && Date.now() - hunterCache.at < 60_000) return hunterCache.v;
  const v = await hunterAccount();
  hunterCache = { at: Date.now(), v };
  return v;
}

/** Status for the page chips: booleans, counts and the shared limits. Never a key, token, connection string or address. */
export async function GET(req: Request) {
  const store = getStore();
  const g = await gmailStatus(store).catch(() => ({ configured: false }));
  let storeOk = true;
  try {
    await store.hit("health:ping", 1);
  } catch {
    storeOk = false;
  }
  const day = new Date().toISOString().slice(0, 10);
  return NextResponse.json(
    {
      gemini: geminiConfigured(),
      hunter: hunterConfigured(),
      hunterAccount: await hunterReading(), // numbers only: plan, used, available, reset date
      sendReady: g.configured,
      contactLookup: hunterConfigured(),
      store: { kind: store.kind, durable: store.durable, ok: storeOk },
      allowance: await publicAllowance(store, clientIp(req)),
      caps: {
        runsPerIpPerHour: limits.runsPerIpPerHour,
        runsGlobalPerDay: limits.runsGlobalPerDay,
        companiesGlobalPerDay: limits.companiesGlobalPerDay,
        discoverPerIpPerHour: limits.discoverPerIpPerHour,
        discoverGlobalPerDay: limits.discoverGlobalPerDay,
        geminiDailyCallCap: Number(process.env.GEMINI_DAILY_CALL_CAP || 150),
        hunterMonthlyCap: Number(process.env.HUNTER_MONTHLY_CAP || 40),
        hunterPerRunCap: Number(process.env.HUNTER_PER_RUN_CAP || 5),
        hunterReserve: Number(process.env.HUNTER_RESERVE || 10),
        sendsGlobalPerDay: Number(process.env.SENDS_GLOBAL_PER_DAY || 25),
      },
      usageToday: {
        runs: await store.hit(`runs:d:${day}:all`, 0),
        companies: await store.hit(`companies:d:${day}:all`, 0),
        geminiCalls: await store.hit(`gemini:d:${day}`, 0),
        sends: await store.hit(`sends:d:${day}`, 0),
        hunterThisMonth: await store.hit(`hunter:m:${day.slice(0, 7)}`, 0),
      },
      sendsOnlyTo: OWNER_EMAIL.replace(/^(.).*(@.*)$/, "$1***$2"),
    },
    { headers: NS },
  );
}
