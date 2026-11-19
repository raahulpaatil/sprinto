# Sprinto

Cold-outreach research assistant for Sprinto's Growth Lead (Mesa Term 2, AI Case 2). Sprinto sells SOC 2 / ISO 27001 / GDPR readiness to B2B SaaS companies. This app automates the company research behind the first email.

**Safety first:** the only email destination the app can ever use is `rahulmp458@gmail.com` (the project owner's inbox). Nothing is ever sent to a prospect. Facts are never invented: every fact needs a verbatim quote from a fetched page, and anything uncertain is shown as uncertain.

**Live app:** <https://sprinto-seven.vercel.app> (public, no login)

## Status

One app for everyone, no sign-in and no roles: anyone with the link can search for companies, pick which to research, watch the run, read the result for their own run (via that run's unguessable URL), add a contact, and trigger the preview email. Previews can only ever go to the owner's inbox. One shared set of limits applies to everyone (see below), and the page shows what is left.

Disabled (404): connecting or relinking Gmail from the web. The existing connection is used server-side only and its token is never exposed.

## Pipeline (per company domain)

0. **Discover:** the only way in. Filters for funding stage, headcount, business model, certification status and type, plus optional industry or region guidance. The defaults are Sprinto's target (Series A to C, 50 to 200 employees, B2B SaaS, no SOC 2 / ISO 27001 / GDPR held). Filters are allowlisted on the server (`src/lib/criteria.ts`) and turned into the discovery prompt. Suggestions come from the model's memory, are labelled unverified, and every selected one goes through the full pipeline. A wider search does not change qualification: `qualify.ts` never reads the criteria, so a pre-seed company found by a pre-seed search is still a Skip. The run saves the criteria for display on its run link.
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
npm run build && npx next start -p 3100   # then, in another shell:
node scripts/e2e.mjs     # browser journey with mocked APIs (needs Playwright + Chromium installed globally)
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
| Cap overrides | optional | see the cap table below |

## Gmail

There is no in-app Gmail connect or relink (`/api/gmail/start` and `/api/gmail/callback` return 404), because linking an account from a public page is not safe without sign-in. Sending uses a refresh token that already sits server-side, either in `GMAIL_REFRESH_TOKEN` or encrypted in the `sprinto.secrets` table (AES-256-GCM, keyed from `GMAIL_CLIENT_SECRET`). It is never returned by any endpoint. To change the connection, set `GMAIL_REFRESH_TOKEN` in Vercel (for example from `npm run gmail:auth`, a local helper that does the Google consent on your machine) and redeploy. Scope: `gmail.send` only, so after a timeout the app refuses to resend instead of checking Sent mail. Apps in Google's Testing mode expire refresh tokens after 7 days.

## Access protection and cost caps (public, no login)

**Isolation.** A run is readable only through its own run id (a random UUID returned to the visitor who started it). There is no listing endpoint and no sign-in. Runs created before the single-role change (owner runs, early test runs), and any run without the `public` flag (including everything created before this model), are private and answer 404 to visitors.

**Hard caps** (all enforced in code, counters in Postgres so they survive restarts and redeploys; defaults sized for free tiers, change only deliberately):

| Cap | Default | Env override |
|---|---|---|
| Research runs per visitor IP per hour | 3 | `RUNS_PER_IP_PER_HOUR` |
| Companies per day, all visitors | 40 | `COMPANIES_GLOBAL_PER_DAY` |
| Domains per run | 10 | fixed |
| Discovery requests per IP per hour / per day overall | 3 / 10 | `DISCOVER_PER_IP_PER_HOUR`, `DISCOVER_GLOBAL_PER_DAY` |
| Discovery results | 5 | fixed |
| Gemini calls per day (every model call is counted; refused past the cap) | 150 | `GEMINI_DAILY_CALL_CAP` |
| Preview emails per day | 25 | `SENDS_GLOBAL_PER_DAY` |
| Re-process / add-contact / resend per company | 3 / 3 / 5 | fixed |

Over a limit the app shows "Daily demo limit reached, try again tomorrow" (or the hourly equivalent with a retry time), never a crash. A Gemini 429 is treated the same way.

**Hunter credits (never approximated).** One lookup = one Domain Search with `limit=10` and at most one retry after a failed call. Every lookup passes four gates, each a graceful skip with a visible note on the company card:
1. at most one lookup per company record;
2. at most 5 lookups per run (`HUNTER_PER_RUN_CAP`), however many domains it has;
3. Hunter's own account endpoint is read fresh before each lookup and the lookup is refused if it would leave fewer than 10 credits (`HUNTER_RESERVE`); if the remaining count cannot be read, the lookup is refused;
4. a persistent monthly counter in Postgres, capped at 40 (`HUNTER_MONTHLY_CAP`).

Credits are Hunter's own accounting; the numbers shown on the page come from Hunter's account endpoint.

**Manual review.** A manual-review card lists exactly what is missing (certifications, funding stage, SaaS status). The reviewer can add a contact and get a draft clearly labelled "MANUAL-REVIEW DRAFT". That never changes the decision, and a skipped company cannot be drafted at all. All send guards (owner-inbox allowlist, one send per company, daily cap) still apply.

**Research depth.** Besides pages linked from the homepage, the research loop probes conventional paths: security (`/security`, `/trust`, `/trust-center`, `/compliance`, `trust.<domain>`...), legal, about, careers/jobs, press/blog, pricing. Up to 3 loops, 4 URLs per loop, 12 extra fetch attempts and 6 extra pages per company. If no security or trust page exists at any probed path, the company can still be a fit, flagged `certs_unverified_no_security_page` with the plain-language note that absence of evidence is not proof.

## Layout

```
src/lib/        pipeline, qualify, extract, draft, hunter, gmail, fetcher, store, discover, criteria, limits
src/app/api/    runs, companies/[id]/{process,contact,send}, discover, gmail/{start,callback}, health
src/app/        the single-page UI
scripts/        eval.ts (checker pass), e2e.mjs (mocked browser journey), smoke.ts (live), gmail-auth.mjs (optional local alternative)
```
