// Live smoke test: real websites + real Gemini. Hunter/Gmail run only if their env vars are set.
//   npm run smoke -- linear.app pizzahut.com
import { MemoryStore } from "../src/lib/store";
import { continueWithContact, liveDeps, newCompany, processCompany } from "../src/lib/pipeline";

async function main() {
  const domains = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (domains.length === 0) domains.push("pizzahut.com");
  const deps = { ...liveDeps(), store: new MemoryStore() };
  for (const d of domains) {
    const t0 = Date.now();
    const [hn, hr] = (process.env.SMOKE_HINT ?? "").split("|");
    const c = newCompany("smoke", `smoke-${d}`, d, true, new Date(), undefined, hn && hr ? { name: hn, role: hr } : undefined);
    c.sendEnabled = false; // smoke runs never send
    await processCompany(c, deps);
    if (process.env.SMOKE_OVERRIDE && c.decision.result === "manual_review") await continueWithContact(c, { name: "Test Person", role: "Head of Security" }, deps);
    console.log(`\n=== ${d} (${((Date.now() - t0) / 1000).toFixed(1)}s) status=${c.status} decision=${c.decision.result}`);
    if (c.error) console.log("ERROR:", c.error);
    console.log("reasons:", c.decision.reasons.join(" | "));
    if (c.decision.result === "manual_review") for (const r of c.decision.reasons) console.log("  reason:", r.slice(0, 400));
    console.log("flags:", c.decision.flags.join(", "), "| loops:", `${c.research.loops}/${c.research.cap}`, "| pages:", c.pages.map((p) => `${p.kind}${p.ok ? "" : "(x)"}`).join(","));
    const f = c.facts;
    if (f) {
      console.log("name:", f.company_name.value, "| saas:", f.is_b2b_saas.value, "| stage:", f.funding_stage.value, "| emp:", f.employee_count.value, "| roles:", f.open_roles.value, "| ent:", f.enterprise_pricing.value);
      console.log("certs:", f.certifications.map((x) => `${x.name}:${x.status}`).join(", ") || "none");
    }
    if (c.droppedClaims.length) console.log("dropped:", c.droppedClaims.length);
    console.log("contact:", c.contact ? `${c.contact.name} (${c.contact.role})` : c.contactSkip ?? "-");
    if (c.draft) {
      console.log("draft:", c.draft.status, "| hook grounded:", c.draft.hookGrounded, "| send:", c.send?.status, "| problems:", c.draft.problems.join(" ") || "none");
      console.log("subject:", c.draft.subject, "\n" + c.draft.body, "\nhook quote:", c.draft.hookEvidence.quote);
      for (const p of c.pains ?? []) console.log("pain:", p.pain, "| grounded:", p.grounded, "|", p.evidence.quote.slice(0, 100));
    }
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
