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
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
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
  secrets = new Map<string, string>();
  async getSecret(name: string) { return this.secrets.get(name) ?? null; }
  async setSecret(name: string, value: string) { this.secrets.set(name, value); }
}

// ---------- SQL store (SQLite or Postgres) ----------
type Row = Record<string, unknown>;
type Exec = (sql: string, args?: unknown[]) => Promise<Row[]>;

/** `P` is "" for SQLite and "sprinto." for Postgres (a dedicated schema, so it never collides with another app's tables). */
const schemaFor = (P: string) => [
  ...(P ? [`CREATE SCHEMA IF NOT EXISTS ${P.replace(".", "")}`] : []),
  `CREATE TABLE IF NOT EXISTS ${P}runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${P}companies (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, domain TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS companies_run_idx ON ${P}companies (run_id)`,
  `CREATE TABLE IF NOT EXISTS ${P}sends (key TEXT PRIMARY KEY, company_id TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT, updated_at TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS ${P}counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ${P}secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];

/** Counter rows idle longer than this are deleted (Hunter keys are exempt: they track a monthly credit window and hold no IPs). */
export const COUNTER_RETENTION_MS = 48 * 3600 * 1000;
const PRUNE_EVERY_MS = 10 * 60 * 1000;

export class SqlStore implements Store {
  constructor(public kind: string, public durable: boolean, private exec: Exec, private P = "") {}
  private lastPrune = 0;
  /** Test/maintenance access to the underlying executor. */
  rawExec(sql: string, args: unknown[] = []) {
    return this.q(sql, args);
  }
  private ready: Promise<void> | null = null;
  private init() {
    if (!this.ready) {
      this.ready = (async () => {
        for (const stmt of schemaFor(this.P)) await this.exec(stmt);
        // Migration for databases created before counters had a timestamp. Ignored if the column already exists.
        try {
          await this.exec(`ALTER TABLE ${this.P}counters ADD COLUMN ${this.P ? "IF NOT EXISTS " : ""}updated_at TEXT`);
        } catch {
          /* column already there */
        }
        await this.exec(`UPDATE ${this.P}counters SET updated_at = ? WHERE updated_at IS NULL`, [new Date().toISOString()]);
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
      `INSERT INTO ${this.P}runs (id, created_at, json) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`,
      [run.id, run.createdAt, JSON.stringify(run)],
    );
  }
  async getRun(id: string) {
    const r = await this.q(`SELECT json FROM ${this.P}runs WHERE id = ?`, [id]);
    return r[0] ? (JSON.parse(String(r[0].json)) as RunRecord) : null;
  }
  async listRuns(limit: number) {
    const r = await this.q(`SELECT json FROM ${this.P}runs ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(50, limit | 0))}`);
    return r.map((x) => JSON.parse(String(x.json)) as RunRecord);
  }
  async saveCompany(c: CompanyRecord) {
    await this.q(
      `INSERT INTO ${this.P}companies (id, run_id, domain, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json`,
      [c.id, c.runId, c.domain, c.createdAt, c.updatedAt, JSON.stringify(c)],
    );
  }
  async getCompany(id: string) {
    const r = await this.q(`SELECT json FROM ${this.P}companies WHERE id = ?`, [id]);
    return r[0] ? (JSON.parse(String(r[0].json)) as CompanyRecord) : null;
  }
  async listCompanies(runId: string) {
    const r = await this.q(`SELECT json FROM ${this.P}companies WHERE run_id = ? ORDER BY created_at ASC, id ASC`, [runId]);
    return r.map((x) => JSON.parse(String(x.json)) as CompanyRecord);
  }
  async claimSend(key: string, companyId: string) {
    const now = new Date().toISOString();
    const ins = await this.q(
      `INSERT INTO ${this.P}sends (key, company_id, state, updated_at) VALUES (?, ?, 'pending', ?) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, companyId, now],
    );
    if (ins.length > 0) return { claimed: true };
    const existing = await this.getSend(key);
    return { claimed: false, existing: existing ?? undefined };
  }
  async setSend(key: string, state: SendLockRow["state"], messageId?: string | null, detail?: string | null) {
    await this.q(
      `UPDATE ${this.P}sends SET state = ?, message_id = COALESCE(?, message_id), detail = ?, updated_at = ? WHERE key = ?`,
      [state, messageId ?? null, detail ?? null, new Date().toISOString(), key],
    );
  }
  async getSend(key: string) {
    const r = await this.q(`SELECT key, company_id, state, message_id, updated_at, detail FROM ${this.P}sends WHERE key = ?`, [key]);
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
  async getSecret(name: string) {
    const r = await this.q(`SELECT v FROM ${this.P}secrets WHERE k = ?`, [name]);
    return r[0] ? String(r[0].v) : null;
  }
  async setSecret(name: string, value: string) {
    await this.q(
      `INSERT INTO ${this.P}secrets (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      [name, value, new Date().toISOString()],
    );
  }
  async hit(key: string, by: number) {
    const now = new Date();
    const r = await this.q(
      `INSERT INTO ${this.P}counters AS c (k, n, updated_at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET n = c.n + excluded.n, updated_at = excluded.updated_at RETURNING n`,
      [key, by, now.toISOString()],
    );
    // Retention: whenever counters are written (at most every 10 minutes per instance), drop rows idle for 48h. Live windows
    // (the current hour/day, written within the last 48h) are never touched, and neither are the Hunter month/run/company keys.
    if (now.getTime() - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now.getTime();
      await this.q(`DELETE FROM ${this.P}counters WHERE updated_at < ? AND k NOT LIKE 'hunter:%'`, [new Date(now.getTime() - COUNTER_RETENTION_MS).toISOString()]).catch(() => undefined);
    }
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
    }, "sprinto.");
    return cached;
  }
  const onVercel = !!process.env.VERCEL;
  cached = makeSqliteStore(onVercel ? "/tmp/sprinto.db" : `${process.cwd()}/data/sprinto.db`, !onVercel, !onVercel);
  return cached;
}

export function makeSqliteStore(file: string, durable = true, ensureDataDir = false): SqlStore {
  let clientP: Promise<import("@libsql/client").Client> | null = null;
  return new SqlStore("sqlite", durable, async (sql, args = []) => {
    if (!clientP) {
      clientP = (async () => {
        if (ensureDataDir) {
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
}
