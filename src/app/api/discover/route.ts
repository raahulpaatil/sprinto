import { NextResponse } from "next/server";
import { discoverDomains } from "@/lib/discover";
import { parseCriteria, summarize } from "@/lib/criteria";
import { allowDiscover, clientIp } from "@/lib/limits";
import { liveDeps } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) body = b as Record<string, unknown>;
  } catch {
    /* empty body: defaults */
  }
  // Legacy shape {note} is accepted as guidance on top of the defaults.
  const parsed = parseCriteria(body.criteria ?? (typeof body.note === "string" ? { note: body.note } : undefined));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const deps = liveDeps();
  const gate = await allowDiscover(deps.store, clientIp(req));
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec ?? 3600) } });
  try {
    const candidates = await discoverDomains(parsed.criteria, deps.llm);
    return NextResponse.json({ criteria: parsed.criteria, summary: summarize(parsed.criteria), candidates });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Discovery failed." }, { status: 502 });
  }
}
