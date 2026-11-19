import { NextResponse } from "next/server";
import { liveDeps, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  const run = await deps.store.getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  const companies = (await deps.store.listCompanies(id)).map(stripPageText);
  return NextResponse.json({ run, companies });
}
