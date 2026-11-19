// Durable storage with two backends behind one small interface:
//  - Postgres (Neon) when DATABASE_URL is set  -> durable on Vercel
//  - SQLite file (libSQL) otherwise            -> durable locally; on Vercel it falls back to /tmp (NOT durable)
// Records are stored as JSON documents; the send-lock table is relational so the claim is atomic.

import type { CompanyRecord, RunRecord } from "./types";

export interface SendLockRow {
  key: string;
  companyId: string;
  state: "pending" | "sent" | "unknown" | "failed";
  messageId?: string | null;
  updatedAt: string;
  detail?: string | null;
}

export interface Store {
  kind: string;
  durable: boolean;
  saveRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(limit: number): Promise<RunRecord[]>;
  saveCompany(c: CompanyRecord): Promise<void>;
  getCompany(id: string): Promise<CompanyRecord | null>;
  listCompanies(runId: string): Promise<CompanyRecord[]>;
  /** Atomically create the lock row. claimed=false means a row already existed (returned as `existing`). */
  claimSend(key: string, companyId: string): Promise<{ claimed: boolean; existing?: SendLockRow }>;
  setSend(key: string, state: SendLockRow["state"], messageId?: string | null, detail?: string | null): Promise<void>;
  getSend(key: string): Promise<SendLockRow | null>;
  /** Increment a counter and return the new value (used for rate limits). */
  hit(key: string, by: number): Promise<number>;
}

