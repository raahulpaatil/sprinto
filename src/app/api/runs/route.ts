import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isOwner } from "@/lib/access";
import { normalizeDomain } from "@/lib/fetcher";
import { allowCompaniesToday, allowOwnerRun, allowRun, clientIp, MAX_DOMAINS_PER_RUN } from "@/lib/limits";
import { newCompany, liveDeps, stripPageText } from "@/lib/pipeline";
import type { RunRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Lines: "acme.com" | "acme.com | Acme Inc" (name guards against look-alikes) | "acme.com | Acme Inc | Jane Doe | Head of Security" (fallback contact). */
function parseLines(input: unknown): { domain: string; name?: string; contactName?: string; contactRole?: string }[] {
  const lines = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.split(/\r?\n|,(?=\s*[a-z0-9-]+\.)/i) : [];
  const out: { domain: string; name?: string; contactName?: string; contactRole?: string }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const [d, n, cn, cr] = line.split("|");
    const domain = normalizeDomain(d ?? "");
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({ domain, name: n?.trim().slice(0, 80) || undefined, contactName: cn?.trim().slice(0, 80) || undefined, contactRole: cr?.trim().slice(0, 100) || undefined });
  }
  return out;
}

/** Public. Visitors are limited per IP and per day (free-tier protection); the owner keeps a separate ceiling. */
export async function POST(req: Request) {
  const deps = liveDeps();
  const owner = isOwner(req);
  let body: { domains?: unknown; send?: unknown; mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseLines(body.domains);
  if (parsed.length === 0) return NextResponse.json({ error: "No valid domains found. Paste one domain per line, e.g. acme.com" }, { status: 400 });
  if (parsed.length > MAX_DOMAINS_PER_RUN) {
    return NextResponse.json({ error: `Please keep it to ${MAX_DOMAINS_PER_RUN} domains per run (you sent ${parsed.length}).` }, { status: 400 });
  }
  const gate = owner ? await allowOwnerRun(deps.store) : await allowRun(deps.store, clientIp(req));
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec ?? 3600) } });
  if (!owner) {
    const cg = await allowCompaniesToday(deps.store, parsed.length);
    if (!cg.ok) return NextResponse.json({ error: cg.reason }, { status: 429, headers: { "retry-after": String(cg.retryAfterSec ?? 3600) } });
  }

  const now = deps.now();
  const sendEnabled = body.send !== false;
  const run: RunRecord = { id: randomUUID(), mode: body.mode === "discover" ? "discover" : "paste", sendEnabled, companyIds: [], createdAt: now.toISOString(), owner, public: !owner };
  const companies = parsed.map((p, i) => {
    const c = newCompany(run.id, randomUUID(), p.domain, sendEnabled, new Date(now.getTime() + i), p.name, p.contactName && p.contactRole ? { name: p.contactName, role: p.contactRole } : undefined);
    c.owner = owner;
    return c;
  });
  run.companyIds = companies.map((c) => c.id);
  await deps.store.saveRun(run);
  for (const c of companies) await deps.store.saveCompany(c);
  return NextResponse.json({ run, companies: companies.map(stripPageText) });
}
