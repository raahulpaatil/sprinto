// Built-in scraping: safe fetch + HTML cleaning. No paid scraping services.

import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";

export interface FetchResult {
  url: string;
  finalUrl: string;
  ok: boolean;
  status?: number;
  error?: string;
  html?: string;
}
export type Fetcher = (url: string) => Promise<FetchResult>;

export const MAX_TEXT_CHARS = 7000;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 4;
const UA = "SprintoResearchBot/1.0 (student project; respects public pages only)";

export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(s)) return null;
  return s;
}

/** Approximate registrable domain (eTLD+1) without a public-suffix list. */
export function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  if (tld.length === 2 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(sld)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
  }
  return true;
}

async function assertPublicHost(hostname: string) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("blocked: private address");
    return;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("blocked: local hostname");
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (addrs.length === 0) throw new Error("dns: no address");
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error("blocked: resolves to private address");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      chunks.push(value.slice(0, value.length - (total - MAX_BYTES)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export const realFetch: Fetcher = async (url) => {
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(current);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("blocked: protocol");
      if (u.port && u.port !== "80" && u.port !== "443") throw new Error("blocked: port");
      await assertPublicHost(u.hostname);
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location")!, current).toString();
        continue;
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (!res.ok) return { url, finalUrl: current, ok: false, status: res.status, error: `HTTP ${res.status}` };
      if (!/html|xml/i.test(ctype)) return { url, finalUrl: current, ok: false, status: res.status, error: `not HTML (${ctype || "unknown"})` };
      const html = await readCapped(res);
      return { url, finalUrl: current, ok: true, status: res.status, html };
    }
    return { url, finalUrl: current, ok: false, error: "too many redirects" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { url, finalUrl: current, ok: false, error: /timeout|abort/i.test(msg) ? "timeout" : msg.slice(0, 160) };
  }
};

export interface CleanPage {
  title: string;
  description: string;
  siteName: string;
  text: string;
  links: { href: string; text: string }[];
}

const NOISE_SELECTORS =
  "script,style,noscript,svg,iframe,template,nav,footer,aside,form,[role=navigation],[role=contentinfo],[aria-hidden=true]";
const NOISE_ATTR = /(cookie|consent|onetrust|cookiebot|osano|gdpr-banner|cc-window|newsletter-popup|skip-link)/i;

export function cleanHtml(html: string, baseUrl: string): CleanPage {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  const description = ($('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content") ?? "").trim();
  const siteName = ($('meta[property="og:site_name"]').attr("content") ?? "").trim();

  // Collect links first (nav/footer hold the about/careers/security links), then strip boilerplate.
  const links: { href: string; text: string }[] = [];
  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href") ?? "";
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) return;
    try {
      const abs = new URL(raw, baseUrl);
      abs.hash = "";
      links.push({ href: abs.toString(), text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 80) });
    } catch {
      /* ignore bad href */
    }
  });

  $(NOISE_SELECTORS).remove();
  $("*").each((_, el) => {
    const attrs = `${$(el).attr("id") ?? ""} ${$(el).attr("class") ?? ""}`;
    if (attrs.trim() && NOISE_ATTR.test(attrs)) $(el).remove();
  });
  $("br").replaceWith("\n");
  $("h1,h2,h3,h4,h5,h6,p,li,tr,div,section,article,blockquote,figcaption,dt,dd,button,a").each((_, el) => {
    $(el).append("\n");
  });

  const raw = $("body").text() || $.root().text();
  const lines: string[] = [];
  for (const l of raw.split("\n")) {
    const t = l.replace(/\s+/g, " ").trim();
    if (t.length < 3) continue;
    if (lines[lines.length - 1] === t) continue;
    lines.push(t);
  }
  const head = [title && `TITLE: ${title}`, siteName && `SITE: ${siteName}`, description && `DESCRIPTION: ${description}`].filter(Boolean) as string[];
  const text = [...head, ...lines].join("\n").slice(0, MAX_TEXT_CHARS);
  const seen = new Set<string>();
  const uniq = links.filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true)));
  return { title, description, siteName, text, links: uniq };
}

export type PageKind = "about" | "product" | "pricing" | "careers" | "security" | "customers";

const KIND_PATTERNS: Record<PageKind, RegExp> = {
  about: /\/(about|about-us|company|who-we-are|our-story|team)(\/|$|\?)/i,
  product: /\/(product|products|platform|solutions?|features|how-it-works)(\/|$|\?)/i,
  pricing: /\/(pricing|plans)(\/|$|\?)/i,
  careers: /\/(careers?|jobs?|join-us|join|work-with-us|hiring)(\/|$|\?)/i,
  security: /\/(security|trust|trust-center|compliance|security-and-compliance)(\/|$|\?)|^https?:\/\/(trust|security)\./i,
  customers: /\/(customers?|case-stud(y|ies)|success-stories|stories)(\/|$|\?)/i,
};
const GUESS_PATH: Record<PageKind, string> = {
  about: "/about",
  product: "/product",
  pricing: "/pricing",
  careers: "/careers",
  security: "/security",
  customers: "/customers",
};
const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|bamboohr\.com|workdayjobs\.com|smartrecruiters\.com)$/i;

export function sameSite(href: string, baseHost: string): boolean {
  try {
    const h = new URL(href).hostname;
    return registrable(h) === registrable(baseHost);
  } catch {
    return false;
  }
}

/** Pick one link of the wanted kind that has not been fetched yet; fall back to a conventional path. */
export function pickPage(
  kind: PageKind,
  links: { href: string; text: string }[],
  baseUrl: string,
  fetched: Set<string>,
  allowGuess = true,
): string | null {
  const baseHost = new URL(baseUrl).hostname;
  const re = KIND_PATTERNS[kind];
  const candidates = links.filter((l) => {
    if (fetched.has(stripSlash(l.href))) return false;
    let host = "";
    try { host = new URL(l.href).hostname; } catch { return false; }
    const allowed = sameSite(l.href, baseHost) || (kind === "careers" && ATS_HOSTS.test(host));
    return allowed && (re.test(l.href) || (kind === "careers" && ATS_HOSTS.test(host)));
  });
  candidates.sort((a, b) => a.href.length - b.href.length);
  if (candidates[0]) return candidates[0].href;
  if (!allowGuess) return null;
  const guess = new URL(GUESS_PATH[kind], baseUrl).toString();
  return fetched.has(stripSlash(guess)) ? null : guess;
}

export function stripSlash(u: string) {
  return u.replace(/\/+$/, "");
}

export function kindOfUrl(url: string): string {
  for (const k of Object.keys(KIND_PATTERNS) as PageKind[]) if (KIND_PATTERNS[k].test(url)) return k;
  return "other";
}

/** Fetch the homepage trying https://domain, https://www.domain, then http. */
export async function fetchHomepage(domain: string, fetcher: Fetcher): Promise<FetchResult> {
  let last: FetchResult | null = null;
  for (const u of [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`]) {
    const r = await fetcher(u);
    if (r.ok) return r;
    last = r;
  }
  return last ?? { url: domain, finalUrl: domain, ok: false, error: "unreachable" };
}
