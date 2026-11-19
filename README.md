# Sprinto

Cold-outreach research assistant for Sprinto's Growth Lead (Mesa Term 2, AI Case 2). Sprinto sells SOC 2 / ISO 27001 / GDPR readiness to B2B SaaS companies. This app automates the company research behind the first email.

**Safety first:** the only email destination the app can ever use is `rahulmp458@gmail.com` (the owner's own inbox). Nothing is ever sent to a prospect. Facts are never invented: every fact needs a verbatim quote from a fetched page, and anything uncertain is shown as uncertain.

**Live app:** <https://sprinto-seven.vercel.app> (public, no login)

## Status

Working end to end on the live app: scrape, extract, qualify (with the research loop), decision with reasons, the evidence table, and the draft and send guards. Waiting on three one-time steps by the owner:

1. **Gmail connection:** needs a Google sign-in and consent (see Gmail setup). Until then drafts are shown and the send result reads "not configured".
2. **Hunter API key:** until `HUNTER_API_KEY` is set, a qualified company records "contact skipped". A real contact can be typed in on the company card, or given up front as `domain | name | contact name | contact role`.
3. **Durable storage on Vercel:** accept the Neon marketplace terms, then run `vercel integration add neon --name sprinto-db` in this folder. Until then the hosted app keeps records in `/tmp` (not durable), the page still works because it carries each company's setup with every request, and sends are verified against Gmail before any retry.

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
- **Public-demo limits:** max 10 domains per run, 40 companies per visitor per day, 250 per day overall.

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

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL` | extraction, drafting, discovery |
| `HUNTER_API_KEY` | Hunter Domain Search (optional; without it contacts can be added by hand) |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Gmail API send from the owner's address to the same address |
| `DATABASE_URL` | Postgres/Neon connection string for durable hosted storage |

## Gmail setup (one-time, needs your browser)

1. Go to <https://console.cloud.google.com/> and create a project (for example `sprinto`).
2. **APIs & Services → Library**: enable **Gmail API**.
3. **APIs & Services → OAuth consent screen**: choose External, fill in the app name and your email, and under **Test users** add `rahulmp458@gmail.com`. Leave the app in Testing.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the client ID and secret into `.env` as `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`.
5. Run `npm run gmail:auth`, open the URL it prints, and approve access for `rahulmp458@gmail.com`. It saves `GMAIL_REFRESH_TOKEN` to `.env` without printing it.
6. Add the three Gmail variables to Vercel (Project Settings → Environment Variables) and redeploy.

Scopes used: `gmail.send`, plus `gmail.readonly` only to verify "sent" before any retry. Google shows an "unverified app" warning for apps in Testing; click Advanced → continue. Refresh tokens for apps in Testing expire after 7 days, so re-run `npm run gmail:auth` if sends start failing.

## Layout

```
src/lib/        pipeline, qualify, extract, draft, hunter, gmail, fetcher, store, discover, limits
src/app/api/    runs, companies/[id]/{process,contact,send}, discover, health
src/app/        the single-page UI
scripts/        eval.ts (checker pass), smoke.ts (live), gmail-auth.mjs
```
