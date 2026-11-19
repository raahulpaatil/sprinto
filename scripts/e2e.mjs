// Browser check of the main journey with every /api call answered by in-test mocks (no model, Hunter, Gmail or site fetches).
// Needs a running build (npm run build && npx next start -p 3100) and Playwright with Chromium available.
//   BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/e2e.mjs
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Playwright is not a project dependency; resolve it from the environment (NODE_PATH or a global install).
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE ?? "http://localhost:3100";
const SHOTS = process.env.SHOTS ?? "./e2e-shots";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`); };

const now = () => new Date().toISOString();
const fact = (value, quote, url, confidence = "stated") => ({ value, confidence, evidence: quote ? { quote, url } : null });
const empty = { value: null, confidence: "unknown", evidence: null };

function company(runId, domain, name) {
  return {
    id: randomUUID(), runId, domain, expectedName: name, sendEnabled: true, status: "queued", stage: "queued", pages: [], droppedClaims: [],
    research: { loops: 0, cap: 3, steps: [], exhausted: false }, decision: { result: "pending", reasons: [], flags: [], missing: [], stageProxies: [] },
    log: [], createdAt: now(), updatedAt: now(),
  };
}
function finish(c, kind) {
  const u = `https://${c.domain}`;
  const base = {
    ...c, status: "done", stage: "done",
    pages: [{ url: u, kind: "home", ok: true, chars: 2400 }, { url: `${u}/security`, kind: "security", ok: kind !== "review", chars: kind === "review" ? 0 : 900, error: kind === "review" ? "404" : undefined }],
    log: [{ t: now(), stage: "fetch", msg: "homepage fetched" }, { t: now(), stage: "qualify", msg: `decision: ${kind}` }],
  };
  const facts = {
    company_name: fact(c.expectedName, `${c.expectedName} helps teams`, u), one_liner: fact("Workflow software for finance teams", "workflow software for finance teams", u),
    is_b2b_saas: fact(kind !== "skip", kind === "skip" ? "We sell shoes online" : `${c.expectedName} is a B2B SaaS platform`, u),
    funding_stage: kind === "fit" ? fact("series_b", "we raised our Series B", `${u}/about`, "proxy") : empty, employee_count: kind === "fit" ? fact(120, "a team of 120", `${u}/about`) : empty,
    open_roles: empty, enterprise_pricing: empty, certifications: [], signals: [], conflicts: [],
  };
  if (kind === "fit") return {
    ...base, facts,
    decision: { result: "fit", reasons: ["B2B SaaS confirmed from the website.", "Stage series b is named on the site. Treated as a proxy, not proof."], flags: ["stage_is_proxy", "headcount_in_band"], missing: [], stageProxies: ["named funding stage on site: series b (proxy, not proof)"] },
    contact: { name: "Dana Ortiz", role: "Head of Security", source: "hunter", why: "Role owns compliance" },
    pains: [{ pain: "Enterprise deals need a SOC 2 report", reasoning: "Their pricing page sells to enterprise buyers.", evidence: { quote: "Enterprise plan with SSO", url: `${u}/pricing` }, grounded: true, certainty: "medium" }],
    draft: { subject: `${c.expectedName} and enterprise security reviews`, body: "Hi Dana,\n\nNoticed your enterprise plan...", hook: "Enterprise plan with SSO", hookEvidence: { quote: "Enterprise plan with SSO", url: `${u}/pricing` }, hookGrounded: true, uncertainFields: [], problems: [], status: "ready" },
    send: { status: "sent", to: "o***@example.com", messageId: "m1", note: "Preview sent to the owner's inbox.", at: now() },
  };
  if (kind === "review") return { ...base, facts, contactSkip: "no contact found", decision: { result: "manual_review", reasons: ["Research budget exhausted while still missing: stage."], flags: [], missing: ["stage"], stageProxies: [] } };
  return { ...base, facts, decision: { result: "skip", reasons: ['Not a B2B SaaS company. Evidence: "We sell shoes online"'], flags: [], missing: [], stageProxies: [] } };
}

const CANDS = [
  { domain: "ledgerly.test", name: "Ledgerly", why: "Finance workflow SaaS selling to mid-market" },
  { domain: "shiftboard.test", name: "Shiftboard", why: "Scheduling platform for clinics" },
  { domain: "solecart.test", name: "SoleCart", why: "Online store software" },
];
const OUTCOME = { "ledgerly.test": "fit", "shiftboard.test": "review", "solecart.test": "skip" };

