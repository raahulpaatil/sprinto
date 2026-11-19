import { NextResponse } from "next/server";
import { isOwner, ownerConfigured } from "@/lib/access";
import { geminiConfigured } from "@/lib/gemini";
import { gmailStatus, OWNER_EMAIL } from "@/lib/gmail";
import { hunterConfigured } from "@/lib/hunter";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Visitors learn only whether the owner is signed in. Configuration status (booleans, never secrets) is owner-only. */
export async function GET(req: Request) {
  const owner = isOwner(req);
  if (!owner) return NextResponse.json({ owner: false, ownerConfigured: ownerConfigured() }, { headers: { "cache-control": "no-store" } });
  const store = getStore();
  let storeOk = true;
  try {
    await store.hit("health:ping", 1);
  } catch {
    storeOk = false;
  }
  const g = await gmailStatus(store).catch(() => ({ configured: false, source: "none" as const, canConnect: false }));
  return NextResponse.json({
    owner: true,
    gemini: geminiConfigured(),
    hunter: hunterConfigured(),
    gmail: g.configured,
    gmailSource: g.source,
    gmailCanConnect: g.canConnect,
    store: { kind: store.kind, durable: store.durable, ok: storeOk },
    sendsOnlyTo: OWNER_EMAIL.replace(/^(.).*(@.*)$/, "$1***$2"),
  }, { headers: { "cache-control": "no-store" } });
}
