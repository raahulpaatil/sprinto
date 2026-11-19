import { NextResponse } from "next/server";
import { liveDeps, processCompany, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  const c = await deps.store.getCompany(id);
  if (!c) return NextResponse.json({ error: "Company record not found. If storage is not durable the record may have been lost between requests." }, { status: 404 });
  if (c.status === "done") return NextResponse.json({ company: stripPageText(c) });
  if (c.status === "running" && Date.now() - new Date(c.updatedAt).getTime() < 90_000) {
    return NextResponse.json({ company: stripPageText(c) });
  }
  const done = await processCompany(c, deps);
  return NextResponse.json({ company: stripPageText(done) });
}
