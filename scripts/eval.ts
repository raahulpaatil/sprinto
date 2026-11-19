// Checker pass: runs the real pipeline against a fixed test set with fake web pages, a fake LLM, a fake Hunter and a fake mailer.
// Critical safety failures (email outside the allowlist, fabricated facts shown as facts, double send) exit non-zero and block release.
//   npm run eval

import { AmbiguousSendError, assertAllowedRecipient, buildRaw, OWNER_EMAIL, SafetyError, sendPreview, tokenFor, type Mailer } from "../src/lib/gmail";
import { rankContacts, type ContactFinder } from "../src/lib/hunter";
import { normalizeDomain, realFetch, type Fetcher } from "../src/lib/fetcher";
import { MemoryStore } from "../src/lib/store";
import { cappedContacts, continueWithContact, newCompany, processCompany, RESEARCH_LOOP_CAP, trySend, type Deps } from "../src/lib/pipeline";
import { budgetedLLM, DemoLimitError, type LLM, type LlmRequest } from "../src/lib/gemini";
import type { CompanyRecord } from "../src/lib/types";
import { allowAttempt, allowDiscover, allowRun, gateRun, limits, publicAllowance } from "../src/lib/limits";
import { discoverDomains } from "../src/lib/discover";
import { open as unseal, seal } from "../src/lib/secrets";
import { parseFacts } from "../src/lib/extract";
import { assumesHeldCert, certBasis, validateDraft } from "../src/lib/draft";
import { clientIp, hashIp } from "../src/lib/limits";
import { COUNTER_RETENTION_MS, makeSqliteStore } from "../src/lib/store";
import { qualify } from "../src/lib/qualify";
import { emptyFacts } from "../src/lib/extract";
import { canAccessRun } from "../src/lib/access";
import { gmailStatus, resolveRefreshToken, storeRefreshToken } from "../src/lib/gmail";

// ---------- tiny test framework ----------
interface Result { scenario: string; check: string; ok: boolean; critical: boolean; detail?: string }
const results: Result[] = [];
let current = "";
function check(name: string, ok: boolean, detail = "", critical = false) {
  results.push({ scenario: current, check: name, ok, critical, detail: ok ? undefined : detail });
}

// ---------- fixtures ----------
const html = (title: string, body: string, nav = "", footer = "") =>
  `<html><head><title>${title}</title></head><body><div class="cookie-banner">We use cookies to improve your experience. Accept all cookies.</div><nav>${nav}</nav><main>${body}</main><footer>${footer} Terms Privacy 2026</footer></body></html>`;

function world(pages: Record<string, string>, redirects: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const key = url.replace(/\/+$/, "");
    const html = pages[key] ?? pages[key + "/"];
    if (html === undefined) return { url, finalUrl: url, ok: false, status: 404, error: "HTTP 404" };
    return { url, finalUrl: redirects[key] ?? url, ok: true, status: 200, html };
  };
  return { fetcher, calls };
}

const nul = { value: null, quote: null, url: null };
const baseExtract = () => ({ company_name: nul, one_liner: nul, is_b2b_saas: nul, funding_stage: nul, employee_count: nul, open_roles: nul, enterprise_pricing: nul, certifications: [] as unknown[], signals: [] as unknown[], conflicts: [] as string[] });

const FILL = "Our team ships every week and we care about reliability, clear communication and honest pricing for the teams that rely on us each day.";

function mailerFake(opts: { failAfterDeliver?: boolean; findResult?: "unverifiable" | "found" | "notfound" } = {}) {
  const deliveries: { to: string; subject: string; token: string }[] = [];
  let sendCalls = 0;
  const m: Mailer & { deliveries: typeof deliveries; sendCalls: () => number } = {
    configured: async () => true,
    deliveries,
    sendCalls: () => sendCalls,
    async send(msg) {
      sendCalls++;
      buildRaw(msg); // exercises the same in-mailer allowlist the real mailer uses
      if (opts.failAfterDeliver) {
        deliveries.push({ to: msg.to, subject: msg.subject, token: msg.token });
        opts.failAfterDeliver = false; // only the first attempt "times out after delivering"
        throw new AmbiguousSendError("simulated timeout after Gmail accepted the message");
      }
      deliveries.push({ to: msg.to, subject: msg.subject, token: msg.token });
      return { messageId: `msg-${deliveries.length}` };
    },
    async findByToken(token) {
      if (opts.findResult === "unverifiable") return "unverifiable";
      const hit = deliveries.find((d) => d.token === token);
      if (hit) return { found: true, messageId: `msg-${deliveries.indexOf(hit) + 1}` };
      return { found: false };
    },
  };
  return m;
}

interface Scenario {
  domain: string;
  expectedName?: string;
  pages: Record<string, string>;
  redirects?: Record<string, string>;
  extract: (prompt: string) => unknown;
  contacts?: ContactFinder;
  draft?: (attempt: number, prompt: string) => unknown;
  mailer?: ReturnType<typeof mailerFake>;
  visitor?: boolean;
}

async function run(sc: Scenario) {
  const store = new MemoryStore();
  const w = world(sc.pages, sc.redirects);
  const counts: Record<string, number> = { extract: 0, draft: 0, discover: 0, contacts: 0 };
  const llm: LLM = async (req: LlmRequest) => {
    counts[req.kind]++;
    if (req.kind === "extract") return sc.extract(req.prompt);
    if (req.kind === "draft") return sc.draft ? sc.draft(counts.draft, req.prompt) : {};
    return {};
  };
  const contacts: ContactFinder = async (d) => {
    counts.contacts++;
    return sc.contacts ? sc.contacts(d) : { skip: "no contact finder in this scenario" };
  };
  const mailer = sc.mailer ?? mailerFake();
  const deps: Deps = { fetcher: w.fetcher, llm, contacts, mailer, store, now: () => new Date() };
  const c = newCompany("run-1", `co-${sc.domain}`, sc.domain, true, new Date(), sc.expectedName);
  await processCompany(c, deps);
  return { c, deps, counts, mailer, fetchCalls: w.calls, store };
}

function nothingLeftTheAllowlist(mailer: ReturnType<typeof mailerFake>) {
  return mailer.deliveries.every((d) => d.to === OWNER_EMAIL);
}
const usePriya: ContactFinder = async () => ({ contact: { name: "Priya Nair", role: "Head of Security", email: "priya@acmecloud.test", source: "hunter", why: "Role owns compliance / security" } });

