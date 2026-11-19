"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanyRecord, Fact } from "@/lib/types";
import { CERT_STATUSES, CERT_TYPES, DEFAULT_CRITERIA, HEADCOUNTS, isDefault, MODELS, NOTE_MAX, STAGES, summarize, type CertType, type Criteria, type Stage } from "@/lib/criteria";

type Health = {
  sendReady?: boolean;
  contactLookup?: boolean;
  gemini?: boolean;
  hunter?: boolean;
  hunterAccount?: { plan: string | null; used: number | null; available: number | null; resetDate: string | null } | null;
  store?: { kind: string; durable: boolean; ok: boolean };
  usageToday?: { companies: number; geminiCalls: number; sends: number; hunterThisMonth: number };
  caps?: { companiesGlobalPerDay: number; geminiDailyCallCap: number; hunterMonthlyCap: number; sendsGlobalPerDay: number };
  sendsOnlyTo?: string;
  allowance?: { runsLeftThisHourForYou: number; runsHourlyCap: number; companiesLeftToday: number; dailyResetsAtUtc: string; hourlyResetsAtUtc: string };
};
type Candidate = { domain: string; name: string; why: string };

const LS_RUN = "sprinto:lastRun";
const MISSING_TEXT: Record<string, string> = {
  cert_status: "Certification status is unclear: the site mentions a certification without saying the company itself holds it. Check its security or trust page.",
  saas: "B2B SaaS status: the pages checked don’t say clearly what the company sells or to whom.",
  stage: "Funding stage: the site names no stage, and there are fewer than two signals such as 5+ open roles or an enterprise plan.",
  certs: "Certifications: no security or trust page was found, so SOC 2, ISO 27001 and GDPR could not be checked.",
};
const FIELD_LABEL: Record<string, string> = { saas: "B2B SaaS status", stage: "funding stage", certs: "certifications", cert_status: "certification status" };
const FLAG_TEXT: Record<string, string> = {
  stage_is_proxy: "Stage named on the company’s site, not independently confirmed",
  stage_proxies_only: "Stage estimated from hiring and pricing signals",
  certs_unverified_no_security_page: "No security page found, so certifications are unconfirmed",
  headcount_unknown: "Headcount unknown",
  headcount_in_band: "Headcount within 50 to 200",
};
function flagText(f: string) {
  const m = f.match(/^headcount_outside_50_200 \((\d+)\)$/);
  return m ? `Headcount ${m[1]}, outside 50 to 200` : FLAG_TEXT[f] ?? f.replace(/_/g, " ");
}

async function api<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? (res.status === 504 ? "The server timed out on this company. Press Retry." : `Request failed (${res.status})`);
    throw new Error(msg);
  }
  return data as T;
}

const DECISION_LABEL: Record<string, string> = {
  fit: "Fit",
  skip: "Skip",
  manual_review: "Manual review",
  pending: "Pending",
};

/** Number that plays a short fade/rise once whenever its value changes. */
function Num({ v }: { v: number | string }) {
  return <span key={String(v)} className="num">{v}</span>;
}

function Conf({ c }: { c: string }) {
  return <span className={`conf ${c}`}>{c === "proxy" ? "proxy, not proof" : c}</span>;
}

function FactRow({ label, fact, fmt }: { label: string; fact: Fact<unknown>; fmt?: (v: unknown) => string }) {
  const known = fact.value !== null && fact.value !== undefined && fact.evidence;
  return (
    <tr>
      <td>{label}</td>
      <td>{known ? (fmt ? fmt(fact.value) : String(fact.value)) : <span className="uncertain">uncertain{fact.note ? ` (${fact.note})` : ""}</span>}</td>
      <td>{known ? <Conf c={fact.confidence} /> : null}</td>
      <td className="quote">
        {fact.evidence ? (
          <>
            “{fact.evidence.quote}” <a href={fact.evidence.url} target="_blank" rel="noreferrer">{shortUrl(fact.evidence.url)}</a>
          </>
        ) : null}
      </td>
    </tr>
  );
}

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname);
  } catch {
    return u;
  }
}

