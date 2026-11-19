// Test-only: runs the live scrape+extract for a domain, FORCES the decision to "fit" and a placeholder contact,
// then runs the live draft + grounding checks (Gmail is not configured locally, so nothing is sent).
import { MemoryStore } from "../src/lib/store";
import { draftAndSend, liveDeps, newCompany, processCompany } from "../src/lib/pipeline";

async function main() {
  const d = process.argv[2] ?? "mintlify.com";
  const deps = { ...liveDeps(), store: new MemoryStore() };
  const c = newCompany("smoke", `smoke-${d}`, d, true, new Date());
  await processCompany(c, deps);
  console.log(`${d}: natural decision = ${c.decision.result}`);
  c.decision.result = "fit"; // forced for this test only
  c.contact = { name: "Test Person", role: "Head of Security", source: "manual", why: "test placeholder" };
  await draftAndSend(c, deps);
  console.log("draft status:", c.draft?.status, "| hook grounded:", c.draft?.hookGrounded, "| send:", c.send?.status, "-", c.send?.note);
  console.log("problems:", c.draft?.problems.join(" ") || "none");
  console.log("\nSUBJECT:", c.draft?.subject, "\n\n" + c.draft?.body);
  console.log("\nHOOK:", c.draft?.hook, "\nHOOK QUOTE:", c.draft?.hookEvidence.quote);
  for (const p of c.pains ?? []) console.log(`PAIN: ${p.pain} [${p.certainty}] grounded=${p.grounded}\n  quote: ${p.evidence.quote.slice(0, 140)}`);
  console.log("UNCERTAIN:", c.draft?.uncertainFields.join("; "));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
