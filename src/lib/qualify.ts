// Step 3: ICP qualification. Pure, deterministic rules over verified facts (the model never decides fit).
//
// ICP: B2B SaaS (hard). Funding stage Series A-C (hard). 50-200 employees (soft band, flagged only).
// Already holds SOC 2 / ISO 27001 / GDPR -> disqualified. Thin or conflicting evidence -> manual review.

import type { CompanyFacts, Qualification } from "./types";

export const TARGET_STAGES = ["series_a", "series_b", "series_c"];
export const HELD_CERTS = ["SOC 2", "ISO 27001", "GDPR"];
export const THIN_TEXT_CHARS = 400;

export interface QualifyCtx {
  /** Reason the page does not look like the intended company (redirect / name mismatch). */
  identityIssue?: string;
  homepageOk: boolean;
  /** Total cleaned characters across successfully fetched pages. */
  totalChars: number;
  /** Page kinds already fetched (to know whether the security page was actually checked). */
  fetchedKinds: string[];
  /** True once the research loop has used its whole budget. */
  exhausted: boolean;
  /** True when every conventional security/trust URL was probed and none exists. */
  securityExhausted?: boolean;
}

export function stageProxies(f: CompanyFacts): string[] {
  const out: string[] = [];
  if (f.funding_stage.value) out.push(`named funding stage on site: ${f.funding_stage.value.replace(/_/g, " ")} (proxy, not proof)`);
  if ((f.open_roles.value ?? 0) >= 5) out.push(`${f.open_roles.value} open roles (proxy, not proof)`);
  if (f.enterprise_pricing.value === true) out.push("enterprise pricing tier (proxy, not proof)");
  return out;
}

export function qualify(f: CompanyFacts, ctx: QualifyCtx): Qualification {
  const reasons: string[] = [];
  const flags: string[] = [];
  const missing: string[] = [];
  const proxies = stageProxies(f);
  const done = (result: Qualification["result"]): Qualification => ({ result, reasons, flags, missing, stageProxies: proxies });

  if (ctx.identityIssue) {
    reasons.push(`Possible wrong company: ${ctx.identityIssue}`);
    return done("manual_review");
  }
  if (!ctx.homepageOk) {
    reasons.push("Homepage could not be fetched, so there is no evidence to qualify on.");
    return done("manual_review");
  }

  // Hard disqualifiers first (they only need one verified quote).
  if (f.is_b2b_saas.value === false) {
    reasons.push(`Not a B2B SaaS company. Evidence: "${f.is_b2b_saas.evidence?.quote}"`);
    return done("skip");
  }
  const held = f.certifications.filter((c) => c.status === "held" && HELD_CERTS.includes(c.name));
  if (held.length > 0) {
    reasons.push(`Already holds ${held.map((c) => c.name).join(", ")}. Evidence: "${held[0].evidence.quote}"`);
    return done("skip");
  }
  const stage = f.funding_stage.value;
  if (stage && !TARGET_STAGES.includes(stage)) {
    reasons.push(`Funding stage is outside the Series A-C target (site names "${stage.replace(/_/g, " ")}"; a proxy, not proof).`);
    return done("skip");
  }

  if (f.conflicts.length > 0) {
    reasons.push(`Conflicting evidence: ${f.conflicts.join("; ")}`);
    return done("manual_review");
  }
  if (ctx.totalChars < THIN_TEXT_CHARS) {
    reasons.push(`Thin evidence: only ${ctx.totalChars} characters of usable text were found (the site may be script-rendered).`);
    return done("manual_review");
  }

  // Required fields for a confident "fit".
  // Order = research priority: SaaS and certification checks can end the search outright, stage rarely can.
  if (f.is_b2b_saas.value === null) missing.push("saas");
  const securityPageFetched = ctx.fetchedKinds.includes("security");
  const securityChecked = securityPageFetched || !!ctx.securityExhausted;
  // A certification mention that does not say whether THIS company holds it (a plan feature, a "SOC 2 and enterprise security"
  // bullet, "we help you get SOC 2") is ambiguous. in_progress is explicit not-held evidence; held already skipped above.
  const resolvedCerts = new Set(f.certifications.filter((c) => c.status !== "mentioned").map((c) => c.name));
  const ambiguous = f.certifications.filter((c) => c.status === "mentioned" && HELD_CERTS.includes(c.name) && !resolvedCerts.has(c.name));
  const ambiguityReasons = () =>
    ambiguous.map(
      (c) =>
        `Certification status is ambiguous: the site mentions ${c.name} ("${c.evidence.quote}", ${c.evidence.url}) but not in a way that says whether the company itself holds it. It may be a plan feature, a marketing line or a held certification. A qualified prospect must be under certification pressure WITHOUT holding it, and an ambiguous mention does not prove that, so a person needs to check.`,
    );
  if (!securityChecked && (f.certifications.length === 0 || ambiguous.length > 0)) missing.push("certs");
  const hasStageEvidence = !!stage || proxies.filter((p) => !p.startsWith("named")).length >= 2;
  if (!hasStageEvidence) missing.push("stage");

  if (missing.length > 0) {
    if (!ctx.exhausted) return done("needs_research");
    reasons.push(`Research budget exhausted while still missing: ${missing.join(", ")}.`);
    if (missing.includes("saas")) reasons.push("Could not confirm the company is B2B SaaS.");
    if (missing.includes("stage")) reasons.push("Stage unknown: no named funding stage and fewer than two stage proxies.");
    if (missing.includes("certs") && ambiguous.length === 0) reasons.push("Could not check certification status (no security/trust page found).");
    reasons.push(...ambiguityReasons());
    if (ambiguous.length > 0 && !missing.includes("cert_status")) missing.push("cert_status");
    return done("manual_review");
  }
  if (ambiguous.length > 0) {
    reasons.push(...ambiguityReasons());
    missing.push("cert_status");
    return done("manual_review");
  }

  // Fit. Label what the stage call rests on.
  reasons.push("B2B SaaS confirmed from the website.");
  if (stage) {
    reasons.push(`Stage ${stage.replace(/_/g, " ")} is named on the site. Treated as a proxy, not proof.`);
    flags.push("stage_is_proxy");
  } else {
    reasons.push(`Stage inferred only from proxies: ${proxies.join("; ")}.`);
    flags.push("stage_proxies_only");
  }
  const inProgress = f.certifications.filter((c) => c.status === "in_progress");
  if (inProgress.length) reasons.push(`Certification in progress (${inProgress.map((c) => c.name).join(", ")}): a warm buying signal, not a disqualifier.`);
  else if (securityPageFetched) reasons.push("No evidence of SOC 2 / ISO 27001 / GDPR already held on the security/trust page and other pages checked.");
  else {
    reasons.push("No public security/trust page exists at the standard paths we probed, and no certification claim appears on the pages checked. That is absence of evidence, not proof the company is uncertified.");
    flags.push("certs_unverified_no_security_page");
  }
  const emp = f.employee_count.value;
  if (emp === null) flags.push("headcount_unknown");
  else if (emp < 50 || emp > 200) flags.push(`headcount_outside_50_200 (${emp})`);
  else flags.push("headcount_in_band");
  return done("fit");
}

/** Which page kind to fetch next for a missing field, in order of usefulness. */
export function pageKindsFor(field: string): ("about" | "product" | "pricing" | "careers" | "security" | "customers" | "legal" | "press")[] {
  if (field === "certs") return ["security", "legal"];
  if (field === "stage") return ["careers", "about", "press", "customers", "pricing"];
  if (field === "saas") return ["product", "pricing", "about"];
  return ["about"];
}
