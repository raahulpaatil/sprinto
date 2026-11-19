// Shared types for the Sprinto research pipeline.

export type Confidence = "stated" | "proxy" | "unknown";

export interface Evidence {
  url: string;
  quote: string;
}

/** One extracted fact. A fact with no verified quote is always value=null / unknown. */
export interface Fact<T> {
  value: T | null;
  confidence: Confidence;
  evidence: Evidence | null;
  note?: string;
}

export type CertName = "SOC 2" | "ISO 27001" | "GDPR" | string;

export interface Certification {
  name: CertName;
  status: "held" | "in_progress" | "mentioned";
  evidence: Evidence;
}

export interface Signal {
  text: string;
  evidence: Evidence;
}

export type FundingStage =
  | "pre_seed"
  | "seed"
  | "series_a"
  | "series_b"
  | "series_c"
  | "series_d_plus"
  | "public"
  | "bootstrapped";

export interface CompanyFacts {
  company_name: Fact<string>;
  one_liner: Fact<string>;
  is_b2b_saas: Fact<boolean>;
  funding_stage: Fact<FundingStage>;
  employee_count: Fact<number>;
  open_roles: Fact<number>;
  enterprise_pricing: Fact<boolean>;
  certifications: Certification[];
  signals: Signal[];
  conflicts: string[];
}

export type Decision = "fit" | "skip" | "manual_review" | "pending";

export interface PageRecord {
  url: string;
  kind: string; // home | about | product | pricing | careers | security | customers | other
  ok: boolean;
  status?: number;
  error?: string;
  chars: number;
  /** Cleaned text (capped). Kept so quotes can be re-verified later. */
  text?: string;
}

export interface LogEntry {
  t: string;
  stage: string;
  msg: string;
}

export interface Qualification {
  result: Decision | "needs_research";
  reasons: string[];
  flags: string[];
  missing: string[];
  stageProxies: string[];
}

export interface DecisionRecord {
  result: Decision;
  reasons: string[];
  flags: string[];
  missing: string[];
  stageProxies: string[];
}

export interface Contact {
  name: string;
  role: string;
  email?: string;
  confidence?: number;
  source: "hunter" | "manual";
  why: string;
}

export interface Pain {
  pain: string;
  reasoning: string;
  evidence: Evidence;
  grounded: boolean;
  certainty: "high" | "medium" | "low";
}

export interface Draft {
  subject: string;
  body: string;
  hook: string;
  hookEvidence: Evidence;
  hookGrounded: boolean;
  uncertainFields: string[];
  /** Set when the company is still a manual-review case: the draft is explicitly labelled and the decision is unchanged. */
  label?: "manual_review";
  problems: string[];
  status: "ready" | "needs_review" | "ungrounded";
}

export type SendStatus =
  | "sent"
  | "not_configured"
  | "blocked"
  | "not_attempted"
  | "failed"
  | "unknown"
  | "duplicate_prevented"
  | "in_flight";

export interface SendResult {
  status: SendStatus;
  to?: string;
  messageId?: string;
  note: string;
  at: string;
}

export interface ResearchState {
  loops: number;
  cap: number;
  steps: { field: string; url: string | null; ok: boolean; note?: string }[];
  exhausted: boolean;
}

export type CompanyStatus = "queued" | "running" | "done" | "error";

export interface CompanyRecord {
  id: string;
  runId: string;
  domain: string;
  expectedName?: string;
  /** Contact the user typed in up front; used only when Hunter finds nobody. */
  hintContact?: { name: string; role: string };
  sendEnabled: boolean;
  status: CompanyStatus;
  stage: string;
  pages: PageRecord[];
  facts?: CompanyFacts;
  droppedClaims: string[];
  research: ResearchState;
  decision: DecisionRecord;
  contact?: Contact;
  contactSkip?: string;
  pains?: Pain[];
  draft?: Draft;
  send?: SendResult;
  error?: string;
  log: LogEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  mode: "paste" | "discover";
  sendEnabled: boolean;
  companyIds: string[];
  createdAt: string;
  note?: string;
  /** Set on every run created through the app. Only runs with this flag are readable, and only through their own unguessable id. */
  public?: boolean;
}
