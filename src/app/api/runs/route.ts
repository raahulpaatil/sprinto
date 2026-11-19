import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { normalizeDomain } from "@/lib/fetcher";
import { allowRun, clientIp, MAX_DOMAINS_PER_RUN } from "@/lib/limits";
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
    out.push({
      domain,
      name: n?.trim().slice(0, 80) || undefined,
      contactName: cn?.trim().slice(0, 80) || undefined,
      contactRole: cr?.trim().slice(0, 100) || undefined,
    });
  }
  return out;
}

export async function POST(req: Request) {
  const deps = liveDeps();
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
  const gate = await allowRun(deps.store, clientIp(req));
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec ?? 3600) } });

  const now = deps.now();
  const sendEnabled = body.send !== false;
  const run: RunRecord = {
    id: randomUUID(),
    mode: body.mode === "discover" ? "discover" : "paste",
    sendEnabled,
    companyIds: [],
    createdAt: now.toISOString(),
  };
  const companies = parsed.map((p, i) => newCompany(run.id, randomUUID(), p.domain, sendEnabled, new Date(now.getTime() + i), p.name, p.contactName && p.contactRole ? { name: p.contactName, role: p.contactRole } : undefined));
  run.companyIds = companies.map((c) => c.id);
  await deps.store.saveRun(run);
  for (const c of companies) await deps.store.saveCompany(c);
  return NextResponse.json({ run, companies: companies.map(stripPageText) });
}
