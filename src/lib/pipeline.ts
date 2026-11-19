// The per-company pipeline: scrape -> extract -> qualify (bounded research loop) -> contact -> pains -> draft -> send.

import { composeEmailText, writeDraft } from "./draft";
import { emptyFacts, extractFacts, norm, type PageInput } from "./extract";
import { candidateUrls, cleanHtml, fetchHomepage, kindOfUrl, pickPage, realFetch, registrable, stripSlash, type Fetcher, type FetchResult, type PageKind } from "./fetcher";
import { budgetedLLM, DemoLimitError, geminiLLM, type LLM } from "./gemini";
import { makeGmailMailer, OWNER_EMAIL, SafetyError, sendPreview, type Mailer } from "./gmail";
import { hunterContacts, hunterRemaining, type ContactFinder } from "./hunter";
import { pageKindsFor, qualify, THIN_TEXT_CHARS } from "./qualify";
import { getStore, type Store } from "./store";
import type { CompanyFacts, CompanyRecord, Contact, SendResult } from "./types";

export const EXTRA_PAGE_CAP = 6; // max extra pages successfully fetched per company (initial scrape + research loop together)
export const EXTRA_ATTEMPT_CAP = 12; // max extra fetch attempts (probes that 404 count here, not against the page cap)
export const INITIAL_EXTRA = 2; // extra pages fetched up front
export const RESEARCH_LOOP_CAP = 3; // max research-loop iterations
export const PROBES_PER_LOOP = 4; // max URLs probed within one loop iteration

export interface Deps {
  fetcher: Fetcher;
  llm: LLM;
  contacts: ContactFinder;
  mailer: Mailer;
  store: Store;
  now: () => Date;
}

export function liveDeps(): Deps {
  const store = getStore();
  return { fetcher: realFetch, llm: budgetedLLM(geminiLLM, store), contacts: cappedContacts(hunterContacts, store), mailer: makeGmailMailer(store), store, now: () => new Date() };
}

export function newCompany(runId: string, id: string, domain: string, sendEnabled: boolean, now: Date, expectedName?: string, hintContact?: { name: string; role: string }): CompanyRecord {
  const t = now.toISOString();
  return {
    id,
    runId,
    domain,
    expectedName: expectedName || undefined,
    hintContact: hintContact?.name && hintContact?.role ? { name: hintContact.name.slice(0, 80), role: hintContact.role.slice(0, 100) } : undefined,
    sendEnabled,
    status: "queued",
    stage: "queued",
    pages: [],
    droppedClaims: [],
    research: { loops: 0, cap: RESEARCH_LOOP_CAP, steps: [], exhausted: false },
    decision: { result: "pending", reasons: [], flags: [], missing: [], stageProxies: [] },
    log: [],
    createdAt: t,
    updatedAt: t,
  };
}

function note(c: CompanyRecord, deps: Deps, stage: string, msg: string) {
  c.stage = stage;
  c.log.push({ t: deps.now().toISOString(), stage, msg });
  if (c.log.length > 80) c.log.splice(0, c.log.length - 80);
}

async function persist(c: CompanyRecord, deps: Deps) {
  c.updatedAt = deps.now().toISOString();
  await deps.store.saveCompany(c);
}

function pageInputs(c: CompanyRecord): PageInput[] {
  return c.pages.filter((p) => p.ok && p.text).map((p) => ({ url: p.url, kind: p.kind, text: p.text! }));
}

function nameMatches(expected: string, found: string, domain: string): boolean {
  const e = norm(expected).replace(/\s+/g, "");
  const f = norm(found).replace(/\s+/g, "");
  const d = norm(domain.split(".")[0]).replace(/\s+/g, "");
  if (!e) return true;
  return f.includes(e) || e.includes(f) || (!!d && f.includes(d) && e.includes(d));
}

export function stripPageText(c: CompanyRecord): CompanyRecord {
  return { ...c, pages: c.pages.map((p) => ({ ...p, text: undefined })) };
}

