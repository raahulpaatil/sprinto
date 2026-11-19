import { after, NextResponse } from "next/server";
import { canAccessRun } from "@/lib/access";
import { allowAttempt, limits } from "@/lib/limits";
import { liveDeps, processCompany, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Treat a record as still being worked on if it was touched this recently (stages persist every few seconds to tens of seconds). */
const RUNNING_FRESH_MS = 180_000;

/**
 * Public, but only for companies of a run the caller can access and only after POST /api/runs passed the rate limits.
 * It returns immediately; the pipeline continues in the background (waitUntil) and the page polls GET /api/runs/{id}.
 * That keeps every HTTP request short, so a proxy or flaky network cannot turn a long silent request into a bogus error.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  const c = await deps.store.getCompany(id);
  const run = c ? await deps.store.getRun(c.runId) : null;
  if (!c || !canAccessRun(req, run)) return NextResponse.json({ error: "Company record not found. Start a new run." }, { status: 404 });
  if (c.status === "done") return NextResponse.json({ company: stripPageText(c) });
  if (c.status === "running" && Date.now() - new Date(c.updatedAt).getTime() < RUNNING_FRESH_MS) {
    return NextResponse.json({ company: stripPageText(c) }, { status: 202 });
  }
  if (!(await allowAttempt(deps.store, "process", id, limits.processAttempts))) {
    return NextResponse.json({ error: "Too many attempts for this company. Start a new run." }, { status: 429 });
  }
  // Mark it running before returning so a second request cannot start a duplicate.
  c.status = "running";
  c.stage = "starting";
  c.error = undefined;
  c.updatedAt = new Date().toISOString();
  await deps.store.saveCompany(c);
  after(async () => {
    await processCompany(c, deps); // never throws; failures are recorded on the record
  });
  return NextResponse.json({ company: stripPageText(c) }, { status: 202 });
}
