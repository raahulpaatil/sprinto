"use client";

import { useState } from "react";

export default function OwnerLogin() {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/owner/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setErr(j.error ?? "Sign-in failed.");
      else window.location.href = "/";
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="wrap" style={{ maxWidth: 460 }}>
      <h1>Owner sign-in</h1>
      <p className="sub">Live research, discovery, sending and the Gmail connection are owner-only.</p>
      <form className="card" onSubmit={submit}>
        <label htmlFor="k" className="hint">Owner key</label>
        <input id="k" type="password" autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} />
        <div className="sendrow">
          <button className="primary" disabled={busy || key.length < 8}>{busy ? "Checking…" : "Sign in"}</button>
        </div>
        {err && <div className="err" role="alert">{err}</div>}
      </form>
      <p className="hint"><a href="/">Back to the public page</a></p>
    </main>
  );
}