function addPage(c: CompanyRecord, r: FetchResult, kind: string, deps: Deps): PageInput | null {
  if (!r.ok || !r.html) {
    c.pages.push({ url: r.url, kind, ok: false, status: r.status, error: r.error ?? "failed", chars: 0 });
    note(c, deps, "scrape", `Fetch failed for ${r.url}: ${r.error ?? "unknown"}`);
    return null;
  }
  const clean = cleanHtml(r.html, r.finalUrl);
  c.pages.push({ url: r.finalUrl, kind, ok: true, status: r.status, chars: clean.text.length, text: clean.text });
  note(c, deps, "scrape", `Fetched ${kind} page ${r.finalUrl} (${clean.text.length} chars)`);
  return { url: r.finalUrl, kind, text: clean.text };
}

export async function processCompany(c: CompanyRecord, deps: Deps): Promise<CompanyRecord> {
  try {
    await runCore(c, deps);
    c.status = "done";
    note(c, deps, "done", `Finished: ${c.decision.result}${c.send ? `, send ${c.send.status}` : ""}`);
  } catch (e) {
    c.status = "error";
    c.error = e instanceof Error ? e.message : String(e);
    note(c, deps, "error", c.error);
  }
  await persist(c, deps);
  return c;
}

async function runCore(c: CompanyRecord, deps: Deps) {
  c.status = "running";
  c.error = undefined;
  c.pages = [];
  c.droppedClaims = [];
  c.research = { loops: 0, cap: RESEARCH_LOOP_CAP, steps: [], exhausted: false };
  c.contact = undefined;
  c.contactSkip = undefined;
  c.pains = undefined;
  c.draft = undefined;
  c.send = undefined;
  note(c, deps, "scrape", `Starting ${c.domain}`);
  await persist(c, deps);

  // 1. Scrape: homepage + bounded extras
  const home = await fetchHomepage(c.domain, deps.fetcher);
  const homePage = addPage(c, home, "home", deps);
  if (!homePage) {
    c.decision = { result: "manual_review", reasons: [`Homepage could not be fetched (${home.error ?? "unknown"}). No facts were guessed.`], flags: ["homepage_unreachable"], missing: [], stageProxies: [] };
    c.facts = emptyFacts();
    return;
  }
  const baseUrl = home.finalUrl;
  const links = cleanHtml(home.html!, baseUrl).links;
  const fetched = new Set<string>([stripSlash(baseUrl), stripSlash(home.url)]);
  let extra = 0;
  let redirectIssue: string | undefined;
  // Country/TLD redirects of the same brand (pizzahut.com -> pizzahut.co.in) are fine; a different brand label is not.
  const brand = (host: string) => registrable(host).split(".")[0].replace(/[^a-z0-9]/g, "");
  if (brand(new URL(baseUrl).hostname) !== brand(c.domain)) {
    redirectIssue = `${c.domain} redirects to ${new URL(baseUrl).hostname}, a different domain`;
  }

  let attempts = 0;
  const exhaustedKinds = new Set<string>(); // kinds where every candidate URL was tried and none worked
  const fetchExtra = async (kind: PageKind, url: string) => {
    fetched.add(stripSlash(url));
    attempts++;
    const r = await deps.fetcher(url);
    fetched.add(stripSlash(r.finalUrl));
    if (r.ok) extra++;
    addPage(c, r, kind, deps);
    return r;
  };
  for (const kind of ["pricing", "about", "product"] as PageKind[]) {
    if (extra >= INITIAL_EXTRA) break;
    const url = pickPage(kind, links, baseUrl, fetched, false);
    if (url) await fetchExtra(kind, url);
  }
  await persist(c, deps);

  const totalChars = () => pageInputs(c).reduce((n, p) => n + p.text.length, 0);
  const doExtract = async () => {
    c.stage = "extract";
    if (totalChars() < THIN_TEXT_CHARS) {
      note(c, deps, "extract", "Skipped Gemini: not enough page text to extract from (thin site).");
      c.facts = emptyFacts();
      return;
    }
    const r = await extractFacts(pageInputs(c), deps.llm);
    c.facts = r.facts;
    c.droppedClaims = r.dropped;
    for (const d of r.dropped) note(c, deps, "extract", `Dropped unverifiable claim: ${d}`);
    note(c, deps, "extract", `Extracted facts from ${pageInputs(c).length} page(s).`);
  };
  await doExtract();

  // 3. Qualify with a bounded research loop
  const ctx = (exhausted: boolean) => {
    const f = c.facts as CompanyFacts;
    let identityIssue = redirectIssue;
    const found = f.company_name.value;
    if (!identityIssue && c.expectedName && found && !nameMatches(c.expectedName, found, c.domain)) {
      identityIssue = `you expected "${c.expectedName}" but the site at ${c.domain} says "${found}" (same-name, different company?)`;
    }
    return {
      identityIssue,
      homepageOk: true,
      totalChars: totalChars(),
      fetchedKinds: c.pages.filter((p) => p.ok).map((p) => p.kind === "other" ? kindOfUrl(p.url) : p.kind),
      exhausted,
      securityExhausted: exhaustedKinds.has("security"),
    };
  };

  c.stage = "qualify";
  let q = qualify(c.facts as CompanyFacts, ctx(false));
  while (q.result === "needs_research") {
    if (c.research.loops >= RESEARCH_LOOP_CAP || extra >= EXTRA_PAGE_CAP || attempts >= EXTRA_ATTEMPT_CAP) {
      c.research.exhausted = true;
      note(c, deps, "qualify", `Research budget exhausted (${c.research.loops}/${RESEARCH_LOOP_CAP} loops, ${attempts} fetch attempts). Stopping.`);
      q = qualify(c.facts as CompanyFacts, ctx(true));
      break;
    }
    // Round-robin across missing fields so one stubborn field cannot eat the whole budget.
    const tried = (f: string) => c.research.steps.filter((s) => s.field === f).length;
    const field = [...q.missing].sort((a, b) => tried(a) - tried(b))[0];
    c.research.loops++;
    // Pick the first page kind for this field that still has untried candidate URLs, then probe up to PROBES_PER_LOOP of them.
    let kind: PageKind | null = null;
    let cands: string[] = [];
    for (const k of pageKindsFor(field)) {
      if (exhaustedKinds.has(k)) continue;
      const list = candidateUrls(k, links, baseUrl, fetched);
      if (list.length === 0) {
        exhaustedKinds.add(k);
        continue;
      }
      kind = k;
      cands = list;
      break;
    }
    if (!kind) {
      c.research.steps.push({ field, url: null, ok: false, note: "no candidate page left" });
      note(c, deps, "research", `Loop ${c.research.loops}: missing ${field}, no page left to try.`);
      q = qualify(c.facts as CompanyFacts, ctx(false));
      continue;
    }
    let got: FetchResult | null = null;
    const probed: string[] = [];
    for (const url of cands.slice(0, PROBES_PER_LOOP)) {
      if (attempts >= EXTRA_ATTEMPT_CAP) break;
      probed.push(url);
      note(c, deps, "research", `Loop ${c.research.loops}: missing ${field}; trying ${kind} page ${url}`);
      const r = await fetchExtra(kind, url);
      if (r.ok) {
        got = r;
        break;
      }
    }
    if (!got && cands.length <= PROBES_PER_LOOP) exhaustedKinds.add(kind); // every candidate for this kind has now been tried
    c.research.steps.push({ field, url: got?.finalUrl ?? probed[probed.length - 1] ?? null, ok: !!got, note: got ? undefined : `probed ${probed.length} URL(s), none found` });
    if (got) {
      exhaustedKinds.delete(kind);
      await doExtract();
    }
    q = qualify(c.facts as CompanyFacts, ctx(false));
  }
  c.decision = {
    result: q.result === "needs_research" ? "manual_review" : q.result,
    reasons: q.reasons,
    flags: q.flags,
    missing: q.missing,
    stageProxies: q.stageProxies,
  };
  note(c, deps, "qualify", `Decision: ${c.decision.result}. ${c.decision.reasons[0] ?? ""}`);
  await persist(c, deps);
  if (c.decision.result !== "fit") return;

  // 4. Contact (only after qualifying)
  c.stage = "contact";
  const found = await deps.contacts(c.domain, { runId: c.runId, companyId: c.id });
  if (found.contact) {
    c.contact = found.contact;
    note(c, deps, "contact", `Selected ${found.contact.name}, ${found.contact.role} (${found.contact.why}).`);
  } else if (c.hintContact) {
    c.contact = { name: c.hintContact.name, role: c.hintContact.role, source: "manual", why: "Supplied by you (Hunter had no result)" };
    note(c, deps, "contact", `Hunter skipped (${found.skip ?? "no result"}); using the contact you supplied: ${c.contact.name}, ${c.contact.role}.`);
  } else {
    c.contactSkip = found.skip ?? "No suitable contact found.";
    note(c, deps, "contact", `Skipped: ${c.contactSkip}`);
    return;
  }
  await persist(c, deps);
  await draftAndSend(c, deps);
}

