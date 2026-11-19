// Step 0: suggest candidate domains for the selected search criteria. Suggestions come from the model's memory,
// are labelled unverified, and every one still goes through the full scrape/qualify pipeline against Sprinto's target.

import dns from "node:dns/promises";
import type { LLM } from "./gemini";
import { normalizeDomain } from "./fetcher";
import { limits } from "./limits";
import { DEFAULT_CRITERIA, discoveryPrompt, type Criteria } from "./criteria";

const SYSTEM = `You suggest real companies for a sales research list. Only suggest companies whose website domain you are confident exists.
This is a memory-based suggestion list: it is NOT verified and may be out of date. Do not claim funding or headcount as fact.
Return ONLY JSON: {"candidates":[{"domain":"example.com","name":"Example","why":"one short reason it might match the criteria"}]}
Give at most 5 candidates. No duplicates. If nothing fits well, return fewer candidates rather than poor matches.`;

export interface Candidate {
  domain: string;
  name: string;
  why: string;
}

/** Resolves a hostname or throws. Injected so tests never depend on the network. */
export type Lookup = (host: string) => Promise<unknown>;

export async function discoverDomains(criteria: Criteria = DEFAULT_CRITERIA, llm: LLM, lookup: Lookup = (h) => dns.lookup(h)): Promise<Candidate[]> {
  const raw = (await llm({ kind: "discover", system: SYSTEM, prompt: discoveryPrompt(criteria), temperature: 0.7 })) as { candidates?: unknown };
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(raw?.candidates) ? raw.candidates : []) {
    const o = c as Record<string, unknown>;
    const d = typeof o.domain === "string" ? normalizeDomain(o.domain) : null;
    if (!d || seen.has(d)) continue;
    try {
      await lookup(d); // drop domains that do not resolve at all
    } catch {
      continue;
    }
    seen.add(d);
    out.push({ domain: d, name: typeof o.name === "string" ? o.name.slice(0, 80) : d, why: typeof o.why === "string" ? o.why.slice(0, 160) : "" });
    if (out.length >= limits.maxDiscoveryResults) break;
  }
  return out;
}