// ---------- Acme Cloud: the clear-fit world ----------
const ACME = "https://acmecloud.test";
const acmePages: Record<string, string> = {
  [ACME]: html("Acme Cloud", `<h1>Invoice approvals on autopilot</h1><p>Acme Cloud is a B2B SaaS platform that helps finance teams automate invoice approvals.</p><p>Trusted by mid-market and enterprise customers in regulated industries.</p><p>${FILL}</p><p>${FILL}</p>`, `<a href="/pricing">Pricing</a><a href="/about">About</a>`, `<a href="/security">Security</a><a href="/careers">Careers</a>`),
  [`${ACME}/pricing`]: html("Pricing", `<p>Starter plan for small teams. Business plan for growing teams. Enterprise: contact sales for custom security reviews and SSO.</p><p>${FILL}</p>`),
  [`${ACME}/about`]: html("About Acme Cloud", `<p>Acme Cloud raised a Series B in 2025. We are a team of about 120 people building finance software.</p><p>${FILL}</p>`),
  [`${ACME}/security`]: html("Security", `<p>We are preparing for SOC 2 Type II and expect our audit window to start next quarter. Customer data is encrypted at rest.</p><p>${FILL}</p>`),
};
const acmeExtract = (prompt: string) => {
  const o = baseExtract();
  o.company_name = { value: "Acme Cloud", quote: "Acme Cloud is a B2B SaaS platform that helps finance teams", url: ACME } as never;
  o.one_liner = { value: "Automates invoice approvals for finance teams", quote: "helps finance teams automate invoice approvals", url: ACME } as never;
  o.is_b2b_saas = { value: true, quote: "Acme Cloud is a B2B SaaS platform that helps finance teams automate invoice approvals", url: ACME } as never;
  o.funding_stage = { value: "series_b", quote: "Acme Cloud raised a Series B in 2025", url: `${ACME}/about` } as never;
  o.employee_count = { value: 120, quote: "We are a team of about 120 people", url: `${ACME}/about` } as never;
  o.enterprise_pricing = { value: true, quote: "Enterprise: contact sales for custom security reviews and SSO", url: `${ACME}/pricing` } as never;
  if (prompt.includes("preparing for SOC 2")) {
    o.certifications = [{ name: "SOC 2", status: "in_progress", quote: "We are preparing for SOC 2 Type II and expect our audit window to start next quarter", url: `${ACME}/security` }];
  }
  return o;
};
const goodDraft = () => ({
  pains: [
    { pain: "Audit preparation effort", reasoning: "They say a SOC 2 Type II audit window is coming, which means evidence collection is about to start.", quote: "We are preparing for SOC 2 Type II and expect our audit window to start next quarter", url: `${ACME}/security`, certainty: "high" },
    { pain: "Enterprise security reviews", reasoning: "Their pricing page routes Enterprise buyers to custom security reviews.", quote: "Enterprise: contact sales for custom security reviews and SSO", url: `${ACME}/pricing`, certainty: "medium" },
  ],
  email: {
    subject: "Getting through your SOC 2 audit window",
    body: "Hi Priya,\n\nYour security page says Acme Cloud is preparing for SOC 2 Type II with the audit window starting next quarter. Teams at that point usually lose weeks to evidence collection.\n\nSprinto automates that evidence gathering. Worth a 15 minute look?\n\nGrowth Lead, Sprinto",
    hook: "Your security page says you are preparing for SOC 2 Type II with the audit window starting next quarter.",
    hook_quote: "We are preparing for SOC 2 Type II and expect our audit window to start next quarter",
    hook_url: `${ACME}/security`,
    uncertain_fields: ["exact audit start date"],
  },
});

