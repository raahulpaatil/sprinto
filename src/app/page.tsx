"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLE } from "@/lib/sample";
import type { CompanyRecord, Fact } from "@/lib/types";

type Health = {
  owner: boolean;
  ownerConfigured?: boolean;
  gemini: boolean;
  hunter: boolean;
  gmail: boolean;
  gmailCanConnect?: boolean;
  store: { kind: string; durable: boolean; ok: boolean };
  sendsOnlyTo: string;
};
type Candidate = { domain: string; name: string; why: string };

const LS_RUN = "sprinto:lastRun";

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

function Company({ c, onContact, onResend, busy }: { c: CompanyRecord; onContact: (id: string, name: string, role: string) => void; onResend: (id: string) => void; busy: boolean }) {
  const [cName, setCName] = useState("");
  const [cRole, setCRole] = useState("");
  const decisionKey = c.status === "error" ? "error" : c.status === "queued" || c.status === "running" ? c.status : c.decision.result;
  const label = c.status === "error" ? "Error" : c.status === "queued" ? "Queued" : c.status === "running" ? `Running: ${c.stage}` : DECISION_LABEL[c.decision.result];
  const f = c.facts;
  const finished = c.status === "done";
  return (
    <div className="card">
      <div className="co-head">
        <div>
          <div className="co-title">{f?.company_name.value ?? c.expectedName ?? c.domain}</div>
          <div className="hint">{c.domain}{c.expectedName ? ` · expected: ${c.expectedName}` : ""}</div>
        </div>
        <span className={`badge b-${decisionKey}`}>{label}</span>
      </div>

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

      {finished && c.decision.result === "fit" && (
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
                  {busy ? "Working…" : "Continue with this contact"}
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
          <summary>Draft email ({c.draft.status.replace("_", " ")})</summary>
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
          {c.draft?.status === "ready" && ["failed", "not_configured", "not_attempted", "unknown", "in_flight"].includes(c.send.status) && (
            <div className="sendrow">
              <button className="secondary" disabled={busy} onClick={() => onResend(c.id)}>Send preview to my inbox{c.send.status === "unknown" ? " (checks Gmail first)" : ""}</button>
            </div>
          )}
        </details>
      )}

      {c.log.length > 0 && (
        <details>
          <summary>Activity log</summary>
          <div className="log">{c.log.map((l) => `${l.t.slice(11, 19)} [${l.stage}] ${l.msg}`).join("\n")}</div>
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
        if (!h.owner) return;
        try {
          const last = localStorage.getItem(LS_RUN);
          if (last) api<{ companies: CompanyRecord[] }>(`/api/runs/${last}`).then((r) => setCompanies(r.companies)).catch(() => undefined);
        } catch {
          /* storage may be blocked */
        }
      })
      .catch(() => setHealth(null));
  }, []);

  async function processOne(c: CompanyRecord) {
    patch({ ...c, status: "running", stage: "starting" });
    try {
      const r = await api<{ company: CompanyRecord }>(`/api/companies/${c.id}/process`, {});
      patch(r.company);
    } catch (e) {
      patch({ ...c, status: "error", error: e instanceof Error ? e.message : "Failed" });
    }
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

  if (health && !health.owner) {
    return (
      <main className="wrap">
        <h1>Sprinto</h1>
        <p className="sub">
          Cold-outreach research assistant for Sprinto’s Growth Lead. For each company domain it scrapes the site, extracts facts with cited evidence, qualifies the
          company against the ICP, finds a contact, drafts a grounded first email and sends a preview only to the owner’s own inbox. Nothing is ever sent to a prospect.
        </p>
        <div className="card">
          <h2>Live runs are owner-only</h2>
          <p className="hint" style={{ margin: 0 }}>
            Research, discovery, contact lookup, drafting, sending and stored results use paid and private services, so they require the owner’s sign-in. This public page shows
            static sample output only and makes no live calls. <a href="/owner">Owner sign-in</a>
          </p>
        </div>
        <h2>How a company is decided</h2>
        <ul className="ul">
          <li>B2B SaaS is required. Series A-C is a hard filter, named on the site and always labelled a proxy, not proof. 50-200 employees is a soft band that is flagged but never disqualifies.</li>
          <li>Already holding SOC 2, ISO 27001 or GDPR disqualifies, shown with the exact quote. Thin or conflicting evidence goes to manual review with the reason.</li>
          <li>Every fact needs a verbatim quote from a fetched page. Unverifiable claims are dropped, and anything uncertain is shown as uncertain.</li>
          <li>A first email needs a hook tied to a quote that is verified on a fetched page, and it can only ever be previewed to the owner’s own inbox.</li>
        </ul>
        <h2>Sample output <span className="conf proxy">static example, not live data</span></h2>
        <Company c={SAMPLE} onContact={() => undefined} onResend={() => undefined} busy={false} />
        <p className="foot">Built for Mesa Term 2 AI Case 2. The sample above is a frozen example from public website text.</p>
      </main>
    );
  }
  if (!health) {
    return (
      <main className="wrap">
        <h1>Sprinto</h1>
        <p className="sub">Loading…</p>
      </main>
    );
  }

  return (
    <main className="wrap">
      <div className="co-head">
        <h1>Sprinto</h1>
        <span className="hint">Owner mode · <button className="secondary" onClick={async () => { await fetch("/api/owner/logout", { method: "POST" }); window.location.reload(); }}>Sign out</button></span>
      </div>
      <p className="sub">
        Cold-outreach research assistant for Sprinto’s Growth Lead. Paste company domains (or discover them from the ICP). For each one it scrapes the site,
        extracts facts with cited evidence, qualifies against the ICP, finds a contact, drafts a grounded first email and sends a preview <b>only to the owner’s own inbox</b>.
        Nothing is ever sent to a prospect.
      </p>

      <div className="chips" aria-label="System status">
        {health ? (
          <>
            <span className={`chip ${health.gemini ? "ok" : "warn"}`}>Gemini {health.gemini ? "ready" : "not configured"}</span>
            <span className={`chip ${health.hunter ? "ok" : "warn"}`}>Hunter {health.hunter ? "ready" : "no key: contacts can be added manually"}</span>
            <span className={`chip ${health.gmail ? "ok" : "warn"}`}>Gmail {health.gmail ? `ready, sends only to ${health.sendsOnlyTo}` : "not connected: drafts shown, nothing sent"}{health.gmailCanConnect ? <> · <a href="/api/gmail/start">Connect Gmail</a></> : null}</span>
            <span className={`chip ${health.store.durable ? "ok" : "warn"}`}>Storage: {health.store.kind}{health.store.durable ? " (durable)" : " (not durable)"}</span>
          </>
        ) : (
          <span className="chip">Checking status…</span>
        )}
      </div>

      <div className="card">
        <div className="tabs" role="tablist">
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
            <button className="primary" disabled={running || text.trim().length < 3} onClick={start}>
              {running ? "Researching…" : "Run research"}
            </button>
            {running && (
              <button className="secondary" style={{ marginLeft: 8 }} onClick={() => (stop.current = true)}>Stop after current</button>
            )}
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

      {companies.length > 0 && (
        <p className="hint" aria-live="polite">
          {companies.length} compan{companies.length === 1 ? "y" : "ies"}: {counts.fit ?? 0} fit · {counts.manual_review ?? 0} manual review · {counts.skip ?? 0} skipped · {(counts.running ?? 0) + (counts.queued ?? 0)} in progress{counts.error ? ` · ${counts.error} error` : ""}
          {companies.some((c) => c.status === "error") && (
            <> · <button className="secondary" disabled={running} onClick={async () => { setRunning(true); for (const c of companies.filter((x) => x.status === "error")) await processOne(c); setRunning(false); }}>Retry errors</button></>
          )}
        </p>
      )}
      {companies.map((c) => (
        <Company key={c.id} c={c} onContact={onContact} onResend={onResend} busy={busyIds.has(c.id)} />
      ))}

      <p className="foot">
        Sprinto never invents company facts or contacts: every fact needs a verbatim quote from a fetched page, and anything uncertain is shown as uncertain.
        Qualification rules are deterministic code; the model only extracts and drafts. Built for Mesa Term 2 AI Case 2.
      </p>
    </main>
  );
}
