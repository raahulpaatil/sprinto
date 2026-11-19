// The per-company pipeline: scrape -> extract -> qualify (bounded research loop) -> contact -> pains -> draft -> send.

import { composeEmailText, writeDraft } from "./draft";
import { emptyFacts, extractFacts, norm, type PageInput } from "./extract";
import { cleanHtml, fetchHomepage, kindOfUrl, pickPage, realFetch, registrable, stripSlash, type Fetcher, type FetchResult, type PageKind } from "./fetcher";
import { geminiLLM, type LLM } from "./gemini";
import { gmailMailer, OWNER_EMAIL, SafetyError, sendPreview, type Mailer } from "./gmail";
import { hunterContacts, type ContactFinder } from "./hunter";
import { pageKindsFor, qualify, THIN_TEXT_CHARS } from "./qualify";
import { getStore, type Store } from "./store";
import type { CompanyFacts, CompanyRecord, Contact, SendResult } from "./types";

export const EXTRA_PAGE_CAP = 4; // max extra pages fetched per company (initial scrape + research loop together)
export const INITIAL_EXTRA = 2; // extra pages fetched up front
export const RESEARCH_LOOP_CAP = 2; // max research-loop iterations

export interface Deps {
  fetcher: Fetcher;
  llm: LLM;
  contacts: ContactFinder;
  mailer: Mailer;
  store: Store;
  now: () => Date;
}

export function liveDeps(): Deps {
  return { fetcher: realFetch, llm: geminiLLM, contacts: hunterContacts, mailer: gmailMailer, store: getStore(), now: () => new Date() };
}

export function newCompany(runId: string, id: string, domain: string, sendEnabled: boolean, now: Date, expectedName?: string): CompanyRecord {
  const t = now.toISOString();
  return {
    id,
    runId,
    domain,
    expectedName: expectedName || undefined,
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

  const fetchExtra = async (kind: PageKind, url: string) => {
    fetched.add(stripSlash(url));
    extra++;
    const r = await deps.fetcher(url);
    fetched.add(stripSlash(r.finalUrl));
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
    };
  };

  c.stage = "qualify";
  let q = qualify(c.facts as CompanyFacts, ctx(false));
  while (q.result === "needs_research") {
    if (c.research.loops >= RESEARCH_LOOP_CAP || extra >= EXTRA_PAGE_CAP) {
      c.research.exhausted = true;
      note(c, deps, "qualify", `Research budget exhausted (${c.research.loops}/${RESEARCH_LOOP_CAP} loops). Stopping.`);
      q = qualify(c.facts as CompanyFacts, ctx(true));
      break;
    }
    const field = q.missing[0];
    let url: string | null = null;
    let kind: PageKind | null = null;
    for (const k of pageKindsFor(field)) {
      url = pickPage(k, links, baseUrl, fetched, true);
      if (url) {
        kind = k;
        break;
      }
    }
    c.research.loops++;
    if (!url || !kind) {
      c.research.steps.push({ field, url: null, ok: false, note: "no candidate page left" });
      note(c, deps, "research", `Loop ${c.research.loops}: missing ${field}, no page left to try.`);
      q = qualify(c.facts as CompanyFacts, ctx(false));
      continue;
    }
    note(c, deps, "research", `Loop ${c.research.loops}: missing ${field}; fetching ${url}`);
    const r = await fetchExtra(kind, url);
    c.research.steps.push({ field, url, ok: r.ok, note: r.ok ? undefined : r.error });
    if (r.ok) await doExtract();
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
  const found = await deps.contacts(c.domain);
  if (found.contact) {
    c.contact = found.contact;
    note(c, deps, "contact", `Selected ${found.contact.name}, ${found.contact.role} (${found.contact.why}).`);
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
    if (c.decision.result !== "fit") throw new Error("Only companies that qualified as a fit can continue.");
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
