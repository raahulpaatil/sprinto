import { NextResponse } from "next/server";
import { canAccessRun } from "@/lib/access";
import { liveDeps, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/** Readable only through the run's own unguessable id. There is no listing. Owner and legacy runs are private (404 to visitors). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  const run = await deps.store.getRun(id);
  if (!run || !canAccessRun(req, run)) return NextResponse.json({ error: "Run not found." }, { status: 404, headers: { "cache-control": "no-store" } });
  const companies = (await deps.store.listCompanies(id)).map(stripPageText);
  return NextResponse.json({ run, companies }, { headers: { "cache-control": "no-store" } });
}