/** Steps 5-7 for a company that already has a contact. */
export async function draftAndSend(c: CompanyRecord, deps: Deps) {
  if (!c.contact || !c.facts) throw new Error("Cannot draft without a contact and facts.");
  c.stage = "draft";
  const pages = pageInputs(c);
  const { pains, draft } = await writeDraft(c.contact, c.facts, c.domain, pages, deps.llm);
  if (c.decision.result === "manual_review") draft.label = "manual_review";
  c.pains = pains;
  c.draft = draft;
  note(c, deps, "draft", `Draft ${draft.status}${draft.problems.length ? `: ${draft.problems[0]}` : ""}`);
  await persist(c, deps);
  c.send = await trySend(c, deps);
  note(c, deps, "send", `Send ${c.send.status}: ${c.send.note}`);
}

export async function trySend(c: CompanyRecord, deps: Deps, to: string = OWNER_EMAIL): Promise<SendResult> {
  const at = deps.now().toISOString();
  if (!c.sendEnabled) return { status: "not_attempted", note: "Sending to your inbox was turned off for this run.", at };
  if (!c.draft || !c.contact) return { status: "not_attempted", note: "No draft yet.", at };
  if (c.draft.status !== "ready") {
    return { status: "not_attempted", note: `Not sent: the draft is "${c.draft.status}". ${c.draft.problems.join(" ")}`.trim(), at };
  }
  const sendsToday = await deps.store.hit(`sends:d:${at.slice(0, 10)}`, 1);
  if (sendsToday > Number(process.env.SENDS_GLOBAL_PER_DAY || 25)) {
    return { status: "not_attempted", note: "Daily demo limit reached for preview emails. Try again tomorrow. The draft above is still yours to read.", at };
  }
  try {
    return await sendPreview({
      companyId: c.id,
      to,
      subject: `${c.facts?.company_name.value ?? c.domain} -> ${c.contact.name}: ${c.draft.subject}`,
      text: composeEmailText({
        draftBody: c.draft.body,
        subject: c.draft.subject,
        contact: c.contact,
        company: c.facts?.company_name.value ?? c.domain,
        domain: c.domain,
        hook: c.draft.hook,
        hookQuote: c.draft.hookEvidence.quote,
        hookUrl: c.draft.hookEvidence.url,
        pains: c.pains ?? [],
        uncertain: c.draft.uncertainFields,
        banner: c.draft.label === "manual_review" ? `MANUAL-REVIEW DRAFT: this company is NOT qualified as a fit. Unresolved: ${c.decision.missing.join(", ") || "see reasons"}. ${c.decision.reasons.join(" ")}` : undefined,
      }),
      store: deps.store,
      mailer: deps.mailer,
      now: deps.now,
    });
  } catch (e) {
    if (e instanceof SafetyError) return { status: "blocked", note: e.message, at };
    throw e;
  }
}

