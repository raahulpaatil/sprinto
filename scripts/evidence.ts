// Prints the evidence behind a decision for one domain (local, SQLite, never sends).
import { MemoryStore } from "../src/lib/store";
import { liveDeps, newCompany, processCompany } from "../src/lib/pipeline";
async function main() {
  const d = process.argv[2];
  const deps = { ...liveDeps(), store: new MemoryStore() };
  const c = newCompany("ev", `ev-${d}`, d, false, new Date());
  c.sendEnabled = false;
  await processCompany(c, deps);
  const f = c.facts!;
  console.log(`${d}: ${c.decision.result} | flags: ${c.decision.flags.join(", ")}`);
  for (const k of ["company_name", "one_liner", "is_b2b_saas", "funding_stage", "employee_count", "open_roles", "enterprise_pricing"] as const) {
    const x = f[k]; console.log(`${k}: ${x.value} [${x.confidence}] ${x.evidence ? `"${x.evidence.quote.slice(0, 200)}" <${x.evidence.url}>` : ""}`);
  }
  console.log("certifications:", f.certifications.map((x) => `${x.name}:${x.status} "${x.evidence.quote}"`).join(" | ") || "none");
  console.log("signals:", f.signals.map((s) => `${s.text} <${s.evidence.url}>`).join(" | ") || "none");
  console.log("pages:", c.pages.map((p) => `${p.ok ? "OK " : "404"} ${p.kind} ${p.url}`).join("\n       "));
  console.log("dropped:", c.droppedClaims.join(" | ") || "none");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