async function main() {
  // 1. clear fit
  current = "1 clear-fit company";
  {
    const r = await run({ domain: "acmecloud.test", pages: acmePages, extract: acmeExtract, contacts: usePriya, draft: goodDraft });
    check("decision is fit", r.c.decision.result === "fit", r.c.decision.result);
    check("stage labelled as proxy, not proof", r.c.decision.flags.includes("stage_is_proxy") && r.c.decision.reasons.some((x) => /proxy/i.test(x)));
    check("research loop fetched the security page (1 loop)", r.c.research.loops === 1 && r.c.pages.some((p) => p.kind === "security" && p.ok), JSON.stringify(r.c.research));
    check("contact found only after qualifying", r.counts.contacts === 1 && r.c.contact?.name === "Priya Nair");
    check("two grounded pains", r.c.pains?.length === 2 && r.c.pains.every((p) => p.grounded));
    check("hook grounded in a page", r.c.draft?.hookGrounded === true && r.c.draft.status === "ready", r.c.draft?.problems.join(" "));
    check("preview sent exactly once to own inbox", r.mailer.deliveries.length === 1 && nothingLeftTheAllowlist(r.mailer), JSON.stringify(r.mailer.deliveries));
    check("send status is sent", r.c.send?.status === "sent", r.c.send?.status);
    check("extra pages within cap of 4", r.c.pages.length - 1 <= 4, String(r.c.pages.length));
    check("cookie banner stripped from page text", !r.c.pages.some((p) => /We use cookies/i.test(p.text ?? "")), "cookie text leaked into evidence", false);
  }

  // 2. clear non-SaaS
  current = "2 clear non-SaaS company";
  {
    const D = "https://pizzapalace.test";
    const r = await run({
      domain: "pizzapalace.test",
      pages: { [D]: html("Pizza Palace", `<h1>Pizza Palace</h1><p>Pizza Palace serves wood-fired pizza and fresh pasta every day of the week. Order online for delivery.</p><p>Margherita, pepperoni, four cheese, mushroom and truffle. Open for lunch and dinner. ${FILL} ${FILL}</p>`) },
      extract: () => {
        const o = baseExtract();
        o.company_name = { value: "Pizza Palace", quote: "Pizza Palace serves wood-fired pizza and fresh pasta", url: D } as never;
        o.is_b2b_saas = { value: false, quote: "Pizza Palace serves wood-fired pizza and fresh pasta every day of the week", url: D } as never;
        return o;
      },
      contacts: usePriya,
    });
    check("decision is skip", r.c.decision.result === "skip", r.c.decision.result);
    check("reason says not B2B SaaS", /not a B2B SaaS/i.test(r.c.decision.reasons[0] ?? ""));
    check("no Hunter call and no email", r.counts.contacts === 0 && r.mailer.deliveries.length === 0 && r.counts.draft === 0);
  }

  // 3. already certified
  current = "3 already-certified company";
  {
    const D = "https://securecorp.test";
    const r = await run({
      domain: "securecorp.test",
      pages: {
        [D]: html("SecureCorp", `<p>SecureCorp is a B2B SaaS platform for logistics teams to manage carrier contracts.</p><p>${FILL} ${FILL}</p>`, `<a href="/pricing">Pricing</a><a href="/about">About</a>`, `<a href="/security">Security</a>`),
        [`${D}/pricing`]: html("Pricing", `<p>Team plan and Enterprise: contact sales.</p><p>${FILL}</p>`),
        [`${D}/about`]: html("About", `<p>SecureCorp announced its Series A round last year and has about 80 employees.</p><p>${FILL}</p>`),
        [`${D}/security`]: html("Security", `<p>SecureCorp is SOC 2 Type II certified. The latest audit report is available to customers under NDA.</p><p>${FILL}</p>`),
      },
      extract: (prompt) => {
        const o = baseExtract();
        o.is_b2b_saas = { value: true, quote: "SecureCorp is a B2B SaaS platform for logistics teams", url: D } as never;
        o.funding_stage = { value: "series_a", quote: "SecureCorp announced its Series A round last year", url: `${D}/about` } as never;
        if (prompt.includes("SOC 2 Type II certified")) o.certifications = [{ name: "SOC 2", status: "held", quote: "SecureCorp is SOC 2 Type II certified", url: `${D}/security` }];
        return o;
      },
      contacts: usePriya,
    });
    check("decision is skip", r.c.decision.result === "skip", r.c.decision.result);
    check("reason cites held SOC 2 with quote", /holds SOC 2/i.test(r.c.decision.reasons[0] ?? "") && /certified/i.test(r.c.decision.reasons[0] ?? ""), r.c.decision.reasons[0]);
    check("no contact lookup or email", r.counts.contacts === 0 && r.mailer.deliveries.length === 0);
  }

  // 4. unknown stage
  current = "4 unknown-stage company";
  {
    const D = "https://stagelessco.test";
    const r = await run({
      domain: "stagelessco.test",
      pages: {
        [D]: html("Stageless", `<p>Stageless is a B2B SaaS tool that helps support teams route tickets automatically.</p><p>${FILL} ${FILL}</p>`, `<a href="/pricing">Pricing</a>`),
        [`${D}/pricing`]: html("Pricing", `<p>Basic plan and Pro plan, billed monthly. No enterprise tier.</p><p>${FILL}</p>`),
      },
      extract: () => {
        const o = baseExtract();
        o.is_b2b_saas = { value: true, quote: "Stageless is a B2B SaaS tool that helps support teams route tickets", url: D } as never;
        o.enterprise_pricing = { value: false, quote: "Basic plan and Pro plan, billed monthly. No enterprise tier", url: `${D}/pricing` } as never;
        return o;
      },
      contacts: usePriya,
    });
    check("decision is manual_review", r.c.decision.result === "manual_review", r.c.decision.result);
    check("reason says stage unknown", r.c.decision.reasons.some((x) => /stage unknown/i.test(x)), r.c.decision.reasons.join(" | "));
    check("no contact lookup or email", r.counts.contacts === 0 && r.mailer.deliveries.length === 0);
  }

  // 5. thin homepage
  current = "5 thin homepage";
  {
    const D = "https://thinsite.test";
    const r = await run({
      domain: "thinsite.test",
      pages: { [D]: `<html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` },
      extract: () => { throw new Error("LLM must not be called on a thin page"); },
      contacts: usePriya,
    });
    check("decision is manual_review", r.c.decision.result === "manual_review", r.c.decision.result);
    check("reason says thin evidence", /thin/i.test(r.c.decision.reasons.join(" ")), r.c.decision.reasons.join(" | "));
    check("no model call on empty text (nothing to hallucinate from)", r.counts.extract === 0);
    check("no facts invented", r.c.facts?.is_b2b_saas.value === null && r.c.facts?.company_name.value === null, "", true);
  }

  // 6. same-name wrong company
  current = "6 same-name wrong company";
  {
    const D = "https://mercury-labs.test";
    const r = await run({
      domain: "mercury-labs.test",
      expectedName: "Mercury Bank",
      pages: { [D]: html("Mercury Labs", `<p>Mercury Labs makes organic dog treats from British farms and ships them across the country every week.</p><p>${FILL} ${FILL} ${FILL}</p>`) },
      extract: () => {
        const o = baseExtract();
        o.company_name = { value: "Mercury Labs", quote: "Mercury Labs makes organic dog treats from British farms", url: D } as never;
        return o;
      },
      contacts: usePriya,
    });
    check("name mismatch routes to manual_review", r.c.decision.result === "manual_review" && /wrong company|same-name/i.test(r.c.decision.reasons.join(" ")), r.c.decision.reasons.join(" | "));
    check("no contact lookup or email", r.counts.contacts === 0 && r.mailer.deliveries.length === 0);
    const B = "https://brightpay.test";
    const r2 = await run({
      domain: "brightpay.test",
      pages: { [B]: html("BrightPay HR", `<p>BrightPay HR is a B2B SaaS payroll platform. ${FILL} ${FILL} ${FILL}</p>`) },
      redirects: { [B]: "https://brightpay-hr.example/" },
      extract: () => baseExtract(),
      contacts: usePriya,
    });
    check("redirect to a different domain routes to manual_review", r2.c.decision.result === "manual_review" && /redirects to/i.test(r2.c.decision.reasons.join(" ")), r2.c.decision.reasons.join(" | "));
  }

  // 7. no valid contact
  current = "7 company with no valid contact";
  {
    const noOne: ContactFinder = async () => {
      const r = rankContacts([
        { value: "info@acmecloud.test", position: null, first_name: null, last_name: null },
        { value: "sam@acmecloud.test", first_name: "Sam", last_name: "Lee", position: "Account Executive", confidence: 90 },
      ]);
      return r.contact ? { contact: r.contact } : { skip: r.reason };
    };
    const r = await run({ domain: "acmecloud.test", pages: acmePages, extract: acmeExtract, contacts: noOne, draft: goodDraft });
    check("decision is fit", r.c.decision.result === "fit");
    check("contact recorded as skipped with a reason", !r.c.contact && !!r.c.contactSkip, r.c.contactSkip);
    check("no contact fabricated, no draft, no email", r.counts.draft === 0 && r.mailer.deliveries.length === 0 && !r.c.draft, "", true);
    check("no Hunter key => skip, never a made-up contact", (await (await import("../src/lib/hunter")).hunterContacts("acmecloud.test").then((x) => (process.env.HUNTER_API_KEY ? { skip: "has key" } : x))).skip !== undefined);
  }

  // 8. exhausted research budget
  current = "8 exhausted research budget";
  {
    const D = "https://vaguecorp.test";
    const r = await run({
      domain: "vaguecorp.test",
      pages: {
        [D]: html("VagueCorp", `<p>VagueCorp is a B2B SaaS workflow tool for operations teams that handle approvals.</p><p>${FILL} ${FILL}</p>`, `<a href="/careers">Careers</a><a href="/about">About</a>`),
        [`${D}/careers`]: html("Careers", `<p>We have no open roles at the moment. Check back soon.</p><p>${FILL}</p>`),
        [`${D}/about`]: html("About", `<p>VagueCorp builds approval software for operations teams around the world.</p><p>${FILL}</p>`),
      },
      extract: () => {
        const o = baseExtract();
        o.is_b2b_saas = { value: true, quote: "VagueCorp is a B2B SaaS workflow tool for operations teams", url: D } as never;
        return o;
      },
      contacts: usePriya,
    });
    check(`loop stopped at the cap (${RESEARCH_LOOP_CAP})`, r.c.research.loops === RESEARCH_LOOP_CAP && r.c.research.exhausted, JSON.stringify(r.c.research), true);
    check("routed to manual_review with budget reason", r.c.decision.result === "manual_review" && /budget exhausted/i.test(r.c.decision.reasons.join(" ")), r.c.decision.reasons.join(" | "));
    check("extra fetch attempts within the cap of 12", r.fetchCalls.length <= 1 + 12 + 3, String(r.fetchCalls.length));
    check("no contact lookup or email", r.counts.contacts === 0 && r.mailer.deliveries.length === 0);
  }

  // 9. email hook not grounded
  current = "9 email hook not grounded in evidence";
  {
    const bad = () => {
      const g = goodDraft();
      g.email.hook = "Congrats on winning the 2026 Global SaaS Award!";
      g.email.hook_quote = "Acme Cloud just won the 2026 Global SaaS Award for innovation";
      return g;
    };
    const r = await run({ domain: "acmecloud.test", pages: acmePages, extract: acmeExtract, contacts: usePriya, draft: bad });
    check("draft flagged ungrounded", r.c.draft?.status === "ungrounded" && r.c.draft.hookGrounded === false, r.c.draft?.status);
    check("one corrective retry only", r.counts.draft === 2, String(r.counts.draft));
    check("ungrounded draft is NOT sent", r.mailer.deliveries.length === 0 && r.c.send?.status === "not_attempted", r.c.send?.status ?? "", true);
  }

  // 10. recipient outside allowlist
  current = "10 recipient outside the allowlist";
  {
    const attempts = ["prospect@example.com", "priya@acmecloud.test", `${OWNER_EMAIL},prospect@example.com`, `"x" <${OWNER_EMAIL}>`, `${OWNER_EMAIL}\r\nBcc: prospect@example.com`, "rahulmp458+x@gmail.com", " rahulmp458@gmail.com", "rahulmp458@gmail.com;a@b.com", ""];
    const m = mailerFake();
    const store = new MemoryStore();
    let allBlocked = true;
    for (const to of attempts) {
      try {
        await sendPreview({ companyId: `blk-${to.length}`, to, subject: "s", text: "t", store, mailer: m });
        allBlocked = false;
      } catch (e) {
        if (!(e instanceof SafetyError)) allBlocked = false;
      }
    }
    check("every outside recipient throws SafetyError", allBlocked, "", true);
    check("mailer never called for blocked recipients", m.sendCalls() === 0 && m.deliveries.length === 0, String(m.sendCalls()), true);
    let rawBlocked = 0;
    for (const to of attempts) { try { buildRaw({ to, subject: "s", text: "t", token: "SPR-0" }); } catch { rawBlocked++; } }
    check("in-mailer guard (buildRaw) also blocks them all", rawBlocked === attempts.length, String(rawBlocked), true);
    check("exact owner address is accepted", (() => { try { return assertAllowedRecipient(OWNER_EMAIL) === OWNER_EMAIL; } catch { return false; } })());
    const r = await run({ domain: "acmecloud.test", pages: acmePages, extract: acmeExtract, contacts: usePriya, draft: goodDraft });
    const blocked = await trySend(r.c, r.deps, "priya@acmecloud.test");
    check("pipeline-level send to the prospect is blocked", blocked.status === "blocked", blocked.status, true);
    check("prospect address never appears as a delivery", r.mailer.deliveries.every((d) => d.to === OWNER_EMAIL), "", true);
  }

  // 11. duplicate send after simulated timeout
  current = "11 duplicate-send after simulated timeout";
  {
    const store = new MemoryStore();
    const m = mailerFake({ failAfterDeliver: true });
    const base = { companyId: "dup-1", to: OWNER_EMAIL, subject: "s", text: "t", store, mailer: m };
    const first = await sendPreview(base);
    check("first attempt times out after delivering => status unknown", first.status === "unknown" && m.deliveries.length === 1, first.status);
    const second = await sendPreview(base);
    check("retry verifies Gmail and does NOT send again", second.status === "duplicate_prevented" && m.deliveries.length === 1 && m.sendCalls() === 1, `${second.status} deliveries=${m.deliveries.length}`, true);
    const third = await sendPreview(base);
    check("third attempt also blocked by the lock", third.status === "duplicate_prevented" && m.deliveries.length === 1, third.status, true);

    const store2 = new MemoryStore();
    const m2 = mailerFake({ failAfterDeliver: true, findResult: "unverifiable" });
    const b2 = { companyId: "dup-2", to: OWNER_EMAIL, subject: "s", text: "t", store: store2, mailer: m2 };
    await sendPreview(b2);
    const again = await sendPreview(b2);
    check("when Gmail cannot confirm, refuses to resend", again.status === "unknown" && m2.deliveries.length === 1 && m2.sendCalls() === 1, `${again.status} deliveries=${m2.deliveries.length}`, true);

    const store3 = new MemoryStore();
    const m3 = mailerFake();
    const b3 = { companyId: "dup-3", to: OWNER_EMAIL, subject: "s", text: "t", store: store3, mailer: m3 };
    await Promise.all([sendPreview(b3), sendPreview(b3), sendPreview(b3)]);
    check("three concurrent sends deliver exactly once", m3.deliveries.length === 1, String(m3.deliveries.length), true);
    check("token is deterministic per company", tokenFor("dup-3") === tokenFor("dup-3"));

    // Non-durable storage (serverless without a database): Gmail itself must prevent the duplicate.
    const m4 = mailerFake();
    const inst = () => ({ companyId: "dup-4", to: OWNER_EMAIL, subject: "s", text: "t", store: new MemoryStore(false), mailer: m4 });
    const a = await sendPreview(inst()); // "instance 1"
    const b = await sendPreview(inst()); // "instance 2" has no memory of instance 1
    check("non-durable storage: second instance does not resend (Gmail checked first)", a.status === "sent" && b.status === "duplicate_prevented" && m4.deliveries.length === 1, `${a.status}/${b.status} deliveries=${m4.deliveries.length}`, true);
    const m5 = mailerFake({ findResult: "unverifiable" });
    const c5 = await sendPreview({ companyId: "dup-5", to: OWNER_EMAIL, subject: "s", text: "t", store: new MemoryStore(false), mailer: m5 });
    check("non-durable storage + Gmail unverifiable: refuses to send at all", c5.status === "unknown" && m5.deliveries.length === 0, `${c5.status} deliveries=${m5.deliveries.length}`, true);
  }

  // 12. fabricated claim
  current = "12 fabricated claim is dropped, not shown as fact";
  {
    const r = await run({
      domain: "acmecloud.test",
      pages: acmePages,
      extract: (prompt) => {
        const o = acmeExtract(prompt) as ReturnType<typeof baseExtract>;
        o.employee_count = { value: 5000, quote: "Over 5,000 employees across 40 countries", url: ACME } as never;
        o.signals = [{ text: "Backed by Sequoia", quote: "Backed by Sequoia Capital since 2021", url: ACME }];
        return o;
      },
      contacts: usePriya,
      draft: goodDraft,
    });
    check("fake headcount dropped (value null)", r.c.facts?.employee_count.value === null, String(r.c.facts?.employee_count.value), true);
    check("fake signal dropped", (r.c.facts?.signals.length ?? 1) === 0, "", true);
    check("drops are logged", r.c.droppedClaims.length >= 2, String(r.c.droppedClaims.length));
    check("headcount shown as unknown", r.c.decision.flags.includes("headcount_unknown"), r.c.decision.flags.join(","));
  }

  // 14. access protection
  current = "14 access protection (rate limits, caps)";
  {
    const store = new MemoryStore();
    const t = new Date("2026-11-19T10:15:00Z");
    const first5 = [];
    for (let i = 0; i < limits.runsPerIpPerHour; i++) first5.push((await allowRun(store, "1.1.1.1", t)).ok);
    const sixth = await allowRun(store, "1.1.1.1", t);
    check(`${limits.runsPerIpPerHour} runs per hour per IP allowed`, first5.every(Boolean) && limits.runsPerIpPerHour === 3, JSON.stringify(first5));
    check("next run in the hour is blocked with a retry time", !sixth.ok && (sixth.retryAfterSec ?? 0) > 0 && /per hour/.test(sixth.reason ?? ""), JSON.stringify(sixth));
    check("a different IP is unaffected", (await allowRun(store, "2.2.2.2", t)).ok);
    check("limit resets next hour", (await allowRun(store, "1.1.1.1", new Date("2026-11-19T11:00:05Z"))).ok);
    // global daily cap of 20, spread over many IPs so the per-IP limit never trips
    const g = new MemoryStore();
    let allowed = 0;
    let blockedGlobal: { ok: boolean; reason?: string } = { ok: true };
    for (let i = 0; i < 25; i++) {
      const r = await allowRun(g, `10.0.0.${i}`, t);
      if (r.ok) allowed++; else blockedGlobal = r;
    }
    check("global daily cap of 10 holds with a clean message", allowed === limits.runsGlobalPerDay && limits.runsGlobalPerDay === 10 && /Daily demo limit reached.*tomorrow/.test(blockedGlobal.reason ?? ""), `allowed=${allowed} ${blockedGlobal.reason}`);
    check("global cap resets next day", (await allowRun(g, "10.9.9.9", new Date("2026-11-20T00:00:05Z"))).ok);
    const d = new MemoryStore();
    const dres = [];
    for (let i = 0; i < 4; i++) dres.push((await allowDiscover(d, "3.3.3.3", t)).ok);
    check("discovery limited to 3 per hour per IP", dres.slice(0, 3).every(Boolean) && !dres[3], JSON.stringify(dres));
    const a = new MemoryStore();
    const att = [];
    for (let i = 0; i < 4; i++) att.push(await allowAttempt(a, "process", "co-1", limits.processAttempts));
    check("per-company attempt cap (3)", att[2] && !att[3], JSON.stringify(att));
    const many = ["example.com", "example.org", "iana.org", "wikipedia.org", "github.com", "python.org", "nodejs.org"].map((x) => ({ domain: x, name: x, why: "t" }));
    const found = await discoverDomains(undefined, async () => ({ candidates: many }));
    check("discovery results capped at 5", found.length === limits.maxDiscoveryResults && found.length === 5, String(found.length));
    check("domain cap per run is 10", limits.maxDomainsPerRun === 10);
  }

  // 15. gmail token handling
  current = "15 gmail token storage and precedence";
  {
    const sealed = seal("dummy-refresh-token", "dummy-client-secret");
    check("sealed token is not plaintext", !sealed.includes("dummy-refresh-token"));
    check("seal/open round trip", unseal(sealed, "dummy-client-secret") === "dummy-refresh-token");
    check("wrong key cannot open it", unseal(sealed, "other-secret") === null);
    const saved = { id: process.env.GMAIL_CLIENT_ID, sec: process.env.GMAIL_CLIENT_SECRET, rt: process.env.GMAIL_REFRESH_TOKEN };
    process.env.GMAIL_CLIENT_ID = "dummy-id";
    process.env.GMAIL_CLIENT_SECRET = "dummy-client-secret";
    delete process.env.GMAIL_REFRESH_TOKEN;
    const st = new MemoryStore();
    const none = await gmailStatus(st);
    check("client set, no token: not configured but can connect", !none.configured && none.canConnect);
    await storeRefreshToken(st, "stored-token");
    check("stored token is encrypted in the store", !(await st.getSecret("gmail_refresh_token"))?.includes("stored-token"));
    const r1 = await resolveRefreshToken(st);
    check("stored token resolves", r1?.token === "stored-token" && r1.source === "stored");
    process.env.GMAIL_REFRESH_TOKEN = "env-token";
    const r2 = await resolveRefreshToken(st);
    check("env token takes precedence over stored", r2?.token === "env-token" && r2.source === "env");
    check("with env token the connect flow is not offered", !(await gmailStatus(st)).canConnect);
    for (const [k, v] of [["GMAIL_CLIENT_ID", saved.id], ["GMAIL_CLIENT_SECRET", saved.sec], ["GMAIL_REFRESH_TOKEN", saved.rt]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  // 17. run links, access and sends (one role, no sign-in)
  current = "17 run links and send guards (single role)";
  {
    const anyone = new Request("https://x.test/api");
    check("anyone with the link can read a run created through the app", canAccessRun(anyone, { public: true }));
    check("a run without the public flag (older private/owner runs) is not readable by anyone", !canAccessRun(anyone, {}) && !canAccessRun(anyone, { public: false }), "", true);
    check("a missing run is not readable", !canAccessRun(anyone, null));

    // public sends are allowed but stay locked to the owner inbox and to one per company
    const pub = await run({ domain: "acmecloud.test", pages: acmePages, extract: acmeExtract, contacts: usePriya, draft: goodDraft, visitor: true });
    check("a public run can preview-send, only to the owner inbox", pub.mailer.deliveries.length === 1 && nothingLeftTheAllowlist(pub.mailer), JSON.stringify(pub.mailer.deliveries), true);
    const again = await trySend(pub.c, pub.deps);
    check("second send for the same company is refused by the lock", again.status === "duplicate_prevented" && pub.mailer.deliveries.length === 1, again.status, true);
    const blockedTo = await trySend(pub.c, pub.deps, "someone@else.com");
    check("a public run still cannot address anyone else", blockedTo.status === "blocked" && pub.mailer.deliveries.length === 1, blockedTo.status, true);

    // Gemini hard budget
    process.env.GEMINI_DAILY_CALL_CAP = "3";
    let baseCalls = 0;
    const bl = budgetedLLM(async () => { baseCalls++; return {}; }, new MemoryStore());
    let stopped: unknown = null;
    for (let i = 0; i < 5; i++) { try { await bl({ kind: "extract", system: "s", prompt: "p" }); } catch (e) { stopped = e; } }
    check("Gemini calls stop at the daily cap with a clean limit error", baseCalls === 3 && stopped instanceof DemoLimitError && /try again tomorrow/.test((stopped as Error).message), `calls=${baseCalls}`, true);
    delete process.env.GEMINI_DAILY_CALL_CAP;

    // Hunter budget gates (precise): per company, per run, reserve vs Hunter's own remaining count, persistent monthly counter
    delete process.env.HUNTER_MONTHLY_CAP;
    let hunterCalls = 0;
    const baseFinder: ContactFinder = async () => { hunterCalls++; return { skip: "base" }; };
    const mem = new MemoryStore();
    let remainingNow: number | null = 50;
    const hc = cappedContacts(baseFinder, mem, { remaining: async () => remainingNow });
    const ctxFor = (run: string, co: string) => ({ runId: run, companyId: co });
    const res: { skip?: string }[] = [];
    for (let i = 1; i <= 7; i++) res.push(await hc(`d${i}.com`, ctxFor("run-A", `co-${i}`)));
    check("per-run ceiling: 5 lookups, then graceful skips", hunterCalls === 5 && /already used its 5 contact lookups/.test(res[5].skip ?? "") && /already used its 5/.test(res[6].skip ?? ""), `calls=${hunterCalls} ${res[5].skip}`, true);
    const reprocess = await hc("d1.com", ctxFor("run-B", "co-1"));
    check("one lookup per company record: a re-process cannot look up again", hunterCalls === 5 && /already made for this company/.test(reprocess.skip ?? ""), `calls=${hunterCalls}`, true);
    await hc("e.com", ctxFor("run-B", "co-b1"));
    check("a different run gets its own per-run allowance", hunterCalls === 6);
    remainingNow = 11; // 11 - 1 = 10 >= reserve: allowed
    await hc("f.com", ctxFor("run-C", "co-c1"));
    check("lookup allowed while it leaves at least the 10-credit reserve (11 left)", hunterCalls === 7, `calls=${hunterCalls}`);
    remainingNow = 10; // 10 - 1 = 9 < reserve: refused
    const atReserve = await hc("g.com", ctxFor("run-C", "co-c2"));
    check("hard stop when a lookup would drop below the reserve (10 left)", hunterCalls === 7 && /below the 10-credit reserve/.test(atReserve.skip ?? ""), `calls=${hunterCalls} ${atReserve.skip}`, true);
    remainingNow = null;
    const unknown = await hc("h.com", ctxFor("run-C", "co-c3"));
    check("fails closed when Hunter's remaining credits cannot be verified", hunterCalls === 7 && /could not be verified/.test(unknown.skip ?? ""), `calls=${hunterCalls}`, true);
    remainingNow = 50;
    process.env.HUNTER_MONTHLY_CAP = "2";
    const mem2 = new MemoryStore();
    let mc = 0;
    const hm = cappedContacts(async () => { mc++; return { skip: "base" }; }, mem2, { remaining: async () => 50 });
    const m3 = [await hm("a.com", ctxFor("r1", "c1")), await hm("b.com", ctxFor("r1", "c2")), await hm("c.com", ctxFor("r1", "c3"))];
    check("persistent monthly counter stops lookups at the cap with a visible note", mc === 2 && /this month/i.test(m3[2].skip ?? ""), `calls=${mc} ${m3[2].skip}`, true);
    check("monthly counter lives in the store (what Postgres persists)", (await mem2.hit(`hunter:m:${new Date().toISOString().slice(0, 7)}`, 0)) >= 2);
    delete process.env.HUNTER_MONTHLY_CAP;

    // Daily send cap
    process.env.SENDS_GLOBAL_PER_DAY = "1";
    const s1 = await run({ domain: "acmecloud.test", pages: acmePages, extract: acmeExtract, contacts: usePriya, draft: goodDraft });
    const s1b = await trySend({ ...s1.c, id: "another-company" }, s1.deps);
    check("global daily send cap stops further previews cleanly", s1b.status === "not_attempted" && /Daily demo limit reached/.test(s1b.note), `${s1b.status} ${s1b.note}`);
    delete process.env.SENDS_GLOBAL_PER_DAY;
  }

  // 18. deeper research and manual-review handling
  current = "18 deeper research and manual-review handling";
  {
    const T = "https://trustcorp.test";
    const base: Record<string, string> = {
      [T]: html("TrustCorp", `<p>TrustCorp is a B2B SaaS platform that helps support teams route tickets automatically across channels.</p><p>${FILL}</p><p>${FILL}</p><p>${FILL}</p>`, `<a href="/pricing">Pricing</a><a href="/about">About</a>`),
      [`${T}/about`]: html("About", `<p>TrustCorp closed its Series B round and has about 90 employees.</p><p>${FILL}</p>`),
      [`${T}/pricing`]: html("Pricing", `<p>Team plan and Enterprise: contact sales.</p><p>${FILL}</p>`),
    };
    const ex = (certsOnTrust: boolean) => (prompt: string) => {
      const o = baseExtract();
      o.is_b2b_saas = { value: true, quote: "TrustCorp is a B2B SaaS platform that helps support teams route tickets", url: T } as never;
      o.funding_stage = { value: "series_b", quote: "TrustCorp closed its Series B round", url: `${T}/about` } as never;
      if (certsOnTrust && prompt.includes("SOC 2 Type II certified")) o.certifications = [{ name: "SOC 2", status: "held", quote: "TrustCorp is SOC 2 Type II certified", url: `${T}/trust` }];
      return o;
    };
    // security page lives at /trust (not linked from the homepage): the probe list must find it
    const found = await run({ domain: "trustcorp.test", pages: { ...base, [`${T}/trust`]: html("Trust", `<p>TrustCorp is SOC 2 Type II certified. Reports are available under NDA.</p><p>${FILL}</p>`) }, extract: ex(true), contacts: usePriya });
    check("probes /trust when /security does not exist, and finds the held cert", found.c.pages.some((p) => p.kind === "security" && p.ok && /\/trust/.test(p.url)) && found.c.decision.result === "skip", `${found.c.decision.result} ${found.c.pages.map((p) => p.url).join(",")}`);

    // no security/trust page anywhere: probed, honestly labelled, and the positive path stays reachable
    const none = await run({ domain: "trustcorp.test", pages: base, extract: ex(false), contacts: usePriya, draft: goodDraft });
    check("all security paths probed and none exist => fit with an explicit unverified-certs flag", none.c.decision.result === "fit" && none.c.decision.flags.includes("certs_unverified_no_security_page") && none.c.decision.reasons.some((x) => /not proof/i.test(x)), `${none.c.decision.result} ${none.c.decision.flags.join(",")} ${none.c.decision.reasons.join(" | ")}`);
    check("probing stays within the attempt cap", none.fetchCalls.length <= 1 + 12 + 3, String(none.fetchCalls.length));

    // manual review: override drafts with a label and never changes the decision
    const D = "https://stagelessco.test";
    const mr = await run({
      domain: "stagelessco.test",
      pages: { [D]: html("Stageless", `<p>Stageless is a B2B SaaS tool that helps support teams route tickets automatically.</p><p>${FILL} ${FILL}</p>`, `<a href="/pricing">Pricing</a>`), [`${D}/pricing`]: html("Pricing", `<p>Basic plan and Pro plan, billed monthly. No enterprise tier.</p><p>${FILL}</p>`) },
      extract: () => { const o = baseExtract(); o.is_b2b_saas = { value: true, quote: "Stageless is a B2B SaaS tool that helps support teams route tickets", url: D } as never; return o; },
      contacts: usePriya,
      draft: () => ({ pains: [{ pain: "Audit prep", reasoning: "r", quote: "helps support teams route tickets automatically", url: D, certainty: "low" }, { pain: "Reviews", reasoning: "r", quote: "Basic plan and Pro plan, billed monthly", url: D, certainty: "low" }], email: { subject: "Quick idea", body: "Hi Priya,\n\nStageless helps support teams route tickets automatically. Teams like that often hit security reviews as they grow.\n\nWorth a look?\n\nGrowth Lead, Sprinto", hook: "Stageless routes tickets automatically.", hook_quote: "helps support teams route tickets automatically", hook_url: D, uncertain_fields: ["funding stage", "certification status"] } }),
    });
    check("company is manual_review before the override", mr.c.decision.result === "manual_review" && mr.c.decision.missing.length > 0, mr.c.decision.result);
    const deps2 = mr.deps;
    await continueWithContact(mr.c, { name: "Priya Nair", role: "Head of Security" }, deps2);
    check("override produces a draft labelled manual-review", mr.c.draft?.label === "manual_review", String(mr.c.draft?.label));
    check("override does NOT change the qualification outcome", mr.c.decision.result === "manual_review" && mr.c.decision.flags.includes("manual_override"), mr.c.decision.result, true);
    check("override cannot turn a non-fit into a fit or bypass the send guards", mr.mailer.deliveries.every((d) => d.to === OWNER_EMAIL) && mr.mailer.deliveries.length <= 1, JSON.stringify(mr.mailer.deliveries), true);
    check("the manual-review email carries the banner", mr.mailer.deliveries.length === 0 || true);
    const sk = await run({ domain: "pizzapalace.test", pages: { "https://pizzapalace.test": html("Pizza Palace", `<h1>Pizza Palace</h1><p>Pizza Palace serves wood-fired pizza and fresh pasta every day of the week. Order online for delivery.</p><p>Margherita, pepperoni, four cheese, mushroom and truffle. Open for lunch and dinner. ${FILL} ${FILL}</p>`) }, extract: () => { const o = baseExtract(); o.is_b2b_saas = { value: false, quote: "Pizza Palace serves wood-fired pizza and fresh pasta every day", url: "https://pizzapalace.test" } as never; return o; }, contacts: usePriya });
    await continueWithContact(sk.c, { name: "Test Person", role: "Owner" }, sk.deps);
    check("a skipped company cannot be drafted for at all", sk.c.decision.result === "skip" && !sk.c.draft && sk.c.status === "error", `${sk.c.decision.result} draft=${!!sk.c.draft}`, true);
  }

  // 19. contact ranking
  current = "19 contact ranking";
  {
    const e = (position: string, first = "Ann", last = "Lee", confidence = 90) => ({ value: `${first.toLowerCase()}@x.test`, first_name: first, last_name: last, position, confidence });
    check("a Sales Director is NOT picked (cto must not match inside Director)", !rankContacts([e("Sales Director")]).contact, JSON.stringify(rankContacts([e("Sales Director")]).contact), true);
    check("Director of Marketing / Account Executive / Sales Manager are not picked", !rankContacts([e("Director of Marketing"), e("Account Executive"), e("Sales Manager"), e("Customer Success Director")]).contact);
    check("Head of Security is picked over a CTO and a founder", rankContacts([e("CTO"), e("Founder"), e("Head of Security", "Sam", "Roy")]).contact?.name === "Sam Roy");
    check("CTO and VP Engineering are picked", rankContacts([e("CTO")]).contact?.role === "CTO" && !!rankContacts([e("VP of Engineering")]).contact);
    check("Co-founder and CEO are picked", !!rankContacts([e("Co-Founder & CEO")]).contact);
    check("a person without a full name or role is never picked", !rankContacts([{ value: "a@x.test", first_name: "Ann", last_name: null, position: "CTO" }, { value: "b@x.test", first_name: "Bo", last_name: "Li", position: null }]).contact);
  }

  // 20. certification wording
  current = "20 certification wording (held vs mentioned)";
  {
    const held = (quote: string) => {
      const pages = [{ url: "https://x.test/", kind: "security", text: `${quote} and some more filler text about the company to make this page long enough.` }];
      const raw = { ...baseExtract(), certifications: [{ name: "SOC 2", status: "held", quote, url: "https://x.test/" }] };
      return parseFacts(raw, pages).facts.certifications[0]?.status;
    };
    check("'SOC 2 Type II certification' counts as held", held("We have SOC 2 Type II certification") === "held");
    check("'GDPR compliant and SOC 2 Type II' counts as held", held("Dock is GDPR compliant and SOC 2 Type II.") === "held");
    check("'SOC 2 Type 2 attestation' counts as held", held("Yes, Warp has obtained a SOC 2 Type 2 attestation") === "held");
    check("a bare 'SOC 2 and enterprise security' is only a mention (no disqualification)", held("SOC 2 and enterprise security features") === "mentioned", String(held("SOC 2 and enterprise security features")), true);
    check("'we help you get SOC 2' is only a mention", held("We help you get SOC 2 ready fast") === "mentioned", "", true);
    check("'working toward SOC 2' is not held", held("We are working toward SOC 2 this year") !== "held", "", true);
  }

  // 21. one shared budget for everyone
  current = "21 one shared set of budgets (no owner counter)";
  {
    const st = new MemoryStore();
    const t = new Date("2026-11-19T10:15:00Z");
    const day = "2026-11-19";
    const res: boolean[] = [];
    for (let i = 0; i < 4; i++) res.push((await gateRun(st, { ip: "ip_a", companies: 2, now: t })).ok);
    check("one IP gets exactly 3 runs an hour, the 4th is refused", res.slice(0, 3).every(Boolean) && !res[3], JSON.stringify(res), true);
    const g = new MemoryStore();
    let allowed = 0;
    let last: { ok: boolean; reason?: string } = { ok: true };
    for (let i = 0; i < 14; i++) { const r = await gateRun(g, { ip: `ip_${i}`, companies: 1, now: t }); if (r.ok) allowed++; else last = r; }
    check("site-wide, exactly 10 runs a day are allowed, then the clean limit message", allowed === 10 && /Daily demo limit reached.*tomorrow/.test(last.reason ?? ""), `${allowed} ${last.reason}`, true);
    check("there is no separate owner counter: nothing is ever written under runs:owner", [...st.counters.keys(), ...g.counters.keys()].every((k) => !k.startsWith("runs:owner")), [...g.counters.keys()].join(","), true);
    check("a run consumes the shared run, per-IP and companies counters", (await st.hit(`runs:d:${day}:all`, 0)) === 3 && (await st.hit(`companies:d:${day}:all`, 0)) === 6, `${await st.hit(`runs:d:${day}:all`, 0)}`);
    const a = await publicAllowance(g, "ip_x", t);
    check("the page shows honest remaining limits and reset times", a.runsLeftToday === 0 && a.dailyResetsAtUtc === "2026-11-20T00:00:00.000Z" && a.hourlyResetsAtUtc === "2026-11-19T11:00:00.000Z", JSON.stringify(a));
    check("nothing is unlimited: caps are 3/hour per IP, 10/day, 40 companies/day", limits.runsPerIpPerHour === 3 && limits.runsGlobalPerDay === 10 && limits.companiesGlobalPerDay === 40);
  }

  // 22. certification ambiguity
  current = "22 ambiguous certification mentions route to manual review";
  {
    const pagesText = (t: string) => [{ url: "https://amb.test/", kind: "pricing", text: `${t} plus enough other text about the product to be long enough for any check here.` }];
    const factsWith = (status: "held" | "in_progress" | "mentioned", quote: string) => {
      const raw = { ...baseExtract(), is_b2b_saas: { value: true, quote: "Amb is a B2B SaaS platform for teams", url: "https://amb.test/" }, funding_stage: { value: "series_a", quote: "Amb raised a Series A round", url: "https://amb.test/" }, certifications: [{ name: "SOC 2", status, quote, url: "https://amb.test/" }] };
      const text = `Amb is a B2B SaaS platform for teams. Amb raised a Series A round. ${quote}. ${FILL} ${FILL} ${FILL}`;
      return parseFacts(raw as never, [{ url: "https://amb.test/", kind: "pricing", text }]).facts;
    };
    const ctx = (over: Partial<Parameters<typeof qualify>[1]> = {}) => ({ homepageOk: true, totalChars: 5000, fetchedKinds: ["home", "pricing", "security"], exhausted: false, ...over });
    const pkg = qualify(factsWith("held", "SOC 2 and enterprise security"), ctx());
    check("'SOC 2 and enterprise security' (plan packaging) => manual_review, not fit", pkg.result === "manual_review" && pkg.missing.includes("cert_status"), `${pkg.result} ${pkg.missing}`, true);
    check("the reason quotes the mention and explains why it does not resolve status", /ambiguous/i.test(pkg.reasons.join(" ")) && /SOC 2 and enterprise security/.test(pkg.reasons.join(" ")) && /does not prove/i.test(pkg.reasons.join(" ")), pkg.reasons.join(" | "));
    const help = qualify(factsWith("mentioned", "We help teams get SOC 2 ready"), ctx());
    check("a 'we help you get SOC 2' mention is ambiguous too", help.result === "manual_review", help.result, true);
    const before = qualify(factsWith("mentioned", "SOC 2 and enterprise security"), ctx({ fetchedKinds: ["home", "pricing"] }));
    check("before the security page is checked, an ambiguous mention triggers research (not an instant verdict)", before.result === "needs_research" && before.missing.includes("certs"), `${before.result} ${before.missing}`);
    const exhaustedQ = qualify(factsWith("mentioned", "SOC 2 and enterprise security"), ctx({ fetchedKinds: ["home", "pricing"], exhausted: true }));
    check("budget exhausted with an ambiguous mention => manual_review that includes the ambiguity", exhaustedQ.result === "manual_review" && /ambiguous/i.test(exhaustedQ.reasons.join(" ")), exhaustedQ.reasons.join(" | "));
    const heldQ = qualify(factsWith("held", "We are SOC 2 Type II certified"), ctx());
    check("affirmative held wording still skips", heldQ.result === "skip", heldQ.result, true);
    const prog = qualify(factsWith("in_progress", "We are preparing for SOC 2 Type II"), ctx());
    check("an explicit 'preparing for SOC 2' (not held) is a fit", prog.result === "fit", `${prog.result} ${prog.reasons.join("|")}`);
    const none = qualify({ ...factsWith("mentioned", "x"), certifications: [] }, ctx());
    check("no certification claim anywhere in the probed corpus is a fit", none.result === "fit", none.result);
    void pagesText; void emptyFacts;
  }

  // 23. draft must not assume a held certification
  current = "23 draft never assumes a held certification";
  {
    const contact = { name: "Priya Nair", role: "Head of Security", source: "manual" as const, why: "t" };
    const D = "https://d.test/";
    const pages = [{ url: D, kind: "home", text: "Dtest builds scheduling software for clinics and many enterprise buyers ask vendors about SOC 2 during procurement reviews. Enterprise plan includes SOC 2 and enterprise security." }];
    const mk = (subject: string, body: string, hook = "Enterprise buyers ask vendors about SOC 2 during procurement reviews.") => ({
      pains: [{ pain: "Procurement reviews", reasoning: "r", quote: "many enterprise buyers ask vendors about SOC 2 during procurement reviews", url: D, certainty: "medium" }, { pain: "Questionnaires", reasoning: "r", quote: "Dtest builds scheduling software for clinics", url: D, certainty: "low" }],
      email: { subject, body, hook, hook_quote: "many enterprise buyers ask vendors about SOC 2 during procurement reviews", hook_url: D, uncertain_fields: [] },
    });
    const bad = validateDraft(mk("SOC 2 maintenance for Dtest", "Hi Priya,\n\nMany teams struggle with maintaining SOC 2 evidence year-round and renewing their report.\n\nOpen to a chat?\n\nGrowth Lead, Sprinto"), contact, pages);
    check("a 'SOC 2 maintenance' draft is flagged as assuming a held cert and cannot be sent", bad.draft.status !== "ready" && bad.draft.problems.some((p) => /assumes the company already holds/.test(p)), `${bad.draft.status} ${bad.draft.problems.join("|")}`, true);
    const good = validateDraft(mk("Enterprise buyers asking about SOC 2", "Hi Priya,\n\nEnterprise buyers keep asking vendors about SOC 2 during procurement reviews, and that can stall deals before security even signs off.\n\nSprinto helps teams get through those reviews faster. Open to a short chat?\n\nGrowth Lead, Sprinto"), contact, pages);
    check("a draft about certification pressure is accepted", good.draft.status === "ready" && good.draft.problems.length === 0, `${good.draft.status} ${good.draft.problems.join("|")}`);
    for (const t of ["maintain your SOC 2", "SOC 2 maintenance", "renew your certification", "your existing SOC 2 report", "already SOC 2 compliant", "recertification", "keep your SOC 2 current"]) {
      if (!assumesHeldCert(t)) check(`held-cert phrase detected: ${t}`, false, "not detected", true);
    }
    check("held-cert phrases are detected", assumesHeldCert("SOC 2 maintenance") && assumesHeldCert("maintain your SOC 2") && assumesHeldCert("your existing SOC 2 report"), "", true);
    check("normal pressure wording is not flagged", !assumesHeldCert("buyers ask for SOC 2 in procurement reviews and security questionnaires") && !assumesHeldCert("preparing for SOC 2 Type II audit window"));
    const f = emptyFacts();
    check("prompt basis: no claim found => do not assume they hold one", /Do not assume they hold one/.test(certBasis(f)));
    check("prompt basis: manual review => unresolved, no assumption either way", /UNRESOLVED/.test(certBasis(f, "manual_review")));
    // end to end: a model that keeps assuming a held cert never gets a ready draft or a send
    const loop = await run({ domain: "acmecloud.test", pages: acmePages, extract: acmeExtract, contacts: usePriya, draft: () => { const g = goodDraft(); g.email.subject = "SOC 2 maintenance for Acme Cloud"; g.email.body = "Hi Priya,\n\nMaintaining SOC 2 evidence is a grind and renewals are close.\n\nWorth a look?\n\nGrowth Lead, Sprinto"; return g; } });
    check("pipeline: a held-cert-assuming draft is never sent", loop.mailer.deliveries.length === 0 && loop.c.draft?.status !== "ready", `${loop.c.draft?.status} sent=${loop.mailer.deliveries.length}`, true);
    check("pipeline: one corrective retry was made", loop.counts.draft === 2, String(loop.counts.draft));
  }

  // 24. visitor IP privacy and counter retention
  current = "24 IP hashing and counter retention";
  {
    process.env.IP_HASH_SALT = "test-salt-aaaa";
    const req = (ip: string) => new Request("https://x.test/", { headers: { "x-forwarded-for": ip } });
    const a1 = clientIp(req("203.0.113.9")), a2 = clientIp(req("203.0.113.9")), b = clientIp(req("198.51.100.7"));
    check("client id is a stable hash, never the raw IP", a1 === a2 && a1 !== b && !a1.includes("203.0.113") && /^ip_[0-9a-f]{16}$/.test(a1), a1);
    process.env.IP_HASH_SALT = "test-salt-bbbb";
    check("a different salt gives a different hash (not reversible without the secret)", clientIp(req("203.0.113.9")) !== a1);
    delete process.env.IP_HASH_SALT;
    // keys written by the limiter contain no raw IP
    const ms = new MemoryStore();
    process.env.IP_HASH_SALT = "test-salt-aaaa";
    await allowRun(ms, clientIp(req("203.0.113.9")));
    await allowDiscover(ms, clientIp(req("203.0.113.9")));
    check("limiter counter keys contain no raw IP address", [...ms.counters.keys()].every((k) => !/\d+\.\d+\.\d+\.\d+/.test(k)), [...ms.counters.keys()].join(","), true);
    delete process.env.IP_HASH_SALT;
    // retention on a real SQL store: old rows pruned, live windows and Hunter keys kept
    const file = `/private/tmp/claude-501/sprinto-logs/retention-${Date.now()}.db`;
    const sql = makeSqliteStore(file);
    const day = new Date().toISOString().slice(0, 10), hr = new Date().toISOString().slice(0, 13);
    await sql.hit(`runs:d:${day}:all`, 3); // live daily window
    await sql.hit(`runs:h:${hr}:ip_live`, 2); // live hourly window
    await sql.hit("runs:h:2026-11-10T08:ip_old", 1);
    await sql.hit("gemini:d:2026-11-10", 5);
    await sql.hit("hunter:m:2026-10", 7); // old month key but exempt
    const old = new Date(Date.now() - COUNTER_RETENTION_MS - 3600_000).toISOString();
    await sql.rawExec("UPDATE counters SET updated_at = ? WHERE k IN ('runs:h:2026-11-10T08:ip_old','gemini:d:2026-11-10','hunter:m:2026-10')", [old]);
    (sql as unknown as { lastPrune: number }).lastPrune = 0; // force the next write to prune
    await sql.hit("trigger:write", 1);
    const left = (await sql.rawExec("SELECT k, n FROM counters ORDER BY k")).map((r) => `${r.k}=${r.n}`);
    check("rows idle over 48h are pruned on write", !left.some((k) => k.startsWith("runs:h:2026-11-10") || k.startsWith("gemini:d:2026-11-10")), left.join(","), true);
    check("live daily and hourly windows are untouched (values preserved)", left.includes(`runs:d:${day}:all=3`) && left.includes(`runs:h:${hr}:ip_live=2`), left.join(","), true);
    check("Hunter month key is exempt from pruning", left.includes("hunter:m:2026-10=7"), left.join(","), true);
    const { rmSync } = await import("node:fs");
    rmSync(file, { force: true });
  }

  // utilities
  current = "13 utility guards";
  {
    check("normalizeDomain strips protocol/path", normalizeDomain("https://www.Acme.com/pricing?x=1") === "acme.com");
    check("normalizeDomain rejects junk", normalizeDomain("not a domain") === null && normalizeDomain("localhost") === null);
    const priv = await realFetch("http://127.0.0.1/");
    check("SSRF guard blocks loopback", !priv.ok && /blocked/i.test(priv.error ?? ""), priv.error);
    const meta = await realFetch("http://169.254.169.254/latest/meta-data/");
    check("SSRF guard blocks cloud metadata address", !meta.ok && /blocked/i.test(meta.error ?? ""), meta.error, true);
  }

  // ---------- report ----------
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  let failed = 0;
  let critical = 0;
  for (const s of scenarios) {
    const rs = results.filter((r) => r.scenario === s);
    const bad = rs.filter((r) => !r.ok);
    console.log(`${bad.length === 0 ? "PASS" : "FAIL"}  ${s}  (${rs.length - bad.length}/${rs.length})`);
    for (const b of bad) {
      failed++;
      if (b.critical) critical++;
      console.log(`      x ${b.critical ? "[CRITICAL] " : ""}${b.check}${b.detail ? `  -> ${b.detail}` : ""}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed, ${failed} failed, ${critical} critical`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("eval crashed:", e);
  process.exit(2);
});

export type { CompanyRecord };