export async function continueWithContact(c: CompanyRecord, contact: Omit<Contact, "source" | "why">, deps: Deps): Promise<CompanyRecord> {
  try {
    if (c.decision.result === "skip") throw new Error("This company was skipped (it fails a hard ICP rule), so no draft can be made for it.");
    if (c.decision.result !== "fit" && c.decision.result !== "manual_review") throw new Error("This company has no decision yet.");
    if (c.decision.result === "manual_review" && !c.decision.flags.includes("manual_override")) {
      c.decision.flags.push("manual_override");
      note(c, deps, "qualify", "Manual-review override: continuing to a draft on your instruction. Unverified fields stay marked uncertain.");
    }
    if (!contact.name.trim() || !contact.role.trim()) throw new Error("Contact needs a name and a role.");
    c.contact = { name: contact.name.trim().slice(0, 80), role: contact.role.trim().slice(0, 100), email: contact.email?.trim() || undefined, source: "manual", why: "Supplied by you (not looked up)" };
    c.contactSkip = undefined;
    note(c, deps, "contact", `Using contact you supplied: ${c.contact.name}, ${c.contact.role}.`);
    c.status = "running";
    await draftAndSend(c, deps);
    c.status = "done";
  } catch (e) {
    c.status = "error";
    c.error = e instanceof Error ? e.message : String(e);
    note(c, deps, "error", c.error);
  }
  await persist(c, deps);
  return c;
}