/** Installs the API mocks on a page; returns the recorded requests and state. */
async function mockApi(page, { processDelay = 0 } = {}) {
  const state = { discoverBodies: [], runBodies: [], runs: new Map(), companies: new Map(), processCalls: new Map(), sendCalls: 0 };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/health") return json(200, {
      sendReady: true, contactLookup: true, gemini: true, store: { kind: "postgres", durable: true, ok: true },
      allowance: { runsLeftThisHourForYou: 3, runsHourlyCap: 3, companiesLeftToday: 40, dailyResetsAtUtc: now(), hourlyResetsAtUtc: now() },
      caps: { companiesGlobalPerDay: 40, geminiDailyCallCap: 150, hunterMonthlyCap: 40, sendsGlobalPerDay: 25 },
      usageToday: { companies: 0, geminiCalls: 0, sends: 0, hunterThisMonth: 0 },
    });
    if (p === "/api/discover") {
      const body = req.postDataJSON();
      state.discoverBodies.push(body);
      const c = body.criteria;
      if (c.note === "fail") return json(502, { error: "Discovery failed: the AI service did not answer. Try again." });
      const summary = `${c.stages.join(", ")} · ${c.headcount} · ${c.model}${c.note ? ` · "${c.note}"` : ""}`;
      return json(200, { criteria: c, summary, candidates: c.note === "empty" ? [] : CANDS });
    }
    if (p === "/api/runs" && req.method() === "POST") {
      const body = req.postDataJSON();
      state.runBodies.push(body);
      const run = { id: randomUUID(), mode: "discover", sendEnabled: body.send, companyIds: [], createdAt: now(), public: true, criteria: body.criteria };
      const cs = body.domains.map((line) => { const [d, n] = line.split("|").map((x) => x.trim()); return company(run.id, d, n); });
      run.companyIds = cs.map((c) => c.id);
      state.runs.set(run.id, run);
      for (const c of cs) state.companies.set(c.id, c);
      return json(200, { run, companies: cs });
    }
    let m = p.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
    if (m) {
      const run = state.runs.get(m[1]);
      if (!run) return json(404, { error: "Run not found." });
      return json(200, { run, companies: run.companyIds.map((id) => state.companies.get(id)) });
    }
    m = p.match(/^\/api\/companies\/([0-9a-f-]{36})\/process$/);
    if (m) {
      const c = state.companies.get(m[1]);
      const n = (state.processCalls.get(c.id) ?? 0) + 1;
      state.processCalls.set(c.id, n);
      if (processDelay) await new Promise((r) => setTimeout(r, processDelay));
      if (OUTCOME[c.domain] === "skip" && n === 1) return json(429, { error: "Daily demo limit reached for AI calls, try again later." });
      const done = finish(c, OUTCOME[c.domain]);
      state.companies.set(c.id, done);
      return json(200, { company: done });
    }
    m = p.match(/^\/api\/companies\/([0-9a-f-]{36})\/send$/);
    if (m) {
      state.sendCalls++;
      const c = state.companies.get(m[1]);
      const next = { ...c, send: { ...c.send, status: "duplicate_prevented", note: "Already sent once for this company, so this send was refused.", at: now() } };
      state.companies.set(c.id, next);
      return json(200, { company: next });
    }
    return json(404, { error: `unmocked ${p}` });
  });
  return state;
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function journey(browser, label, ctxOpts) {
  const ctx = await browser.newContext({ ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const st = await mockApi(page, { processDelay: 700 });
  await page.goto(BASE);
  await page.getByRole("heading", { name: "Who to look for" }).waitFor();
  await page.waitForSelector(".chip.ok");

  // defaults
  const checkedStages = await page.$$eval(".filters fieldset:first-of-type input:checked", (xs) => xs.map((x) => x.parentElement.textContent));
  check(`${label}: default stages are Series A, B, C`, checkedStages.join() === "Series A,Series B,Series C", checkedStages.join());
  check(`${label}: default employees 50 to 200`, (await page.getByLabel("Employees").inputValue()) === "50-200");
  check(`${label}: default business model B2B SaaS`, (await page.getByLabel("Business model").inputValue()) === "b2b_saas");
  check(`${label}: default certification is none held, all three types`, (await page.getByLabel("Certification", { exact: true }).inputValue()) === "none_held" && (await page.$$eval("fieldset:not(:first-of-type) .pill input:checked", (x) => x.length)) === 3);
  check(`${label}: no paste UI, tabs or domain textarea`, (await page.locator("textarea").count()) === 0 && (await page.getByText("Paste domains").count()) === 0 && (await page.locator(".tabs, [role=tab]").count()) === 0);
  check(`${label}: target note is visible near the filters`, await page.getByText("every company is still judged against that target").isVisible());
  check(`${label}: no reset button at defaults`, (await page.getByRole("button", { name: "Reset to Sprinto’s target" }).count()) === 0);
  check(`${label}: no research button before a search`, (await page.getByRole("button", { name: /^Research/ }).count()) === 0);
  check(`${label}: no horizontal scroll at defaults`, await noHScroll(page));
  await page.screenshot({ path: `${SHOTS}/${label}-1-defaults.png`, fullPage: true });

  // change filters, reset, change again
  await page.getByText("Pre-seed", { exact: true }).click();
  await page.getByLabel("Employees").selectOption("1-10");
  await page.getByLabel("Certification", { exact: true }).selectOption("any");
  check(`${label}: cert types disabled when status is any`, await page.locator("fieldset:not(:first-of-type)").evaluate((f) => f.disabled));
  await page.getByText("Any stage", { exact: true }).click();
  const afterAny = await page.$$eval(".filters fieldset:first-of-type input:checked", (xs) => xs.map((x) => x.parentElement.textContent));
  check(`${label}: picking "Any stage" clears the other stages`, afterAny.join() === "Any stage", afterAny.join());
  await page.getByRole("button", { name: "Reset to Sprinto’s target" }).click();
  check(`${label}: reset restores defaults`, (await page.getByLabel("Employees").inputValue()) === "50-200" && (await page.getByLabel("Certification", { exact: true }).inputValue()) === "none_held" && (await page.getByRole("button", { name: "Reset to Sprinto’s target" }).count()) === 0);
  await page.getByText("Pre-seed", { exact: true }).click();
  await page.getByText("Series C", { exact: true }).click();
  await page.getByLabel("Business model").selectOption("marketplace");
  await page.getByText("GDPR", { exact: true }).click();
  await page.getByLabel("Industry or region (optional)").fill("fintech in Europe");
  await page.screenshot({ path: `${SHOTS}/${label}-2-changed-filters.png`, fullPage: true });

  // search
  await page.getByRole("button", { name: "Find companies" }).click();
  await page.getByText("3 suggestions").waitFor();
  const sent = st.discoverBodies.at(-1).criteria;
  check(`${label}: search sends the selected filters`, sent.stages.join() === "pre_seed,series_a,series_b" && sent.model === "marketplace" && sent.certTypes.join() === "soc2,iso27001" && sent.note === "fintech in Europe" && sent.headcount === "50-200", JSON.stringify(sent));
  check(`${label}: candidate list shows the active criteria`, await page.locator(".cands").getByText(/Searched for: Pre-seed, Series A, Series B · 50 to 200 employees · Marketplace · No SOC 2 or ISO 27001 held · "fintech in Europe"/).isVisible());
  check(`${label}: candidates are labelled unverified`, await page.getByText("Suggested by the AI from memory and not checked yet").isVisible());
  check(`${label}: all candidates preselected`, (await page.getByRole("button", { name: "Research 3 selected" }).count()) === 1);
  await page.locator(".cand", { hasText: "Shiftboard" }).locator("input").uncheck();
  await page.locator(".cand", { hasText: "Shiftboard" }).locator("input").check();
  await page.screenshot({ path: `${SHOTS}/${label}-3-candidates.png`, fullPage: true });

  // research
  await page.getByRole("button", { name: "Research 3 selected" }).click();
  await page.getByRole("button", { name: "Stop after current" }).waitFor();
  check(`${label}: stop button shows while running`, true);
  const rb = st.runBodies.at(-1);
  check(`${label}: research sends selected domains, preview choice and criteria`, rb.domains.length === 3 && rb.domains[0] === "ledgerly.test | Ledgerly" && rb.send === true && rb.criteria.model === "marketplace", JSON.stringify(rb));
  await page.locator(".badge.b-error").first().waitFor({ timeout: 15000 });
  await page.locator(".badge.b-fit").first().waitFor({ timeout: 15000 });
  await page.locator(".badge.b-manual_review").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Retry failed" }).waitFor();
  check(`${label}: failed company shows its error and a retry`, await page.getByText("Daily demo limit reached for AI calls").isVisible());
  check(`${label}: results show the run's criteria and the target note`, await page.getByText(/Judged against Sprinto’s target/).isVisible());
  check(`${label}: flags are shown in plain words`, await page.getByText("Stage named on the company’s site, not independently confirmed").isVisible());
  await page.screenshot({ path: `${SHOTS}/${label}-4-results-with-error.png`, fullPage: true });
  await page.getByRole("button", { name: "Retry failed" }).click();
  await page.locator(".badge.b-skip").first().waitFor({ timeout: 15000 });
  check(`${label}: retry turns the failed company into its result`, (await page.locator(".badge.b-error").count()) === 0);

  // preview resend hits the duplicate lock
  await page.getByRole("button", { name: "Send again (duplicate protection blocks it)" }).click();
  await page.getByText("duplicate prevented", { exact: true }).waitFor();
  check(`${label}: resend reports duplicate prevented`, st.sendCalls === 1);
  check(`${label}: no horizontal scroll with results`, await noHScroll(page));
  await page.screenshot({ path: `${SHOTS}/${label}-5-final.png`, fullPage: true });

  // reload via the run link
  const runId = st.runBodies.length && [...st.runs.keys()].at(-1);
  await page.goto(`${BASE}/?run=${runId}`);
  await page.locator(".badge.b-fit").first().waitFor();
  check(`${label}: run link reload shows all results and the saved criteria`, (await page.locator(".co-title").count()) === 3 && (await page.getByText(/Searched for: Pre-seed, Series A, Series B · 50 to 200 employees · Marketplace · No SOC 2 or ISO 27001 held · "fintech in Europe"/).isVisible()));

  // empty and failure states
  await page.getByLabel("Industry or region (optional)").fill("empty");
  await page.getByRole("button", { name: "Find companies" }).click();
  await page.getByText("No suggestions").waitFor();
  check(`${label}: empty result explains itself and offers no research button`, (await page.getByText("Nothing came back for these criteria").isVisible()) && (await page.getByRole("button", { name: /^Research/ }).count()) === 0);
  await page.getByLabel("Industry or region (optional)").fill("fail");
  await page.getByRole("button", { name: "Find companies" }).click();
  await page.locator(".err[role=alert]").waitFor();
  check(`${label}: search failure shows the error and drops the old list`, /did not answer/.test(await page.locator(".err[role=alert]").textContent()) && (await page.locator(".cands").count()) === 0);
  await page.screenshot({ path: `${SHOTS}/${label}-6-failure.png`, fullPage: true });
  check(`${label}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await journey(browser, "desktop", { viewport: { width: 1280, height: 900 } });
  await journey(browser, "mobile", { ...devices["iPhone 13"] });

  // reduced motion
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await mockApi(page);
  await page.goto(BASE);
  await page.getByRole("heading", { name: "Who to look for" }).waitFor();
  const anim = await page.locator(".card").first().evaluate((e) => getComputedStyle(e).animationName);
  const trans = await page.locator(".pill span").first().evaluate((e) => getComputedStyle(e).transitionDuration);
  check("reduced motion: card entrance animation is off", anim === "none", anim);
  check("reduced motion: filter pill transitions are off", trans === "0s", trans);
  await ctx.close();

  // real server validation (not mocked): an invalid filter is refused before any model call
  const api = await browser.newContext();
  const r = await api.request.post(`${BASE}/api/discover`, { data: { criteria: { stages: ["series_z"] } } });
  check("server rejects an invalid filter with 400", r.status() === 400 && /Unknown funding stage/.test((await r.json()).error), String(r.status()));
  const r2 = await api.request.post(`${BASE}/api/discover`, { data: { criteria: { headcount: "50-200", certStatus: "held", certTypes: [] } } });
  check("server rejects an empty certification type list", r2.status() === 400, String(r2.status()));
  await api.close();
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
