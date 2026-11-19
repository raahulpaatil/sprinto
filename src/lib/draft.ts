// Steps 5-6: the two most likely pain points and a personalised first email, both grounded in scraped evidence.
// The model must cite verbatim quotes; code verifies them. An ungrounded hook blocks sending.

import type { LLM } from "./gemini";
import { norm, verifyQuote, type PageInput } from "./extract";
import type { CompanyFacts, Contact, Draft, Pain } from "./types";

export const DRAFT_SYSTEM = `You are the Growth Lead at Sprinto, a compliance-automation SaaS that gets B2B SaaS companies ready for SOC 2, ISO 27001 and GDPR.
Write a short, honest first cold email to ONE named person, plus the two most likely pain points that person has.
Hard rules:
- Use ONLY the facts and page text provided. Do not invent customers, numbers, funding, headcount, deadlines or events.
- Facts marked UNCERTAIN or missing must NOT be stated as facts. List them in "uncertain_fields" and write around them.
- Pains: exactly two, chosen from things like audit preparation effort, enterprise-customer security reviews / certification pressure, security questionnaires, scaling compliance with headcount. Each pain needs "quote" (VERBATIM from the page text) and "url" of the page, plus short "reasoning" linking the quote to the pain. If the evidence only weakly supports it, set certainty to "low".
- NEVER say, assume or imply that the company holds, has completed, maintains, renews or is re-certifying SOC 2, ISO 27001 or GDPR. They were qualified as NOT holding a certification (or their status is unresolved), so write about the PRESSURE to get certified: enterprise buyers asking for it, procurement and security reviews, questionnaires, deal friction. Do not use words like "maintain", "maintenance", "renew", "keep your SOC 2", "your existing/current certification".
- Email: under 120 words, plain text, addressed by first name, one specific hook that refers to something concrete from the page text, one clear low-pressure ask. No flattery, no fake familiarity, no claims about their funding unless a verified fact says so.
- "hook" is the one-sentence hook. "hook_quote" is a VERBATIM excerpt from the page text that the hook is based on; "hook_url" is its page.
Return ONLY JSON:
{"pains":[{"pain":string,"reasoning":string,"quote":string,"url":string,"certainty":"high"|"medium"|"low"}],
 "email":{"subject":string,"body":string,"hook":string,"hook_quote":string,"hook_url":string,"uncertain_fields":[string]}}`;

function factLine(label: string, f: { value: unknown; confidence: string; evidence: { quote: string; url: string } | null }): string {
  if (f.value === null || f.value === undefined || !f.evidence) return `- ${label}: UNCERTAIN (not found on the pages)`;
  return `- ${label}: ${String(f.value)} [${f.confidence}] evidence: "${f.evidence.quote}" (${f.evidence.url})`;
}

/** One sentence telling the model what the qualification actually established about certifications. */
export function certBasis(facts: CompanyFacts, status?: string): string {
  const prog = facts.certifications.filter((c) => c.status === "in_progress");
  if (prog.length) return `The company says it is PREPARING for ${prog.map((c) => c.name).join(", ")} (not yet held): "${prog[0].evidence.quote}". Write about the effort and pressure of getting there, not about maintaining anything.`;
  if (facts.certifications.length > 0 || status === "manual_review") return "Certification status is UNRESOLVED: do not state or assume whether they hold any certification. Write only about general certification pressure from enterprise buyers.";
  return "No certification claim was found anywhere on the pages checked. Do not assume they hold one. Write about the pressure to get certified.";
}

