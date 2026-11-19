// Step 0 (optional): suggest candidate domains matching the ICP. Suggestions come from the model's memory,
// are labelled unverified, and every one still goes through the full scrape/qualify pipeline.

import dns from "node:dns/promises";
import type { LLM } from "./gemini";
import { normalizeDomain } from "./fetcher";
import { limits } from "./limits";

export const ICP_TEXT =
  "B2B SaaS companies at Series A-C (roughly 50-200 employees) that sell to businesses and likely face SOC 2 / ISO 27001 / GDPR pressure from enterprise customers but do not publicly hold those certifications yet.";

const SYSTEM = `You suggest real companies for a sales research list. Only suggest companies whose website domain you are confident exists.
This is a memory-based suggestion list: it is NOT verified and may be out of date. Do not claim funding or headcount.
Return ONLY JSON: {"candidates":[{"domain":"example.com","name":"Example","why":"one short reason it might fit the ICP"}]}
Give at most 5 candidates. No duplicates. No big public companies.`;

export interface Candidate {
  domain: string;
  name: string;
  why: string;
}

export async function discoverDomains(extra: string | undefined, llm: LLM): Promise<Candidate[]> {
  const prompt = `ICP: ${ICP_TEXT}${extra?.trim() ? `\nExtra guidance from the user: ${extra.trim().slice(0, 300)}` : ""}`;
  const raw = (await llm({ kind: "discover", system: SYSTEM, prompt, temperature: 0.7 })) as { candidates?: unknown };
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(raw?.candidates) ? raw.candidates : []) {
    const o = c as Record<string, unknown>;
    const d = typeof o.domain === "string" ? normalizeDomain(o.domain) : null;
    if (!d || seen.has(d)) continue;
    try {
      await dns.lookup(d); // drop domains that do not resolve at all
    } catch {
      continue;
    }
    seen.add(d);
    out.push({ domain: d, name: typeof o.name === "string" ? o.name.slice(0, 80) : d, why: typeof o.why === "string" ? o.why.slice(0, 160) : "" });
    if (out.length >= limits.maxDiscoveryResults) break;
  }
  return out;
}
