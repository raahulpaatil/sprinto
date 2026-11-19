import { NextResponse } from "next/server";
import { geminiConfigured } from "@/lib/gemini";
import { gmailStatus, OWNER_EMAIL } from "@/lib/gmail";
import { hunterConfigured } from "@/lib/hunter";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Booleans only. Never returns a key or token. */
export async function GET() {
  const store = getStore();
  let storeOk = true;
  try {
    await store.hit("health:ping", 1);
  } catch {
    storeOk = false;
  }
  const g = await gmailStatus(store).catch(() => ({ configured: false, source: "none" as const, canConnect: false }));
  return NextResponse.json({
    gemini: geminiConfigured(),
    hunter: hunterConfigured(),
    gmail: g.configured,
    gmailSource: g.source,
    gmailCanConnect: g.canConnect,
    store: { kind: store.kind, durable: store.durable, ok: storeOk },
    sendsOnlyTo: OWNER_EMAIL.replace(/^(.).*(@.*)$/, "$1***$2"),
  });
}
