// Step 2: structured fact extraction with Gemini. Every fact must carry a verbatim quote from a fetched page;
// quotes are checked in code and unverified claims are dropped (never kept as facts).

import type { LLM } from "./gemini";
import type { Certification, CompanyFacts, Confidence, Evidence, Fact, FundingStage, Signal } from "./types";

export interface PageInput {
  url: string;
  kind: string;
  text: string;
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Returns the URL of the page containing the quote (verbatim, ignoring case/punctuation/whitespace), else null. */
export function verifyQuote(quote: unknown, url: unknown, pages: PageInput[]): string | null {
  if (typeof quote !== "string") return null;
  const q = norm(quote.replace(/(\.\.\.|…)/g, " "));
  if (q.length < 12) return null;
  const ordered = [...pages].sort((a, b) => (a.url === url ? -1 : b.url === url ? 1 : 0));
  for (const p of ordered) if (norm(p.text).includes(q)) return p.url;
  return null;
}

export const EXTRACT_SYSTEM = `You extract facts about a company from the text of its own website pages.
Hard rules:
- Use ONLY the page text provided. Never use outside knowledge. Never guess.
- Every non-null fact needs "quote": a short VERBATIM excerpt (under 200 characters) copied exactly from the page text that supports it, and "url": the page URL it came from.
- If the pages do not state a fact, set value to null (and quote/url to null). Do not infer headcount, funding or certifications from tone.
- certifications: list SOC 2, ISO 27001 and GDPR mentions. status "held" ONLY if the page says this company itself is certified/compliant/has completed the audit or holds the report. Use "in_progress" if it says preparing/working toward/pursuing. Use "mentioned" if the page only talks about helping customers get it, or the mention is unclear.
- is_b2b_saas: true only if the company sells software as a service to businesses. false if the pages clearly show something else (restaurant, consumer app, agency, hardware, marketplace for consumers, etc.). Otherwise null.
- funding_stage: one of pre_seed, seed, series_a, series_b, series_c, series_d_plus, public, bootstrapped. Only if a page names it.
- employee_count: a number only if a page states a headcount or range (use the midpoint of a range).
- open_roles: number of open job listings, only if a careers page lists them.
- enterprise_pricing: true if a pricing page shows an Enterprise / contact-sales tier, false if a pricing page shows no such tier, else null.
- signals: up to 5 short evidence-backed observations useful for outreach (hiring security roles, enterprise customers named, regulated-industry customers, compliance pages). Each needs quote+url.
- conflicts: list any facts the pages contradict each other on (e.g. two different funding stages). Empty array if none.
Return ONLY JSON with this shape:
{
 "company_name": {"value": string|null, "quote": string|null, "url": string|null},
 "one_liner": {"value": string|null, "quote": string|null, "url": string|null},
 "is_b2b_saas": {"value": boolean|null, "quote": string|null, "url": string|null},
 "funding_stage": {"value": string|null, "quote": string|null, "url": string|null},
 "employee_count": {"value": number|null, "quote": string|null, "url": string|null},
 "open_roles": {"value": number|null, "quote": string|null, "url": string|null},
 "enterprise_pricing": {"value": boolean|null, "quote": string|null, "url": string|null},
 "certifications": [{"name": string, "status": "held"|"in_progress"|"mentioned", "quote": string, "url": string}],
 "signals": [{"text": string, "quote": string, "url": string}],
 "conflicts": [string]
}`;

const STAGES: Record<string, FundingStage> = {
  pre_seed: "pre_seed", "pre-seed": "pre_seed", preseed: "pre_seed",
  seed: "seed",
  series_a: "series_a", "series a": "series_a",
  series_b: "series_b", "series b": "series_b",
  series_c: "series_c", "series c": "series_c",
  series_d_plus: "series_d_plus", series_d: "series_d_plus", series_e: "series_d_plus", "series d": "series_d_plus", "series d+": "series_d_plus",
  public: "public", ipo: "public",
  bootstrapped: "bootstrapped",
};

function emptyFact<T>(note?: string): Fact<T> {
  return { value: null, confidence: "unknown", evidence: null, note };
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function buildFact<T>(
  field: string,
  raw: unknown,
  pages: PageInput[],
  conf: Confidence,
  coerce: (v: unknown) => T | null,
  dropped: string[],
): Fact<T> {
  const o = asObj(raw);
  const value = coerce(o.value);
  if (value === null || value === undefined) return emptyFact();
  const where = verifyQuote(o.quote, o.url, pages);
  if (!where) {
    dropped.push(`${field}: claimed "${String(value)}" but the quote was not found on any fetched page, so it was dropped`);
    return emptyFact("claim dropped: no verifiable quote");
  }
  return { value, confidence: conf, evidence: { url: where, quote: String(o.quote).slice(0, 220) } };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const stage = (v: unknown): FundingStage | null => (typeof v === "string" ? STAGES[v.toLowerCase().trim()] ?? null : null);

export function normCertName(name: string): string {
  if (/soc\s*-?\s*2/i.test(name)) return "SOC 2";
  if (/iso\s*\/?\s*(iec)?\s*27001/i.test(name)) return "ISO 27001";
  if (/gdpr/i.test(name)) return "GDPR";
  return name.slice(0, 40);
}
const CERT_QUOTE_RE: Record<string, RegExp> = {
  "SOC 2": /soc\s*-?\s*2/i,
  "ISO 27001": /27001/i,
  GDPR: /gdpr/i,
};
const NOT_YET_RE = /(in progress|working (to|toward|towards)|preparing|pursuing|plan to|planning|soon|coming|roadmap|help(s|ing)?\s+(you|your|teams|companies|customers|startups|businesses)|get(ting)?\s+(you\s+)?(soc|iso|gdpr)|achieve|automate|readiness|ready for)/i;

export function parseFacts(raw: unknown, pages: PageInput[]): { facts: CompanyFacts; dropped: string[] } {
  const o = asObj(raw);
  const dropped: string[] = [];
  const certs: Certification[] = [];
  for (const c of Array.isArray(o.certifications) ? o.certifications : []) {
    const co = asObj(c);
    const name = typeof co.name === "string" ? normCertName(co.name) : "";
    const where = verifyQuote(co.quote, co.url, pages);
    const status = co.status === "held" || co.status === "in_progress" || co.status === "mentioned" ? co.status : "mentioned";
    if (!name) continue;
    if (!where) {
      dropped.push(`certification ${name}: quote not found on any fetched page, so it was dropped`);
      continue;
    }
    const quote = String(co.quote).slice(0, 220);
    const re = CERT_QUOTE_RE[name];
    if (re && !re.test(quote)) {
      dropped.push(`certification ${name}: quote does not mention ${name}, so it was dropped`);
      continue;
    }
    let st: Certification["status"] = status;
    if (st === "held" && NOT_YET_RE.test(quote)) st = "mentioned";
    certs.push({ name, status: st, evidence: { url: where, quote } });
  }
  const signals: Signal[] = [];
  for (const s of Array.isArray(o.signals) ? o.signals.slice(0, 5) : []) {
    const so = asObj(s);
    const where = verifyQuote(so.quote, so.url, pages);
    const text = str(so.text);
    if (!text) continue;
    if (!where) {
      dropped.push(`signal "${text.slice(0, 60)}": quote not found, so it was dropped`);
      continue;
    }
    signals.push({ text, evidence: { url: where, quote: String(so.quote).slice(0, 220) } });
  }
  const facts: CompanyFacts = {
    company_name: buildFact("company_name", o.company_name, pages, "stated", str, dropped),
    one_liner: buildFact("one_liner", o.one_liner, pages, "stated", str, dropped),
    is_b2b_saas: buildFact("is_b2b_saas", o.is_b2b_saas, pages, "stated", bool, dropped),
    funding_stage: buildFact("funding_stage", o.funding_stage, pages, "proxy", stage, dropped),
    employee_count: buildFact("employee_count", o.employee_count, pages, "stated", num, dropped),
    open_roles: buildFact("open_roles", o.open_roles, pages, "proxy", num, dropped),
    enterprise_pricing: buildFact("enterprise_pricing", o.enterprise_pricing, pages, "proxy", bool, dropped),
    certifications: certs,
    signals,
    conflicts: (Array.isArray(o.conflicts) ? o.conflicts : []).filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 5),
  };
  return { facts, dropped };
}

export function pagesPrompt(pages: PageInput[]): string {
  return pages.map((p) => `=== PAGE (${p.kind}) URL: ${p.url} ===\n${p.text}`).join("\n\n");
}

export async function extractFacts(pages: PageInput[], llm: LLM): Promise<{ facts: CompanyFacts; dropped: string[] }> {
  const raw = await llm({ kind: "extract", system: EXTRACT_SYSTEM, prompt: pagesPrompt(pages), temperature: 0 });
  return parseFacts(raw, pages);
}

export function evidenceOf(f: Fact<unknown>): Evidence | null {
  return f.evidence;
}

export function emptyFacts(): CompanyFacts {
  return {
    company_name: emptyFact(),
    one_liner: emptyFact(),
    is_b2b_saas: emptyFact(),
    funding_stage: emptyFact(),
    employee_count: emptyFact(),
    open_roles: emptyFact(),
    enterprise_pricing: emptyFact(),
    certifications: [],
    signals: [],
    conflicts: [],
  };
}
