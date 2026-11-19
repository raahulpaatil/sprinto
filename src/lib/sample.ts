// Static sample output shown to public visitors. It is a frozen example built from public website text
// (a company that was correctly skipped). It is not live data, and visitors cannot trigger any live call.
import type { CompanyRecord } from "./types";

const q = (url: string, quote: string) => ({ url, quote });
const HOME = "https://resend.com/";
const PRICING = "https://resend.com/pricing";
const ABOUT = "https://resend.com/about";

export const SAMPLE: CompanyRecord = {
  id: "sample",
  runId: "sample",
  domain: "resend.com",
  sendEnabled: false,
  status: "done",
  stage: "done",
  pages: [
    { url: HOME, kind: "home", ok: true, status: 200, chars: 7000 },
    { url: PRICING, kind: "pricing", ok: true, status: 200, chars: 7000 },
    { url: ABOUT, kind: "about", ok: true, status: 200, chars: 4530 },
  ],
  facts: {
    company_name: { value: "Resend", confidence: "stated", evidence: q(HOME, "Resend is transforming email for developers.") },
    one_liner: { value: "Deliver transactional and marketing emails at scale.", confidence: "stated", evidence: q(HOME, "Deliver transactional and marketing emails at scale.") },
    is_b2b_saas: { value: true, confidence: "stated", evidence: q(PRICING, "The plans are Free, Pro, Scale, and Enterprise.") },
    funding_stage: { value: "series_a", confidence: "proxy", evidence: q(ABOUT, "Resend raises $18M Series A") },
    employee_count: { value: null, confidence: "unknown", evidence: null },
    open_roles: { value: null, confidence: "unknown", evidence: null },
    enterprise_pricing: { value: true, confidence: "proxy", evidence: q(PRICING, "On Enterprise, your domain limit is set in your contract.") },
    certifications: [
      { name: "SOC 2", status: "held", evidence: q(PRICING, "SOC 2 Type II certification") },
    ],
    signals: [],
    conflicts: [],
  },
  droppedClaims: [],
  research: { loops: 0, cap: 2, steps: [], exhausted: false },
  decision: {
    result: "skip",
    reasons: ['Already holds SOC 2. Evidence: "SOC 2 Type II certification"'],
    flags: [],
    missing: [],
    stageProxies: ["named funding stage on site: series a (proxy, not proof)", "enterprise pricing tier (proxy, not proof)"],
  },
  log: [],
  createdAt: "2026-11-19T08:06:26.000Z",
  updatedAt: "2026-11-19T08:06:36.000Z",
};