/** True if text assumes the prospect already holds / maintains a certification, which the qualification basis contradicts. */
export function assumesHeldCert(text: string): boolean {
  return /\b(maintain(s|ing|ed)?|maintenance|renew(s|ing|al|als)?|re-?certif\w*|recertif\w*|keep(ing)? (your |the )?(soc|iso|gdpr)|sustain(ing)? (your |the )?(soc|iso|gdpr)|your (existing|current|latest) (soc|iso|gdpr|certif\w*|audit report|report)|already (certified|compliant|soc|iso|gdpr)|since (you are|you\u2019re|you're) (soc|iso|gdpr|certified|compliant)|annual (soc|iso|audit|recertif\w*)|(soc 2|iso 27001|gdpr)[^.]{0,40}\b(upkeep|ongoing compliance|continuous compliance)\b)/i.test(text);
}

export function draftPrompt(contact: Contact, facts: CompanyFacts, domain: string, pages: PageInput[], feedback?: string, status?: string): string {
  const certs = facts.certifications.length
    ? facts.certifications.map((c) => `- ${c.name}: ${c.status} evidence: "${c.evidence.quote}" (${c.evidence.url})`).join("\n")
    : "- none found on the pages checked";
  const signals = facts.signals.length ? facts.signals.map((s) => `- ${s.text}: "${s.evidence.quote}" (${s.evidence.url})`).join("\n") : "- none";
  return [
    `RECIPIENT: ${contact.name}, ${contact.role} at ${facts.company_name.value ?? domain} (${domain}). Address them as "${contact.name.split(" ")[0]}".`,
    `VERIFIED FACTS:`,
    factLine("company", facts.company_name),
    factLine("what they do", facts.one_liner),
    factLine("funding stage (self-reported, a proxy)", facts.funding_stage),
    factLine("headcount", facts.employee_count),
    factLine("open roles", facts.open_roles),
    factLine("enterprise pricing tier", facts.enterprise_pricing),
    `CERTIFICATIONS:\n${certs}`,
    `CERTIFICATION BASIS (binding): ${certBasis(facts, status)}`,
    `SIGNALS:\n${signals}`,
    feedback ? `FIX THESE PROBLEMS FROM YOUR LAST ATTEMPT: ${feedback}` : "",
    `PAGE TEXT (quotes must be copied from here exactly):`,
    pages.map((p) => `=== ${p.kind} ${p.url} ===\n${p.text.slice(0, 3500)}`).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

interface RawOut {
  pains?: unknown;
  email?: unknown;
}
const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function validateDraft(
  raw: unknown,
  contact: Contact,
  pages: PageInput[],
  corpus?: string,
): { pains: Pain[]; draft: Draft } {
  const r = raw as RawOut;
  const rawPains = Array.isArray(r?.pains) ? r.pains.slice(0, 2) : [];
  const pains: Pain[] = rawPains.map((p) => {
    const po = o(p);
    const where = verifyQuote(po.quote, po.url, pages);
    const cert = po.certainty === "high" || po.certainty === "medium" || po.certainty === "low" ? po.certainty : "low";
    return {
      pain: s(po.pain, 200),
      reasoning: s(po.reasoning, 400),
      evidence: { url: where ?? s(po.url, 300), quote: s(po.quote, 220) },
      grounded: !!where,
      certainty: where ? cert : "low",
    };
  });

  const e = o(r?.email);
  const body = s(e.body);
  const subject = s(e.subject, 160);
  const hook = s(e.hook, 400);
  const hookWhere = verifyQuote(e.hook_quote, e.hook_url, pages);
  const problems: string[] = [];
  if (pains.length < 2) problems.push(`Only ${pains.length} pain point(s) returned; two are required.`);
  pains.forEach((p, i) => {
    if (!p.grounded) problems.push(`Pain ${i + 1} ("${p.pain}") quotes text that is not on any fetched page.`);
  });
  if (!hookWhere) problems.push("The email hook is not grounded: its quote was not found on any fetched page.");
  if (!body || !subject) problems.push("Subject or body is empty.");
  if (assumesHeldCert(`${subject} ${body} ${hook}`)) problems.push("The email assumes the company already holds or maintains a certification (wording like maintain/renew/existing certification). The qualification basis says they do not hold one or it is unresolved, so the draft must talk about certification pressure instead.");
  const first = contact.name.split(" ")[0];
  if (body && !norm(body).includes(norm(first))) problems.push(`Email does not address ${first} by name.`);
  if (body.split(/\s+/).length > 170) problems.push("Email is longer than 170 words.");
  // Numbers in the email must exist somewhere in the evidence (guards against invented stats).
  const text = norm(corpus ?? pages.map((p) => p.text).join(" "));
  // The length of the ask ("15 minute call") is not a company fact, so it is exempt.
  const factual = body.replace(/\b\d+[-\s]?(min|mins|minute|minutes)\b/gi, " ");
  for (const m of factual.match(/\b\d[\d,.]*\b/g) ?? []) {
    const n = norm(m);
    if (n.length >= 2 && n !== "27001" && !text.includes(n)) problems.push(`Email states the number "${m}" which is not in the evidence.`);
  }
  const uncertain = Array.isArray(e.uncertain_fields) ? e.uncertain_fields.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  const hookGrounded = !!hookWhere;
  const painsOk = pains.length === 2 && pains.every((p) => p.grounded);
  const status: Draft["status"] = !hookGrounded ? "ungrounded" : problems.length > 0 || !painsOk ? "needs_review" : "ready"; // any problem (including a held-cert assumption) blocks sending
  return {
    pains,
    draft: {
      subject,
      body,
      hook,
      hookEvidence: { url: hookWhere ?? s(e.hook_url, 300), quote: s(e.hook_quote, 220) },
      hookGrounded,
      uncertainFields: uncertain,
      problems,
      status,
    },
  };
}

/** One generation, one corrective retry when something is ungrounded. Never "fixes" a draft by inventing evidence. */
export async function writeDraft(
  contact: Contact,
  facts: CompanyFacts,
  domain: string,
  pages: PageInput[],
  llm: LLM,
  decision?: string,
): Promise<{ pains: Pain[]; draft: Draft }> {
  let result = validateDraft(await llm({ kind: "draft", system: DRAFT_SYSTEM, prompt: draftPrompt(contact, facts, domain, pages, undefined, decision), temperature: 0.4 }), contact, pages);
  if (result.draft.status !== "ready") {
    const feedback = result.draft.problems.join(" ");
    const retry = validateDraft(
      await llm({ kind: "draft", system: DRAFT_SYSTEM, prompt: draftPrompt(contact, facts, domain, pages, feedback, decision), temperature: 0.2 }),
      contact,
      pages,
    );
    const rank = { ready: 0, needs_review: 1, ungrounded: 2 } as const;
    if (rank[retry.draft.status] <= rank[result.draft.status]) result = retry;
  }
  return result;
}

export function composeEmailText(opts: {
  draftBody: string;
  subject: string;
  contact: Contact;
  company: string;
  domain: string;
  hook: string;
  hookQuote: string;
  hookUrl: string;
  pains: Pain[];
  uncertain: string[];
  banner?: string;
}): string {
  const lines = [
    "SPRINTO PREVIEW - sent to you only. The prospect was NOT emailed.",
    ...(opts.banner ? [opts.banner] : []),
    `Would be addressed to: ${opts.contact.name}, ${opts.contact.role} at ${opts.company} (${opts.domain})`,
    "------------------------------------------------------------",
    `Subject: ${opts.subject}`,
    "",
    opts.draftBody,
    "------------------------------------------------------------",
    `Hook: ${opts.hook}`,
    `Hook evidence: "${opts.hookQuote}" (${opts.hookUrl})`,
    ...opts.pains.map((p, i) => `Pain ${i + 1} [${p.certainty}${p.grounded ? "" : ", UNGROUNDED"}]: ${p.pain} - ${p.reasoning}`),
    opts.uncertain.length ? `Uncertain (not stated as fact): ${opts.uncertain.join("; ")}` : "Uncertain: none flagged",
  ];
  return lines.join("\n");
}