export async function resend(c: CompanyRecord, deps: Deps): Promise<CompanyRecord> {
  c.send = await trySend(c, deps);
  note(c, deps, "send", `Send ${c.send.status}: ${c.send.note}`);
  await persist(c, deps);
  return c;
}

export const HUNTER_PER_RUN_CAP = 5; // lookups per run, whatever the number of domains
export const HUNTER_RESERVE = 10; // credits never spent: a lookup is refused if it would leave fewer than this
export const HUNTER_MONTHLY_CAP = 40; // persistent backstop in Postgres (50 free credits minus the reserve)

/**
 * Every Hunter lookup passes these gates, in order, and each failure is a graceful skip with a visible note:
 *  1. at most one lookup per company record (re-processing cannot retry it)
 *  2. at most HUNTER_PER_RUN_CAP lookups per run
 *  3. Hunter's own account endpoint (fresh, free) must report enough credits to stay at or above the reserve after this lookup;
 *     if it cannot be read, the lookup is refused (fail closed)
 *  4. a persistent per-month counter in the database (survives restarts and redeploys) must be under the monthly cap
 * A lookup is one Domain Search with limit=10 (Hunter bills 1 credit per 10 emails returned) and at most one retry, and only after a failed call.
 */
export function cappedContacts(
  base: ContactFinder,
  store: Store,
  opts: { remaining?: () => Promise<number | null>; now?: () => Date } = {},
): ContactFinder {
  const remaining = opts.remaining ?? hunterRemaining;
  return async (domain, ctx) => {
    const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
    if (ctx) {
      if ((await store.hit(`hunter:co:${ctx.companyId}`, 1)) > 1) return { skip: "A contact lookup was already made for this company. It is not repeated, to protect the Hunter credits. You can add a contact yourself and continue." };
      if ((await store.hit(`hunter:run:${ctx.runId}`, 1)) > num(process.env.HUNTER_PER_RUN_CAP, HUNTER_PER_RUN_CAP)) return { skip: `This run already used its ${HUNTER_PER_RUN_CAP} contact lookups, so none was made for this company. You can add a contact yourself and continue.` };
    }
    const reserve = num(process.env.HUNTER_RESERVE, HUNTER_RESERVE);
    const left = await remaining();
    if (left === null) return { skip: "Hunter's remaining credits could not be verified, so no lookup was made (credits are protected). You can add a contact yourself and continue." };
    if (left - 1 < reserve) return { skip: `Hunter reports ${Math.max(0, left)} credits left; a lookup would drop it below the ${reserve}-credit reserve, so none was made. You can add a contact yourself and continue.` };
    const month = (opts.now ? opts.now() : new Date()).toISOString().slice(0, 7);
    if ((await store.hit(`hunter:m:${month}`, 1)) > num(process.env.HUNTER_MONTHLY_CAP, HUNTER_MONTHLY_CAP)) return { skip: "This month's contact-lookup budget for the demo is used up, so no lookup was made. You can add a contact yourself and continue." };
    return base(domain, ctx);
  };
}
