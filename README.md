# Sprinto

Cold-outreach research assistant for Sprinto's Growth Lead (Mesa Term 2, AI Case 2). Sprinto sells SOC 2 / ISO 27001 / GDPR readiness to B2B SaaS companies. This app automates the company research behind the first email.

**Safety first:** the only email destination the app can ever use is `rahulmp458@gmail.com` (the owner's own inbox). Nothing is ever sent to a prospect. Facts are never invented: every fact needs a verbatim quote from a fetched page, and anything uncertain is shown as uncertain.

**Live app:** <https://sprinto-seven.vercel.app> (public, no login)

## Status

Working end to end on the live app: scrape, extract, qualify (with the research loop), decision with reasons, the evidence table, and the draft and send guards. Waiting on three one-time steps by the owner:

1. **Gmail connection:** set the client id and secret, then open `/api/gmail/start` and approve (see Gmail connect). Until then drafts are shown and the send result reads "not connected".
2. **Hunter API key:** until `HUNTER_API_KEY` is set, a qualified company records "contact skipped". A real contact can be typed in on the company card, or given up front as `domain | name | contact name | contact role`.
3. **Storage:** durable. Sprinto uses a dedicated `sprinto` schema in an existing Neon Postgres database.

## Pipeline (per company domain)

0. **Discover (optional):** suggests candidate domains from the ICP. These come from the model's memory, are labelled unverified, and every one still goes through the full pipeline.
1. **Scrape:** homepage plus a bounded number of extra pages (cap 4: about, product, pricing, careers, security/trust, customers). Built-in fetch with SSRF protection, then HTML cleaning (nav, footer, cookie banners and boilerplate removed). Fetch failures are logged, never papered over.
2. **Extract:** Gemini returns structured facts, each with a quote and URL. Code checks every quote against the fetched text; unverifiable claims are dropped and logged.
3. **Qualify:** deterministic rules (the model never decides fit), with a bounded research loop (max 2 extra fetches when a required field is missing, then stop).
4. **Contact:** Hunter Domain Search, only after a company qualifies. No key or no suitable person means a recorded skip, never an invented contact. You can also type a real contact in yourself.
5. **Pain points:** the two most likely pains, each with a verified evidence quote.
6. **Draft:** a first email addressed to the person by name with one hook tied to a quote that is verified on a fetched page. An ungrounded hook blocks sending.
7. **Send:** Gmail API, preview to your own inbox only, with a duplicate-send lock.

### ICP rules

| Rule | Type | Effect |
|---|---|---|
| B2B SaaS | hard | non-SaaS: skip |
| Funding stage Series A-C | hard | named stage outside A-C: skip |
| 50-200 employees | soft | flagged only, never disqualifies |
| Already holds SOC 2 / ISO 27001 / GDPR | hard | skip (a quote is shown) |
| Thin, conflicting or missing evidence | | manual review, with the reason |

Stage evidence is always labelled a **proxy, not proof**: a named funding stage, 5+ open roles or an enterprise pricing tier. A named stage in Series A-C passes as "fit (stage is proxy)". With no named stage, it takes at least two proxies (5+ roles and an enterprise tier) to pass; fewer than that goes to manual review.

### Safety design

- **Recipient allowlist (server-side, twice):** `assertAllowedRecipient` runs before the lock claim, and again inside the mailer right before the Gmail call. Exactly one plain address is accepted: no lists, display names, plus-aliases, whitespace or CR/LF.
- **Duplicate-send lock:** an atomic `INSERT ... ON CONFLICT DO NOTHING` claims `send:<company id>`. After a timeout the state is `unknown`. A retry first asks Gmail whether a message with the company's `SPR-xxxxxxxx` token is in Sent. Found means it is marked sent and not resent. Gmail unable to confirm means it refuses to resend. Confirmed not delivered means it retries.
- **No fabrication:** thin pages skip the model entirely; dropped claims are listed in the UI.
- **Secrets** live in `.env` (git-ignored) and Vercel environment variables, and are read only in server code. The browser only ever receives booleans from `/api/health`.
- **Public-demo limits:** see Access protection below.

## Run locally

```bash
npm install
cp .env.example .env     # then fill in the values
npm run dev              # http://localhost:3000
npm run eval             # offline checker pass (no network, no keys needed)
npm run smoke -- acme.com   # live check with real sites and Gemini
```

Without `DATABASE_URL` it stores data in `./data/sprinto.db` (SQLite). With a Postgres/Neon URL it uses that instead (use this on Vercel; serverless disks are not durable).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | yes | extraction, drafting, discovery |
| `DATABASE_URL` | yes on Vercel | Postgres connection string. Tables live in a dedicated `sprinto` schema. Empty locally = SQLite at `./data/sprinto.db` |
| `HUNTER_API_KEY` | optional | Hunter Domain Search. Without it a contact can be typed in by hand |
| `GMAIL_CLIENT_ID` | for Gmail | Google OAuth web client id |
| `GMAIL_CLIENT_SECRET` | for Gmail | Google OAuth web client secret (also the key that encrypts the stored refresh token) |
| `GMAIL_REFRESH_TOKEN` | optional | If set, it is used and the connect flow is skipped |
| `GMAIL_SENDER` | optional | From address, default `rahulmp458@gmail.com`. The recipient allowlist is fixed in code |
| `GMAIL_REDIRECT_URI` | optional | Overrides the derived redirect URI (default `<site origin>/api/gmail/callback`) |
| `RUNS_PER_IP_PER_HOUR`, `RUNS_GLOBAL_PER_DAY`, `DISCOVER_PER_IP_PER_HOUR`, `DISCOVER_GLOBAL_PER_DAY` | optional | Override the limits below |

## Owner access

Live features are owner-only. Sign in at `/owner` with the value of `OWNER_KEY` (at least 16 characters; set it in Vercel, then redeploy). Vercel does not return sensitive values, so `vercel env pull` cannot refresh it locally: **for local owner runs, set a fresh `OWNER_KEY` in your local `.env` by hand** (the copy there may be stale after a rotation on Vercel). Visitors see the landing page and a static sample only.

## Gmail connect (in the app)

1. In Google Cloud Console create an **OAuth client of type Web application**, enable the Gmail API, and add `rahulmp458@gmail.com` as a test user on the consent screen.
2. Register this **Authorized redirect URI** exactly: `https://sprinto-seven.vercel.app/api/gmail/callback` (add `http://localhost:3000/api/gmail/callback` too for local use).
3. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in Vercel and redeploy.
4. Open `/api/gmail/start` (or the "Connect Gmail" link in the status bar) while signed in to `rahulmp458@gmail.com` and approve. Scope requested: `gmail.send` only, with offline access.
5. The callback stores the refresh token encrypted in the database and shows "Gmail connected". The token is never displayed.

With only `gmail.send`, Sprinto cannot read Sent mail. The duplicate-send lock is still atomic in the database, and after a timeout it refuses to resend rather than guess. Apps in Google's Testing mode expire refresh tokens after 7 days; reconnect via `/api/gmail/start`.

## Access protection (public, no login)

- 5 research runs per hour per visitor, 20 runs per day overall (HTTP 429 with `Retry-After`).
- 10 domains per run. Discovery: 5 requests per hour per visitor, 20 per day overall, 5 results each.
- Per-company caps on re-processing (3), adding a contact (3) and resending (5).
- Run lists are not exposed; a run is only readable by its unguessable id.

## Layout

```
src/lib/        pipeline, qualify, extract, draft, hunter, gmail, fetcher, store, discover, limits
src/app/api/    runs, companies/[id]/{process,contact,send}, discover, gmail/{start,callback}, health
src/app/        the single-page UI
scripts/        eval.ts (checker pass), smoke.ts (live), gmail-auth.mjs (optional local alternative)
```
