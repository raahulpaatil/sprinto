// Discovery search criteria. These only shape which companies the model suggests. Qualification (qualify.ts) never reads
// them: every suggestion is still judged against Sprinto's fixed target, whatever was searched for.

export const STAGES = {
  pre_seed: "Pre-seed",
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
  series_c: "Series C",
  series_d_plus: "Series D+",
  bootstrapped: "Bootstrapped",
  public: "Public",
  any: "Any stage",
} as const;
export const HEADCOUNTS = {
  "1-10": "1 to 10",
  "11-50": "11 to 50",
  "50-200": "50 to 200",
  "201-500": "201 to 500",
  "501-1000": "501 to 1,000",
  "1000+": "Over 1,000",
  any: "Any size",
} as const;
export const MODELS = {
  b2b_saas: "B2B SaaS",
  b2b_software: "B2B software (not SaaS)",
  b2c_software: "Consumer software",
  marketplace: "Marketplace",
  fintech_platform: "Fintech or payments platform",
  services: "Services or agency",
  any: "Any business model",
} as const;
export const CERT_STATUSES = {
  none_held: "No public certification held",
  held: "Holds a public certification",
  any: "Any certification status",
} as const;
export const CERT_TYPES = { soc2: "SOC 2", iso27001: "ISO 27001", gdpr: "GDPR" } as const;

export type Stage = keyof typeof STAGES;
export type Headcount = keyof typeof HEADCOUNTS;
export type Model = keyof typeof MODELS;
export type CertStatus = keyof typeof CERT_STATUSES;
export type CertType = keyof typeof CERT_TYPES;

export interface Criteria {
  stages: Stage[];
  headcount: Headcount;
  model: Model;
  certStatus: CertStatus;
  certTypes: CertType[];
  /** Free-text industry or geography guidance. */
  note: string;
}

export const NOTE_MAX = 300;

/** Sprinto's target profile, used as the search defaults. */
export const DEFAULT_CRITERIA: Criteria = {
  stages: ["series_a", "series_b", "series_c"],
  headcount: "50-200",
  model: "b2b_saas",
  certStatus: "none_held",
  certTypes: ["soc2", "iso27001", "gdpr"],
  note: "",
};

const has = <T extends object>(o: T, k: unknown): k is keyof T => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const ORDER = <T extends object>(o: T) => Object.keys(o) as (keyof T)[];

export type ParseResult = { ok: true; criteria: Criteria } | { ok: false; error: string };

/** Strict allowlist parse. Missing fields take the default; unknown values are rejected, never silently dropped. */
export function parseCriteria(input: unknown): ParseResult {
  if (input === undefined || input === null) return { ok: true, criteria: { ...DEFAULT_CRITERIA } };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Search criteria must be an object." };
  const o = input as Record<string, unknown>;
  const c: Criteria = { ...DEFAULT_CRITERIA, stages: [...DEFAULT_CRITERIA.stages], certTypes: [...DEFAULT_CRITERIA.certTypes] };

  if (o.stages !== undefined) {
    if (!Array.isArray(o.stages) || o.stages.length === 0) return { ok: false, error: "Pick at least one funding stage." };
    const bad = o.stages.find((s) => !has(STAGES, s));
    if (bad !== undefined) return { ok: false, error: `Unknown funding stage: ${String(bad).slice(0, 40)}` };
    const set = new Set(o.stages as Stage[]);
    c.stages = set.has("any") ? ["any"] : ORDER(STAGES).filter((s) => set.has(s));
  }
  if (o.headcount !== undefined) {
    if (!has(HEADCOUNTS, o.headcount)) return { ok: false, error: `Unknown headcount range: ${String(o.headcount).slice(0, 40)}` };
    c.headcount = o.headcount;
  }
  if (o.model !== undefined) {
    if (!has(MODELS, o.model)) return { ok: false, error: `Unknown business model: ${String(o.model).slice(0, 40)}` };
    c.model = o.model;
  }
  if (o.certStatus !== undefined) {
    if (!has(CERT_STATUSES, o.certStatus)) return { ok: false, error: `Unknown certification status: ${String(o.certStatus).slice(0, 40)}` };
    c.certStatus = o.certStatus;
  }
  if (o.certTypes !== undefined) {
    if (!Array.isArray(o.certTypes)) return { ok: false, error: "Certification types must be a list." };
    const bad = o.certTypes.find((s) => !has(CERT_TYPES, s));
    if (bad !== undefined) return { ok: false, error: `Unknown certification type: ${String(bad).slice(0, 40)}` };
    const set = new Set(o.certTypes as CertType[]);
    c.certTypes = ORDER(CERT_TYPES).filter((t) => set.has(t));
  }
  if (c.certStatus !== "any" && c.certTypes.length === 0) return { ok: false, error: "Pick at least one certification type, or set certification status to any." };
  if (o.note !== undefined) {
    if (typeof o.note !== "string") return { ok: false, error: "Guidance must be text." };
    c.note = o.note.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, NOTE_MAX);
  }
  return { ok: true, criteria: c };
}

export function isDefault(c: Criteria): boolean {
  return (
    c.stages.join() === DEFAULT_CRITERIA.stages.join() &&
    c.headcount === DEFAULT_CRITERIA.headcount &&
    c.model === DEFAULT_CRITERIA.model &&
    c.certStatus === DEFAULT_CRITERIA.certStatus &&
    c.certTypes.join() === DEFAULT_CRITERIA.certTypes.join() &&
    c.note.trim() === ""
  );
}

const certList = (c: Criteria) => {
  const n = c.certTypes.map((t) => CERT_TYPES[t]);
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} or ${n[n.length - 1]}` : n.join("");
};

/** One human-readable line, used in the candidate list and the saved run. */
export function summarize(c: Criteria): string {
  const parts = [
    c.stages.includes("any") ? STAGES.any : c.stages.map((s) => STAGES[s]).join(", "),
    c.headcount === "any" ? HEADCOUNTS.any : `${HEADCOUNTS[c.headcount]} employees`,
    MODELS[c.model],
    c.certStatus === "any" ? CERT_STATUSES.any : c.certStatus === "none_held" ? `No ${certList(c)} held` : `Holds ${certList(c)}`,
  ];
  if (c.note) parts.push(`"${c.note}"`);
  return parts.join(" · ");
}

/** The model prompt built from the selection. Each line is a constraint the model is asked to respect. */
export function discoveryPrompt(c: Criteria): string {
  const lines: string[] = ["Suggest companies that match ALL of these search criteria:"];
  lines.push(c.stages.includes("any") ? "- Funding stage: any." : `- Funding stage: ${c.stages.map((s) => STAGES[s]).join(" or ")}.`);
  lines.push(c.headcount === "any" ? "- Employee count: any." : `- Employee count: roughly ${HEADCOUNTS[c.headcount].toLowerCase()}.`);
  lines.push(c.model === "any" ? "- Business model: any." : `- Business model: ${MODELS[c.model]}.`);
  if (c.certStatus === "none_held") lines.push(`- Certifications: does NOT publicly hold ${c.certTypes.map((t) => CERT_TYPES[t]).join(" or ")} yet (but would plausibly be asked for it by enterprise customers).`);
  else if (c.certStatus === "held") lines.push(`- Certifications: publicly holds at least one of ${certList(c)}.`);
  else lines.push("- Certifications: any.");
  if (c.note) lines.push(`- Extra guidance from the user (industry, geography or similar): ${c.note}`);
  return lines.join("\n");
}
