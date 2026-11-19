import { NextResponse } from "next/server";
import { canAccessRun } from "@/lib/access";
import { allowAttempt, limits } from "@/lib/limits";
import { continueWithContact, liveDeps, stripPageText } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Lets the user supply a real contact when Hunter has no key or no match. The contact is never emailed. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const deps = liveDeps();
  const c = await deps.store.getCompany(id);
  const run = c ? await deps.store.getRun(c.runId) : null;
  if (!c || !canAccessRun(req, run)) return NextResponse.json({ error: "Company record not found. Start a new run." }, { status: 404 });
  if (!(await allowAttempt(deps.store, "contact", id, limits.contactAttempts))) return NextResponse.json({ error: "Too many attempts for this company." }, { status: 429 });
  let body: { name?: unknown; role?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  const role = typeof body.role === "string" ? body.role : "";
  if (name.trim().length < 3 || !name.trim().includes(" ")) return NextResponse.json({ error: "Enter the contact's first and last name." }, { status: 400 });
  if (role.trim().length < 2) return NextResponse.json({ error: "Enter the contact's role." }, { status: 400 });
  const done = await continueWithContact(c, { name, role, email: typeof body.email === "string" ? body.email : undefined }, deps);
  return NextResponse.json({ company: stripPageText(done) });
}