function Company({ c, onContact, onResend, busy, index = 0 }: { c: CompanyRecord; onContact: (id: string, name: string, role: string) => void; onResend: (id: string) => void; busy: boolean; index?: number }) {
  const [cName, setCName] = useState("");
  const [cRole, setCRole] = useState("");
  const decisionKey = c.status === "error" ? "error" : c.status === "queued" || c.status === "running" ? c.status : c.decision.result;
  const label = c.status === "error" ? "Error" : c.status === "queued" ? "Queued" : c.status === "running" ? `Running: ${c.stage}` : DECISION_LABEL[c.decision.result];
  const f = c.facts;
  const finished = c.status === "done";
  const inProgress = c.status === "running" || c.status === "queued";
  const lastLog = c.log[c.log.length - 1];
  return (
    <div className="card" style={{ "--i": Math.min(index, 8) } as React.CSSProperties}>
      <div className="co-head">
        <div>
          <div className="co-title">{f?.company_name.value ?? c.expectedName ?? c.domain}</div>
          <div className="hint">{c.domain}{c.expectedName ? ` · expected: ${c.expectedName}` : ""}</div>
        </div>
        <span className={`badge b-${decisionKey}`}>{label}</span>
      </div>
      {inProgress && (
        <div className="live" role="status" aria-live="polite">
          <span className="pulse" aria-hidden="true" />
          <span>{c.status === "queued" ? "Waiting to start" : `${c.stage}${lastLog ? `: ${lastLog.msg}` : ""}`}</span>
        </div>
      )}

      {c.error && <div className="err">{c.error}</div>}

      {finished && (
        <ul className="reasons">
          {c.decision.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {c.decision.flags.length > 0 && <li className="hint">Notes: {c.decision.flags.map(flagText).join("; ")}</li>}
          {c.decision.stageProxies.length > 0 && <li className="hint">Stage signals: {c.decision.stageProxies.join("; ")}</li>}
        </ul>
      )}

      {f && finished && (
        <details open={c.decision.result !== "fit"}>
          <summary>Evidence</summary>
          <table>
            <thead>
              <tr><th>Field</th><th>Value</th><th>Basis</th><th>Quote from the site</th></tr>
            </thead>
            <tbody>
              <FactRow label="Company" fact={f.company_name} />
              <FactRow label="What they do" fact={f.one_liner} />
              <FactRow label="B2B SaaS" fact={f.is_b2b_saas} fmt={(v) => (v ? "Yes" : "No")} />
              <FactRow label="Funding stage" fact={f.funding_stage} fmt={(v) => String(v).replace(/_/g, " ")} />
              <FactRow label="Employees" fact={f.employee_count} />
              <FactRow label="Open roles" fact={f.open_roles} />
              <FactRow label="Enterprise pricing tier" fact={f.enterprise_pricing} fmt={(v) => (v ? "Yes" : "No")} />
              {f.certifications.map((k, i) => (
                <tr key={i}>
                  <td>Certification</td>
                  <td>{k.name} ({k.status.replace("_", " ")})</td>
                  <td><Conf c="stated" /></td>
                  <td className="quote">“{k.evidence.quote}” <a href={k.evidence.url} target="_blank" rel="noreferrer">{shortUrl(k.evidence.url)}</a></td>
                </tr>
              ))}
              {f.certifications.length === 0 && (
                <tr><td>Certification</td><td className="uncertain">none found on the pages checked</td><td></td><td></td></tr>
              )}
              {f.signals.map((s, i) => (
                <tr key={`s${i}`}>
                  <td>Signal</td>
                  <td>{s.text}</td>
                  <td></td>
                  <td className="quote">“{s.evidence.quote}” <a href={s.evidence.url} target="_blank" rel="noreferrer">{shortUrl(s.evidence.url)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.conflicts.length > 0 && <div className="err">Conflicting evidence: {f.conflicts.join("; ")}</div>}
          {c.droppedClaims.length > 0 && (
            <p className="hint">Left out {c.droppedClaims.length} AI claim{c.droppedClaims.length === 1 ? "" : "s"} with no matching quote on the site: {c.droppedClaims.join(" | ")}</p>
          )}
        </details>
      )}

      {c.pages.length > 0 && (
        <details>
          <summary>Pages checked ({c.pages.filter((p) => p.ok).length} of {c.pages.length} loaded)</summary>
          <ul className="ul">
            {c.pages.map((p, i) => (
              <li key={i}>
                {p.ok ? "✓" : "✗"} <b>{p.kind}</b> <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a> {p.ok ? `(${p.chars} chars)` : `failed: ${p.error}`}
              </li>
            ))}
          </ul>
          {c.research.steps.length > 0 && (
            <ul className="ul">
              {c.research.steps.map((s, i) => (
                <li key={i}>Step {i + 1}: looked for {FIELD_LABEL[s.field] ?? s.field}; {s.url ? <>tried {shortUrl(s.url)} {s.ok ? "✓" : `✗ ${s.note ?? ""}`}</> : <>no page left to try</>}</li>
              ))}
            </ul>
          )}
          {c.research.exhausted && <p className="hint">Stopped at the research limit for this company ({c.research.cap} extra steps).</p>}
        </details>
      )}

      {finished && c.decision.result === "skip" && (
        <p className="hint">Outside Sprinto’s target, so there is no contact lookup or draft.</p>
      )}
      {finished && c.decision.result === "manual_review" && (
        <details open>
          <summary>What is missing</summary>
          {c.decision.missing.length > 0 ? (
            <ul className="ul">
              {c.decision.missing.map((m) => (
                <li key={m}>{MISSING_TEXT[m] ?? m}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">The reasons above say why this needs a person to check.</p>
          )}
          <p className="hint">
            Check the missing item yourself, for example on the company’s funding announcements or trust page. You can also add a contact below to get a draft marked as manual review. The decision stays the same.
          </p>
        </details>
      )}
      {finished && (c.decision.result === "fit" || c.decision.result === "manual_review") && (
        <details open>
          <summary>Point of contact</summary>
          {c.contact ? (
            <p>
              <b>{c.contact.name}</b>, {c.contact.role} <span className="hint">· {c.contact.why} · source: {c.contact.source}</span>
            </p>
          ) : (
            <>
              <p className="uncertain">Skipped: {c.contactSkip}</p>
              <p className="hint">Add a real contact to continue. They are never emailed; the preview goes to the owner’s inbox.</p>
              <div className="grid2">
                <input type="text" placeholder="Full name" value={cName} onChange={(e) => setCName(e.target.value)} />
                <input type="text" placeholder="Role (e.g. Head of Security)" value={cRole} onChange={(e) => setCRole(e.target.value)} />
              </div>
              <div className="sendrow">
                <button className="secondary" disabled={busy || cName.trim().length < 3 || cRole.trim().length < 2} onClick={() => onContact(c.id, cName, cRole)}>
                  {busy ? "Working…" : c.decision.result === "manual_review" ? "Draft anyway (marked manual review)" : "Continue with this contact"}
                </button>
              </div>
            </>
          )}
        </details>
      )}

      {c.pains && (
        <details open>
          <summary>Likely pain points</summary>
          <ul className="ul">
            {c.pains.map((p, i) => (
              <li key={i}>
                <b>{p.pain}</b> <span className={`conf ${p.grounded ? "stated" : "proxy"}`}>{p.grounded ? `quoted, ${p.certainty} certainty` : "no supporting quote"}</span>
                <div>{p.reasoning}</div>
                <div className="quote">“{p.evidence.quote}” {p.evidence.url && <a href={p.evidence.url} target="_blank" rel="noreferrer">{shortUrl(p.evidence.url)}</a>}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {c.draft && (
        <details open>
          <summary>Draft email ({c.draft.status.replace("_", " ")}){c.draft.label === "manual_review" ? " · manual-review draft" : ""}</summary>
          {c.draft.label === "manual_review" && <div className="err">Manual-review draft. This company is not a confirmed fit, and anything unresolved stays marked uncertain.</div>}
          <div className="hint">Subject</div>
          <div><b>{c.draft.subject}</b></div>
          <pre className="mail">{c.draft.body}</pre>
          <div className="hook">
            <b>Hook:</b> {c.draft.hook}
            <div className="quote">Source: “{c.draft.hookEvidence.quote}” {c.draft.hookEvidence.url && <a href={c.draft.hookEvidence.url} target="_blank" rel="noreferrer">{shortUrl(c.draft.hookEvidence.url)}</a>} · {c.draft.hookGrounded ? "found on the page" : "not found on any page"}</div>
          </div>
          {c.draft.uncertainFields.length > 0 && <p className="hint">Marked uncertain in the draft: {c.draft.uncertainFields.join("; ")}</p>}
          {c.draft.problems.length > 0 && <div className="err">{c.draft.problems.join(" ")}</div>}
        </details>
      )}

      {c.send && (
        <details open>
          <summary>Preview email</summary>
          <div className="sendrow">
            <span className={`badge ${c.send.status === "sent" || c.send.status === "duplicate_prevented" ? "b-fit" : c.send.status === "failed" || c.send.status === "blocked" ? "b-error" : "b-manual_review"}`}>{c.send.status.replace(/_/g, " ")}</span>
            <span>{c.send.note}</span>
          </div>
          <div className="hint">{c.send.to ? `To: ${c.send.to} · ` : ""}{c.send.messageId ? `Gmail id ${c.send.messageId} · ` : ""}{new Date(c.send.at).toLocaleString()}</div>
          {c.draft?.status === "ready" && (
            <div className="sendrow">
              <button className="secondary" disabled={busy} onClick={() => onResend(c.id)}>
                {c.send.status === "sent" || c.send.status === "duplicate_prevented" ? "Send again (duplicate protection blocks it)" : `Send preview to my inbox${c.send.status === "unknown" ? " (checks whether it already went)" : ""}`}
              </button>
            </div>
          )}
        </details>
      )}

      {c.log.length > 0 && (
        <details open={inProgress ? true : undefined}>
          <summary>Activity log</summary>
          <div className="log">
            {c.log.map((l) => (
              <div className="logline" key={`${l.t}|${l.stage}|${l.msg}`}>{`${l.t.slice(11, 19)} [${l.stage}] ${l.msg}`}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

type SearchResult = { criteria: Criteria; candidates: Candidate[] };
const cloneDefaults = (): Criteria => ({ ...DEFAULT_CRITERIA, stages: [...DEFAULT_CRITERIA.stages], certTypes: [...DEFAULT_CRITERIA.certTypes] });

function Toggle({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="pill">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function Filters({ value, onChange }: { value: Criteria; onChange: (c: Criteria) => void }) {
  const set = (p: Partial<Criteria>) => onChange({ ...value, ...p });
  const toggleStage = (s: Stage, on: boolean) => {
    if (s === "any") return set({ stages: on ? ["any"] : [...DEFAULT_CRITERIA.stages] });
    const rest = value.stages.filter((x) => x !== "any" && x !== s);
    const next = on ? [...rest, s] : rest;
    set({ stages: next.length ? (Object.keys(STAGES) as Stage[]).filter((k) => next.includes(k)) : ["any"] });
  };
  const toggleCert = (t: CertType, on: boolean) => {
    const next = on ? [...value.certTypes, t] : value.certTypes.filter((x) => x !== t);
    if (next.length === 0) return; // keep at least one; "Any certification status" is the way to drop the filter
    set({ certTypes: (Object.keys(CERT_TYPES) as CertType[]).filter((k) => next.includes(k)) });
  };
  return (
    <div className="filters">
      <fieldset className="f-wide">
        <legend>Funding stage</legend>
        <div className="pills">
          {(Object.keys(STAGES) as Stage[]).map((s) => (
            <Toggle key={s} checked={value.stages.includes(s)} onChange={(on) => toggleStage(s, on)}>{STAGES[s]}</Toggle>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="f-emp">Employees</label>
        <select id="f-emp" value={value.headcount} onChange={(e) => set({ headcount: e.target.value as Criteria["headcount"] })}>
          {Object.entries(HEADCOUNTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="f-model">Business model</label>
        <select id="f-model" value={value.model} onChange={(e) => set({ model: e.target.value as Criteria["model"] })}>
          {Object.entries(MODELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="f-cert">Certification</label>
        <select id="f-cert" value={value.certStatus} onChange={(e) => set({ certStatus: e.target.value as Criteria["certStatus"] })}>
          {Object.entries(CERT_STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <fieldset disabled={value.certStatus === "any"}>
        <legend>Certification types</legend>
        <div className="pills">
          {(Object.keys(CERT_TYPES) as CertType[]).map((t) => (
            <Toggle key={t} checked={value.certTypes.includes(t)} disabled={value.certStatus === "any"} onChange={(on) => toggleCert(t, on)}>{CERT_TYPES[t]}</Toggle>
          ))}
        </div>
      </fieldset>
      <div className="field f-wide">
        <label htmlFor="f-note">Industry or region (optional)</label>
        <input id="f-note" type="text" maxLength={NOTE_MAX} placeholder="e.g. fintech in Europe" value={value.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
    </div>
  );
}

export default function Home() {
  const [criteria, setCriteria] = useState<Criteria>(cloneDefaults);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [send, setSend] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthDone, setHealthDone] = useState(false);
  const [companies, setCompanies] = useState<CompanyRecord[]>([]);
  const [runCriteria, setRunCriteria] = useState<Criteria | null>(null);
  const [running, setRunning] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  const patch = useCallback((c: CompanyRecord) => setCompanies((prev) => prev.map((x) => (x.id === c.id ? c : x))), []);

  useEffect(() => {
    api<Health>("/api/health")
      .then((h) => {
        setHealth(h);
        try {
          const last = new URLSearchParams(window.location.search).get("run") ?? localStorage.getItem(LS_RUN);
          if (last && /^[0-9a-f-]{36}$/.test(last)) {
            api<{ run: { criteria?: Criteria }; companies: CompanyRecord[] }>(`/api/runs/${last}`)
              .then((r) => {
                setCompanies(r.companies);
                setRunCriteria(r.run?.criteria ?? null);
                for (const c of r.companies) if (c.status === "queued" || c.status === "running") void processOne(c);
              })
              .catch(() => undefined);
          }
        } catch {
          /* storage may be blocked */
        }
      })
      .catch(() => setHealth(null))
      .finally(() => setHealthDone(true));
  }, []);

  /** Starts the company on the server (returns at once) and polls the run until it is done. Transient errors never mark it failed. */
  async function processOne(c: CompanyRecord) {
    patch({ ...c, status: "running", stage: "starting" });
    let kicked = false;
    for (let attempt = 0; attempt < 3 && !kicked; attempt++) {
      try {
        const r = await api<{ company: CompanyRecord }>(`/api/companies/${c.id}/process`, {});
        patch(r.company);
        if (r.company.status === "done" || r.company.status === "error") return;
        kicked = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed";
        if (/Too many attempts|not found|limit/i.test(msg)) {
          patch({ ...c, status: "error", error: msg });
          return;
        }
        await new Promise((r) => setTimeout(r, 1500)); // network blip or gateway hiccup: just try again
      }
    }
    const deadline = Date.now() + 6 * 60_000;
    while (Date.now() < deadline && !stop.current) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const r = await api<{ companies: CompanyRecord[] }>(`/api/runs/${c.runId}`);
        const cur = r.companies.find((x) => x.id === c.id);
        if (cur) {
          patch(cur);
          if (cur.status === "done" || cur.status === "error") return;
        }
      } catch {
        /* transient: keep polling */
      }
    }
    if (!stop.current) patch({ ...c, status: "error", error: "This is taking longer than expected. Reload the page to see the result, or press Retry." });
  }

  async function search() {
    setSearching(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<SearchResult>("/api/discover", { criteria });
      setResult(r);
      setPicked(new Set(r.candidates.map((c) => c.domain)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }

  async function research() {
    if (!result) return;
    const chosen = result.candidates.filter((c) => picked.has(c.domain));
    if (chosen.length === 0) return;
    setError(null);
    setRunning(true);
    stop.current = false;
    try {
      const r = await api<{ run: { id: string; criteria?: Criteria }; companies: CompanyRecord[] }>("/api/runs", {
        domains: chosen.map((c) => `${c.domain} | ${c.name}`),
        send,
        mode: "discover",
        criteria: result.criteria,
      });
      try {
        localStorage.setItem(LS_RUN, r.run.id);
      } catch {
        /* ignore */
      }
      setCompanies(r.companies);
      setRunCriteria(r.run.criteria ?? result.criteria);
      api<Health>("/api/health").then(setHealth).catch(() => undefined);
      const queue = [...r.companies];
      const worker = async () => {
        while (queue.length && !stop.current) {
          const next = queue.shift()!;
          await processOne(next);
        }
      };
      await Promise.all([worker(), worker()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setRunning(false);
    }
  }

  async function retryErrors() {
    setRunning(true);
    stop.current = false;
    for (const c of companies.filter((x) => x.status === "error")) await processOne(c);
    setRunning(false);
  }

  async function withBusy(id: string, fn: () => Promise<CompanyRecord>) {
    setBusyIds((s) => new Set(s).add(id));
    try {
      patch(await fn());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }
  const onContact = (id: string, name: string, role: string) =>
    withBusy(id, async () => (await api<{ company: CompanyRecord }>(`/api/companies/${id}/contact`, { name, role })).company);
  const onResend = (id: string) => withBusy(id, async () => (await api<{ company: CompanyRecord }>(`/api/companies/${id}/send`, {})).company);

  const counts = companies.reduce<Record<string, number>>((m, c) => {
    const k = c.status === "done" ? c.decision.result : c.status;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  const chosenCount = result ? result.candidates.filter((c) => picked.has(c.domain)).length : 0;

  return (
    <main className="wrap">
      <h1>Sprinto</h1>
      <p className="sub">
        Find companies, check each one against Sprinto’s target customer using quotes from its own website, and draft a first email.
        Drafts go to the owner’s inbox as previews; prospects are never emailed.
      </p>

      <div className="chips" aria-label="Status">
        {health ? (
          <>
            <span className={`chip ${health.sendReady ? "ok" : "warn"}`}>Preview email {health.sendReady ? "on, to the owner’s inbox only" : "off: drafts are shown, nothing is sent"}</span>
            <span className={`chip ${health.contactLookup ? "ok" : "warn"}`}>Contact lookup {health.contactLookup ? "on" : "off: add contacts by hand"}</span>
            {health.gemini === false && <span className="chip warn">AI not configured</span>}
            {health.store && !health.store.durable && <span className="chip warn">Results are not saved between visits</span>}
            {health.allowance && (
              <span className={`chip ${health.allowance.runsLeftThisHourForYou > 0 ? "" : "warn"}`}>
                <Num v={health.allowance.runsLeftThisHourForYou} /> of {health.allowance.runsHourlyCap} research runs left for you this hour
              </span>
            )}
            {health.usageToday && health.caps && (
              <span className="chip">Used today: <Num v={health.usageToday.companies} /> of {health.caps.companiesGlobalPerDay} companies · <Num v={health.usageToday.geminiCalls} /> of {health.caps.geminiDailyCallCap} AI calls · <Num v={health.usageToday.sends} /> of {health.caps.sendsGlobalPerDay} previews · <Num v={health.usageToday.hunterThisMonth} /> of {health.caps.hunterMonthlyCap} contact lookups this month</span>
            )}
          </>
        ) : healthDone ? (
          <span className="chip">Status unavailable</span>
        ) : (
          <>
            <span className="sr-only">Checking status…</span>
            <span className="chip skel" aria-hidden="true" style={{ width: 150 }} />
            <span className="chip skel" aria-hidden="true" style={{ width: 230 }} />
            <span className="chip skel" aria-hidden="true" style={{ width: 120 }} />
          </>
        )}
      </div>

      <section className="card" aria-labelledby="search-h">
        <h2 id="search-h" className="sec">Who to look for</h2>
        <p className="hint target">
          The defaults are Sprinto’s target. You can search wider, but every company is still judged against that target: B2B SaaS, Series A to C, and no SOC 2, ISO 27001 or GDPR held yet.
        </p>
        <Filters value={criteria} onChange={setCriteria} />
        <div className="sendrow">
          <button className={searching ? "primary busy" : "primary"} aria-busy={searching} disabled={searching || running} onClick={search}>{searching ? "Finding…" : "Find companies"}</button>
          {!isDefault(criteria) && <button className="secondary" disabled={searching} onClick={() => setCriteria(cloneDefaults())}>Reset to Sprinto’s target</button>}
        </div>

        {result && (
          <div className="cands" aria-live="polite">
            <h3 className="sec2">{result.candidates.length === 0 ? "No suggestions" : `${result.candidates.length} suggestion${result.candidates.length === 1 ? "" : "s"}`}</h3>
            <p className="hint">Searched for: {summarize(result.criteria)}</p>
            {result.candidates.length === 0 ? (
              <p className="hint">Nothing came back for these criteria. Try a wider search or different guidance.</p>
            ) : (
              <>
                <p className="hint">Suggested by the AI from memory and not checked yet. Research verifies each one on its own website.</p>
                {result.candidates.map((c) => (
                  <label className="cand" key={c.domain}>
                    <input
                      type="checkbox"
                      checked={picked.has(c.domain)}
                      onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.domain); else n.delete(c.domain); return n; })}
                    />
                    <span><b>{c.name}</b> · {c.domain}{c.why && <><br /><span className="hint">{c.why}</span></>}</span>
                  </label>
                ))}
                <label className="row">
                  <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
                  <span>Email each finished draft to the owner’s inbox as a preview</span>
                </label>
              </>
            )}
          </div>
        )}
        {error && <div className="err" role="alert">{error}</div>}
      </section>

      {(chosenCount > 0 || running) && (
        <div className="runbar">
          <button className={running ? "primary busy" : "primary"} aria-busy={running} disabled={running || chosenCount === 0} onClick={research}>
            {running ? "Researching…" : `Research ${chosenCount} selected`}
          </button>
          {running && <button className="secondary" onClick={() => (stop.current = true)}>Stop after current</button>}
        </div>
      )}

      {companies.length > 0 && (
        <section aria-label="Results">
          <p className="hint summaryline" aria-live="polite">
            {companies.length} compan{companies.length === 1 ? "y" : "ies"}: <Num v={counts.fit ?? 0} /> fit · <Num v={counts.manual_review ?? 0} /> manual review · <Num v={counts.skip ?? 0} /> skipped · <Num v={(counts.running ?? 0) + (counts.queued ?? 0)} /> in progress{counts.error ? ` · ${counts.error} failed` : ""}
            {companies.some((c) => c.status === "error") && (
              <> · <button className="secondary" disabled={running} onClick={retryErrors}>Retry failed</button></>
            )}
          </p>
          {runCriteria && <p className="hint">Searched for: {summarize(runCriteria)}. Judged against Sprinto’s target.</p>}
          <p className="hint"><a href={`/?run=${companies[0].runId}`}>Link to these results</a> · anyone with the link can see them</p>
          {companies.map((c, i) => (
            <Company key={c.id} c={c} index={i} onContact={onContact} onResend={onResend} busy={busyIds.has(c.id)} />
          ))}
        </section>
      )}

      <p className="foot">
        Every fact shown has a quote from the company’s own pages; anything without one is marked uncertain. Fit decisions follow fixed rules, and the AI only extracts facts and writes drafts.
        Built for Mesa Term 2, AI Case 2.
      </p>
    </main>
  );
}