// ---------- in-memory store (tests / eval) ----------
export class MemoryStore implements Store {
  kind = "memory";
  /** Tests pass false to simulate a serverless instance whose local state cannot be trusted. */
  constructor(public durable = true) {}
  runs = new Map<string, RunRecord>();
  companies = new Map<string, CompanyRecord>();
  sends = new Map<string, SendLockRow>();
  counters = new Map<string, number>();
  async saveRun(run: RunRecord) { this.runs.set(run.id, structuredClone(run)); }
  async getRun(id: string) { return structuredClone(this.runs.get(id) ?? null); }
  async listRuns(limit: number) {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((r) => structuredClone(r));
  }
  async saveCompany(c: CompanyRecord) { this.companies.set(c.id, structuredClone(c)); }
  async getCompany(id: string) { return structuredClone(this.companies.get(id) ?? null); }
  async listCompanies(runId: string) {
    return [...this.companies.values()].filter((c) => c.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((c) => structuredClone(c));
  }
  async claimSend(key: string, companyId: string) {
    const existing = this.sends.get(key);
    if (existing) return { claimed: false, existing: { ...existing } };
    this.sends.set(key, { key, companyId, state: "pending", updatedAt: new Date().toISOString() });
    return { claimed: true };
  }
  async setSend(key: string, state: SendLockRow["state"], messageId?: string | null, detail?: string | null) {
    const row = this.sends.get(key);
    const base: SendLockRow = row ?? { key, companyId: "", state, updatedAt: "" };
    this.sends.set(key, { ...base, state, messageId: messageId ?? base.messageId ?? null, detail: detail ?? null, updatedAt: new Date().toISOString() });
  }
  async getSend(key: string) { const r = this.sends.get(key); return r ? { ...r } : null; }
  async hit(key: string, by: number) { const n = (this.counters.get(key) ?? 0) + by; this.counters.set(key, n); return n; }
}

// ---------- SQL store (SQLite or Postgres) ----------
type Row = Record<string, unknown>;
type Exec = (sql: string, args?: unknown[]) => Promise<Row[]>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, domain TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS companies_run_idx ON companies (run_id)`,
  `CREATE TABLE IF NOT EXISTS sends (key TEXT PRIMARY KEY, company_id TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT, updated_at TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
];

class SqlStore implements Store {
  constructor(public kind: string, public durable: boolean, private exec: Exec) {}
  private ready: Promise<void> | null = null;
  private init() {
    if (!this.ready) {
      this.ready = (async () => {
        for (const stmt of SCHEMA) await this.exec(stmt);
      })();
    }
    return this.ready;
  }
  private async q(sql: string, args: unknown[] = []) {
    await this.init();
    return this.exec(sql, args);
  }
  async saveRun(run: RunRecord) {
    await this.q(
      `INSERT INTO runs (id, created_at, json) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`,
      [run.id, run.createdAt, JSON.stringify(run)],
    );
  }
  async getRun(id: string) {
    const r = await this.q(`SELECT json FROM runs WHERE id = ?`, [id]);
    return r[0] ? (JSON.parse(String(r[0].json)) as RunRecord) : null;
  }
  async listRuns(limit: number) {
    const r = await this.q(`SELECT json FROM runs ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(50, limit | 0))}`);
    return r.map((x) => JSON.parse(String(x.json)) as RunRecord);
  }
  async saveCompany(c: CompanyRecord) {
    await this.q(
      `INSERT INTO companies (id, run_id, domain, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json`,
      [c.id, c.runId, c.domain, c.createdAt, c.updatedAt, JSON.stringify(c)],
    );
  }
  async getCompany(id: string) {
    const r = await this.q(`SELECT json FROM companies WHERE id = ?`, [id]);
    return r[0] ? (JSON.parse(String(r[0].json)) as CompanyRecord) : null;
  }
  async listCompanies(runId: string) {
    const r = await this.q(`SELECT json FROM companies WHERE run_id = ? ORDER BY created_at ASC, id ASC`, [runId]);
    return r.map((x) => JSON.parse(String(x.json)) as CompanyRecord);
  }
  async claimSend(key: string, companyId: string) {
    const now = new Date().toISOString();
    const ins = await this.q(
      `INSERT INTO sends (key, company_id, state, updated_at) VALUES (?, ?, 'pending', ?) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, companyId, now],
    );
    if (ins.length > 0) return { claimed: true };
    const existing = await this.getSend(key);
    return { claimed: false, existing: existing ?? undefined };
  }
  async setSend(key: string, state: SendLockRow["state"], messageId?: string | null, detail?: string | null) {
    await this.q(
      `UPDATE sends SET state = ?, message_id = COALESCE(?, message_id), detail = ?, updated_at = ? WHERE key = ?`,
      [state, messageId ?? null, detail ?? null, new Date().toISOString(), key],
    );
  }
  async getSend(key: string) {
    const r = await this.q(`SELECT key, company_id, state, message_id, updated_at, detail FROM sends WHERE key = ?`, [key]);
    const x = r[0];
    if (!x) return null;
    return {
      key: String(x.key),
      companyId: String(x.company_id),
      state: String(x.state) as SendLockRow["state"],
      messageId: (x.message_id as string | null) ?? null,
      updatedAt: String(x.updated_at),
      detail: (x.detail as string | null) ?? null,
    };
  }
  async hit(key: string, by: number) {
    const r = await this.q(
      `INSERT INTO counters (k, n) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET n = counters.n + excluded.n RETURNING n`,
      [key, by],
    );
    return Number(r[0]?.n ?? by);
  }
}

let cached: Store | null = null;
let override: Store | null = null;

export function setStoreForTests(s: Store | null) {
  override = s;
}

export function getStore(): Store {
  if (override) return override;
  if (cached) return cached;
  const url = process.env.DATABASE_URL?.trim();
  if (url && /^postgres(ql)?:\/\//i.test(url)) {
    cached = new SqlStore("postgres", true, async (sql, args = []) => {
      const { neon } = await import("@neondatabase/serverless");
      const client = neon(url);
      let i = 0;
      const text = sql.replace(/\?/g, () => `$${++i}`);
      const rows = await client.query(text, args as never[]);
      return rows as unknown as Row[];
    });
    return cached;
  }
  const onVercel = !!process.env.VERCEL;
  const file = onVercel ? "/tmp/sprinto.db" : `${process.cwd()}/data/sprinto.db`;
  let clientP: Promise<import("@libsql/client").Client> | null = null;
  cached = new SqlStore("sqlite", !onVercel, async (sql, args = []) => {
    if (!clientP) {
      clientP = (async () => {
        if (!onVercel) {
          const { mkdirSync } = await import("node:fs");
          mkdirSync(`${process.cwd()}/data`, { recursive: true });
        }
        const { createClient } = await import("@libsql/client");
        return createClient({ url: `file:${file}` });
      })();
    }
    const client = await clientP;
    const rs = await client.execute({ sql, args: args as never[] });
    return rs.rows.map((r) => ({ ...r })) as Row[];
  });
  return cached;
}
