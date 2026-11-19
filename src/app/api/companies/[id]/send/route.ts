import { NextResponse } from "next/server";
import { liveDeps, resend, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Retry the own-inbox send. The recipient is fixed server-side; the duplicate lock verifies Gmail before any retry. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  const c = await deps.store.getCompany(id);
  if (!c) return NextResponse.json({ error: "Company record not found." }, { status: 404 });
  const done = await resend(c, deps);
  return NextResponse.json({ company: stripPageText(done) });
}
