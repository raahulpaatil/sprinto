import { NextResponse } from "next/server";
import { ownerOnly } from "@/lib/access";
import { allowAttempt, limits } from "@/lib/limits";
import { liveDeps, resend, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Retry the own-inbox send. The recipient is fixed server-side; the duplicate lock verifies Gmail before any retry. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const deps = liveDeps();
  const c = await deps.store.getCompany(id);
  if (!c) return NextResponse.json({ error: "Company record not found." }, { status: 404 });
  if (!(await allowAttempt(deps.store, "send", id, limits.sendAttempts))) return NextResponse.json({ error: "Too many send attempts for this company." }, { status: 429 });
  const done = await resend(c, deps);
  return NextResponse.json({ company: stripPageText(done) });
}
