import { NextResponse } from "next/server";
import { isOwner, ownerConfigured } from "@/lib/access";
import { geminiConfigured } from "@/lib/gemini";
import { gmailStatus, OWNER_EMAIL } from "@/lib/gmail";
import { hunterAccount, hunterConfigured } from "@/lib/hunter";
import { limits } from "@/lib/limits";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
const NS = { "cache-control": "no-store" };

/** Visitors get two booleans that explain what the demo can do. Configuration, quota and storage details are owner-only. */
export async function GET(req: Request) {
  const store = getStore();
  const g = await gmailStatus(store).catch(() => ({ configured: false, source: "none" as const, canConnect: false }));
  if (!isOwner(req)) {
    return NextResponse.json({ owner: false, ownerConfigured: ownerConfigured(), sendReady: g.configured, contactLookup: hunterConfigured() }, { headers: NS });
  }
  let storeOk = true;
  try {
    await store.hit("health:ping", 1);
  } catch {
    storeOk = false;
  }
  const day = new Date().toISOString().slice(0, 10);
  return NextResponse.json(
    {
      owner: true,
      gemini: geminiConfigured(),
      hunter: hunterConfigured(),
      hunterAccount: await hunterAccount(), // numbers only: plan, used, available, reset date
      gmail: g.configured,
      gmailSource: g.source,
      gmailCanConnect: g.canConnect,
      sendReady: g.configured,
      contactLookup: hunterConfigured(),
      store: { kind: store.kind, durable: store.durable, ok: storeOk },
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
