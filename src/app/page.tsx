"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanyRecord, Fact } from "@/lib/types";

type Health = {
  sendReady?: boolean;
  contactLookup?: boolean;
  gemini?: boolean;
  hunter?: boolean;
  hunterAccount?: { plan: string | null; used: number | null; available: number | null; resetDate: string | null } | null;
  store?: { kind: string; durable: boolean; ok: boolean };
  usageToday?: { runs: number; companies: number; geminiCalls: number; sends: number; hunterThisMonth: number };
  caps?: { runsGlobalPerDay: number; companiesGlobalPerDay: number; geminiDailyCallCap: number; hunterMonthlyCap: number; sendsGlobalPerDay: number };
  sendsOnlyTo?: string;
  allowance?: { runsLeftToday: number; runsDailyCap: number; runsLeftThisHourForYou: number; runsHourlyCap: number; companiesLeftToday: number; dailyResetsAtUtc: string; hourlyResetsAtUtc: string };
};
type Candidate = { domain: string; name: string; why: string };

const LS_RUN = "sprinto:lastRun";
const MISSING_TEXT: Record<string, string> = {
  cert_status: "Certification status is ambiguous: a mention was found that does not say whether the company itself holds the certification (see the reason above for the exact quote). A person needs to check its security or trust page.",
  saas: "B2B SaaS status: the pages checked do not clearly say what the company sells or to whom.",
  stage: "Funding stage: no named stage (Series A-C) on the site and fewer than two stage proxies (5+ open roles, enterprise pricing tier).",
  certs: "Certification status: no security or trust page was found at the standard paths, so SOC 2 / ISO 27001 / GDPR could not be checked.",
};

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
          {c.decision.flags.length > 0 && <li className="hint">Flags: {c.decision.flags.join(", ")}</li>}
          {c.decision.stageProxies.length > 0 && <li className="hint">Stage proxies: {c.decision.stageProxies.join("; ")}</li>}
        </ul>
      )}

      {f && finished && (
        <details open={c.decision.result !== "fit"}>
          <summary>Evidence and extracted fields</summary>
          <table>
            <thead>
              <tr><th>Field</th><th>Value</th><th>Basis</th><th>Evidence (verbatim quote and page)</th></tr>
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
            <p className="hint">Dropped {c.droppedClaims.length} model claim(s) that had no verifiable quote on the fetched pages: {c.droppedClaims.join(" | ")}</p>
          )}
        </details>
      )}

      {c.pages.length > 0 && (
        <details>
          <summary>Pages fetched ({c.pages.filter((p) => p.ok).length}/{c.pages.length}) and research loop ({c.research.loops}/{c.research.cap})</summary>
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
                <li key={i}>Loop {i + 1}: needed <b>{s.field}</b>; {s.url ? <>fetched {shortUrl(s.url)} {s.ok ? "✓" : `✗ ${s.note ?? ""}`}</> : <>no page left to try</>}</li>
              ))}
            </ul>
          )}
          {c.research.exhausted && <p className="hint">Research budget exhausted; stopped and routed per the rules.</p>}
        </details>
      )}

      {finished && c.decision.result === "skip" && (
        <p className="hint">Terminal: this company fails a hard ICP rule, so no contact lookup and no draft are made for it. Remove it from the list.</p>
      )}
      {finished && c.decision.result === "manual_review" && (
        <details open>
          <summary>What is missing, and what you can do</summary>
          {c.decision.missing.length > 0 ? (
            <ul className="ul">
              {c.decision.missing.map((m) => (
                <li key={m}>{MISSING_TEXT[m] ?? m}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">The reasons above explain why this needs a human look.</p>
          )}
          <p className="hint">
            This stays a manual-review case. To resolve it, check the missing item yourself (for example funding on the company’s own announcements, or its trust page) and re-run the exact domain.
            You can also add a contact below to get a clearly labelled <b>manual-review draft</b>. That does not change the decision, and previews still go only to the owner’s inbox.
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
              <p className="hint">You can add a real contact yourself to continue. Nothing is ever sent to them; the preview goes only to your inbox.</p>
              <div className="grid2">
                <input type="text" placeholder="Full name" value={cName} onChange={(e) => setCName(e.target.value)} />
                <input type="text" placeholder="Role (e.g. Head of Security)" value={cRole} onChange={(e) => setCRole(e.target.value)} />
              </div>
              <div className="sendrow">
                <button className="secondary" disabled={busy || cName.trim().length < 3 || cRole.trim().length < 2} onClick={() => onContact(c.id, cName, cRole)}>
                  {busy ? "Working…" : c.decision.result === "manual_review" ? "Draft anyway (labelled manual-review)" : "Continue with this contact"}
                </button>
              </div>
            </>
          )}
        </details>
      )}

      {c.pains && (
        <details open>
          <summary>Two most likely pain points</summary>
          <ul className="ul">
            {c.pains.map((p, i) => (
              <li key={i}>
                <b>{p.pain}</b> <span className={`conf ${p.grounded ? "stated" : "proxy"}`}>{p.grounded ? `grounded, ${p.certainty} certainty` : "UNGROUNDED"}</span>
                <div>{p.reasoning}</div>
                <div className="quote">“{p.evidence.quote}” {p.evidence.url && <a href={p.evidence.url} target="_blank" rel="noreferrer">{shortUrl(p.evidence.url)}</a>}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {c.draft && (
        <details open>
          <summary>Draft email ({c.draft.status.replace("_", " ")}){c.draft.label === "manual_review" ? " · MANUAL-REVIEW DRAFT" : ""}</summary>
          {c.draft.label === "manual_review" && <div className="err">Manual-review draft: this company is not qualified as a fit. The decision above is unchanged and unresolved items stay marked uncertain.</div>}
          <div className="hint">Subject</div>
          <div><b>{c.draft.subject}</b></div>
          <pre className="mail">{c.draft.body}</pre>
          <div className="hook">
            <b>Hook:</b> {c.draft.hook}
            <div className="quote">Evidence: “{c.draft.hookEvidence.quote}” {c.draft.hookEvidence.url && <a href={c.draft.hookEvidence.url} target="_blank" rel="noreferrer">{shortUrl(c.draft.hookEvidence.url)}</a>} · {c.draft.hookGrounded ? "verified on page" : "NOT verified on any page"}</div>
          </div>
          {c.draft.uncertainFields.length > 0 && <p className="hint">Shown as uncertain (not stated as fact): {c.draft.uncertainFields.join("; ")}</p>}
          {c.draft.problems.length > 0 && <div className="err">{c.draft.problems.join(" ")}</div>}
        </details>
      )}

      {c.send && (
        <details open>
          <summary>Own-inbox send result</summary>
          <div className="sendrow">
            <span className={`badge ${c.send.status === "sent" || c.send.status === "duplicate_prevented" ? "b-fit" : c.send.status === "failed" || c.send.status === "blocked" ? "b-error" : "b-manual_review"}`}>{c.send.status.replace(/_/g, " ")}</span>
            <span>{c.send.note}</span>
          </div>
          <div className="hint">{c.send.to ? `To: ${c.send.to} · ` : ""}{c.send.messageId ? `Gmail id ${c.send.messageId} · ` : ""}{new Date(c.send.at).toLocaleString()}</div>
          {c.draft?.status === "ready" && (
            <div className="sendrow">
              <button className="secondary" disabled={busy} onClick={() => onResend(c.id)}>
                {c.send.status === "sent" || c.send.status === "duplicate_prevented" ? "Try sending again (the lock should refuse)" : `Send preview to my inbox${c.send.status === "unknown" ? " (checks Gmail first)" : ""}`}
              </button>
              <span className="hint">Run {c.runId.slice(0, 8)} · company {c.id.slice(0, 8)}</span>
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

export default function Home() {
  const [tab, setTab] = useState<"paste" | "discover">("paste");
  const [text, setText] = useState("");
  const [send, setSend] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [companies, setCompanies] = useState<CompanyRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [healthDone, setHealthDone] = useState(false);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [caveat, setCaveat] = useState("");
  const [note, setNote] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const stop = useRef(false);

  const patch = useCallback((c: CompanyRecord) => setCompanies((prev) => prev.map((x) => (x.id === c.id ? c : x))), []);

  useEffect(() => {
    api<Health>("/api/health")
      .then((h) => {
        setHealth(h);
        try {
          const last = new URLSearchParams(window.location.search).get("run") ?? localStorage.getItem(LS_RUN);
          if (last && /^[0-9a-f-]{36}$/.test(last)) {
            api<{ companies: CompanyRecord[] }>(`/api/runs/${last}`)
              .then((r) => {
                setCompanies(r.companies);
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
    if (!stop.current) patch({ ...c, status: "error", error: "This is taking longer than expected. Reload the page to check the result, or press Retry." });
  }

  async function start() {
    setError(null);
    setRunning(true);
    stop.current = false;
    try {
      const r = await api<{ run: { id: string }; companies: CompanyRecord[] }>("/api/runs", { domains: text, send, mode: tab });
      try {
        localStorage.setItem(LS_RUN, r.run.id);
      } catch {
        /* ignore */
      }
      setCompanies(r.companies);
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

  async function discover() {
    setDiscovering(true);
    setError(null);
    try {
      const r = await api<{ candidates: Candidate[]; caveat: string }>("/api/discover", { note });
      setCands(r.candidates);
      setPicked(new Set(r.candidates.map((c) => c.domain)));
      setCaveat(r.caveat);
      if (r.candidates.length === 0) setError("No usable candidates came back. Try again or add guidance.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  }
  function useCandidates() {
    const lines = cands.filter((c) => picked.has(c.domain)).map((c) => `${c.domain} | ${c.name}`);
    setText(lines.join("\n"));
    setTab("paste");
  }

  const counts = companies.reduce<Record<string, number>>((m, c) => {
    const k = c.status === "done" ? c.decision.result : c.status;
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

  return (
    <main className="wrap">
      <h1>Sprinto</h1>
      <p className="sub">
        Cold-outreach research assistant for Sprinto’s Growth Lead. Paste company domains (or discover them from the ICP). For each one it scrapes the site,
        extracts facts with cited evidence, qualifies against the ICP, finds a contact, drafts a grounded first email and sends a preview <b>only to the owner’s own inbox</b>.
        Nothing is ever sent to a prospect. This is a free-tier demo with small daily limits; your results are visible only through your own run link.
      </p>

      <div className="chips" aria-label="System status">
        {health ? (
          <>
            <span className={`chip ${health.contactLookup ? "ok" : "warn"}`}>Contact lookup {health.contactLookup ? "on" : "off: add contacts by hand"}</span>
            <span className={`chip ${health.sendReady ? "ok" : "warn"}`}>Preview email {health.sendReady ? "on: goes only to the owner’s inbox" : "not connected yet: drafts are shown, nothing is sent"}</span>
            {health.allowance && (
              <span className={`chip ${health.allowance.runsLeftToday > 0 && health.allowance.runsLeftThisHourForYou > 0 ? "" : "warn"}`}>
                Demo limits: <Num v={health.allowance.runsLeftToday} /> of {health.allowance.runsDailyCap} runs left today (resets 00:00 UTC, 05:30 IST) · <Num v={health.allowance.runsLeftThisHourForYou} /> of {health.allowance.runsHourlyCap} left for you this hour
              </span>
            )}
            <span className={`chip ${health.gemini ? "ok" : "warn"}`}>Gemini {health.gemini ? "ready" : "not configured"}</span>
            {health.hunterAccount && (
              <span className="chip">Hunter {health.hunterAccount.plan ?? "plan ?"}: {health.hunterAccount.available !== null && health.hunterAccount.used !== null ? `${health.hunterAccount.available - health.hunterAccount.used} of ${health.hunterAccount.available} left` : "usage unknown"}</span>
            )}
            {health.store && <span className={`chip ${health.store.durable ? "ok" : "warn"}`}>Storage: {health.store.kind}{health.store.durable ? " (durable)" : " (not durable)"}</span>}
            {health.usageToday && health.caps && (
              <span className="chip">Today: <Num v={health.usageToday.runs} />/{health.caps.runsGlobalPerDay} runs · <Num v={health.usageToday.companies} />/{health.caps.companiesGlobalPerDay} companies · <Num v={health.usageToday.geminiCalls} />/{health.caps.geminiDailyCallCap} AI calls · <Num v={health.usageToday.sends} />/{health.caps.sendsGlobalPerDay} preview emails · Hunter <Num v={health.usageToday.hunterThisMonth} />/{health.caps.hunterMonthlyCap} lookups this month</span>
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

      <div className="card">
        <div className="tabs" role="tablist" data-active={tab}>
          <button className="tab" role="tab" aria-selected={tab === "paste"} onClick={() => setTab("paste")}>Paste domains</button>
          <button className="tab" role="tab" aria-selected={tab === "discover"} onClick={() => setTab("discover")}>Discover from ICP</button>
        </div>

        {tab === "paste" ? (
          <>
            <textarea
              aria-label="Company domains"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"One domain per line (max 10):\nacme.com\nanother.io | Another Inc\nthird.com | Third Inc | Jane Doe | Head of Security\n\nOptional 2nd field = expected name (guards against same-name look-alikes).\nOptional 3rd and 4th = a real contact to use if Hunter finds nobody."}
            />
            <label className="row">
              <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
              <span>Send each finished draft as a preview to my own inbox. The only possible recipient is the owner’s address, enforced on the server.</span>
            </label>
          </>
        ) : (
          <>
            <p className="hint">ICP: B2B SaaS, Series A-C, about 50-200 employees, likely under SOC 2 / ISO 27001 / GDPR pressure, no certification held yet.</p>
            <input type="text" placeholder="Optional guidance, e.g. fintech or healthtech SaaS" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="sendrow">
              <button className="primary" disabled={discovering} onClick={discover}>{discovering ? "Finding…" : "Suggest candidate domains"}</button>
              {cands.length > 0 && <button className="secondary" onClick={useCandidates} disabled={picked.size === 0}>Use {picked.size} selected</button>}
            </div>
            {caveat && <p className="hint">{caveat}</p>}
            {cands.map((c) => (
              <label className="cand" key={c.domain}>
                <input
                  type="checkbox"
                  checked={picked.has(c.domain)}
                  onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.domain); else n.delete(c.domain); return n; })}
                />
                <span><b>{c.name}</b> · {c.domain}<br /><span className="hint">{c.why}</span></span>
              </label>
            ))}
          </>
        )}
        {error && <div className="err" role="alert">{error}</div>}
      </div>

      {tab === "paste" && (
        <div className="runbar">
          <button className={running ? "primary busy" : "primary"} aria-busy={running} disabled={running || text.trim().length < 3} onClick={start}>
            {running ? "Researching…" : "Run research"}
          </button>
          {running && (
            <button className="secondary" onClick={() => (stop.current = true)}>Stop after current</button>
          )}
        </div>
      )}

      {companies.length > 0 && (
        <p className="hint summaryline" aria-live="polite">
          {companies.length} compan{companies.length === 1 ? "y" : "ies"}: <Num v={counts.fit ?? 0} /> fit · <Num v={counts.manual_review ?? 0} /> manual review · <Num v={counts.skip ?? 0} /> skipped · <Num v={(counts.running ?? 0) + (counts.queued ?? 0)} /> in progress{counts.error ? ` · ${counts.error} error` : ""}
          {companies.some((c) => c.status === "error") && (
            <> · <button className="secondary" disabled={running} onClick={async () => { setRunning(true); for (const c of companies.filter((x) => x.status === "error")) await processOne(c); setRunning(false); }}>Retry errors</button></>
          )}
        </p>
      )}
      {companies.length > 0 && (
        <p className="hint">Run id: <code>{companies[0].runId}</code> · <a href={`/?run=${companies[0].runId}`}>your private run link</a> <span>(anyone with this link can view this run, so keep it to yourself)</span></p>
      )}
      {companies.map((c) => (
        <Company key={c.id} c={c} index={companies.indexOf(c)} onContact={onContact} onResend={onResend} busy={busyIds.has(c.id)} />
      ))}

      <p className="foot">
        Sprinto never invents company facts or contacts: every fact needs a verbatim quote from a fetched page, and anything uncertain is shown as uncertain.
        Qualification rules are deterministic code; the model only extracts and drafts. Built for Mesa Term 2 AI Case 2.
      </p>
    </main>
  );
}
