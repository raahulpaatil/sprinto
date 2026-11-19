import { NextResponse } from "next/server";
import { discoverDomains, ICP_TEXT } from "@/lib/discover";
import { isOwner } from "@/lib/access";
import { allowDiscover, clientIp } from "@/lib/limits";
import { liveDeps } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const deps = liveDeps();
  const gate = isOwner(req) ? { ok: true as const } : await allowDiscover(deps.store, clientIp(req));
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec ?? 3600) } });
  let extra: string | undefined;
  try {
    const b = (await req.json()) as { note?: unknown };
    extra = typeof b.note === "string" ? b.note : undefined;
  } catch {
    /* empty body is fine */
  }
  try {
    const candidates = await discoverDomains(extra, deps.llm);
    return NextResponse.json({
      icp: ICP_TEXT,
      candidates,
      caveat: "Suggested from the model's memory and not verified. Each one is still scraped and qualified before anything else happens.",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Discovery failed." }, { status: 502 });
  }
}
