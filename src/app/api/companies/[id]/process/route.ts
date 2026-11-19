import { NextResponse } from "next/server";
import { allowAttempt, limits } from "@/lib/limits";
import { liveDeps, processCompany, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Only companies created by POST /api/runs (which is rate limited) can be processed. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  const c = await deps.store.getCompany(id);
  if (!c) return NextResponse.json({ error: "Company record not found. Start a new run." }, { status: 404 });
  if (c.status === "done") return NextResponse.json({ company: stripPageText(c) });
  if (c.status === "running" && Date.now() - new Date(c.updatedAt).getTime() < 90_000) {
    return NextResponse.json({ company: stripPageText(c) });
  }
  if (!(await allowAttempt(deps.store, "process", id, limits.processAttempts))) {
    return NextResponse.json({ error: "Too many attempts for this company. Start a new run." }, { status: 429 });
  }
  const done = await processCompany(c, deps);
  return NextResponse.json({ company: stripPageText(done) });
}
