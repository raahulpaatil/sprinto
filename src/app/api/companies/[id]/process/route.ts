import { NextResponse } from "next/server";
import { normalizeDomain } from "@/lib/fetcher";
import { allowCompanies, clientIp } from "@/lib/limits";
import { liveDeps, newCompany, processCompany, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  let c = await deps.store.getCompany(id);
  if (!c) {
    // Without durable storage a different serverless instance may not have the record. Rebuild it from the
    // skeleton the page sends (domain + options only; never facts, drafts or contacts).
    let body: { skeleton?: { runId?: unknown; domain?: unknown; expectedName?: unknown; sendEnabled?: unknown; hintContact?: { name?: unknown; role?: unknown } } } = {};
    try {
      body = await req.json();
    } catch {
      /* no body */
    }
    const s = body.skeleton;
    const domain = typeof s?.domain === "string" ? normalizeDomain(s.domain) : null;
    if (!s || !domain || !/^[0-9a-f-]{36}$/.test(id)) {
      return NextResponse.json({ error: "Company record not found." }, { status: 404 });
    }
    const gate = await allowCompanies(deps.store, clientIp(req), 1);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429 });
    const hint = typeof s.hintContact?.name === "string" && typeof s.hintContact?.role === "string" ? { name: s.hintContact.name, role: s.hintContact.role } : undefined;
    c = newCompany(typeof s.runId === "string" ? s.runId.slice(0, 64) : "rebuilt", id, domain, s.sendEnabled !== false, deps.now(), typeof s.expectedName === "string" ? s.expectedName.slice(0, 80) : undefined, hint);
  }
  if (c.status === "done") return NextResponse.json({ company: stripPageText(c) });
  if (c.status === "running" && Date.now() - new Date(c.updatedAt).getTime() < 90_000) {
    return NextResponse.json({ company: stripPageText(c) });
  }
  const done = await processCompany(c, deps);
  return NextResponse.json({ company: stripPageText(done) });
}
