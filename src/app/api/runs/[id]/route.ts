import { NextResponse } from "next/server";
import { ownerOnly } from "@/lib/access";
import { liveDeps, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

/** Stored outputs are private: owner only. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = ownerOnly(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const deps = liveDeps();
  const run = await deps.store.getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  const companies = (await deps.store.listCompanies(id)).map(stripPageText);
  return NextResponse.json({ run, companies });
}
