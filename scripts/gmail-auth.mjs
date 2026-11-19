// One-time Gmail consent helper. Run locally:  npm run gmail:auth
// Reads GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET from .env, opens a loopback server, prints the Google consent URL,
// exchanges the returned code and writes GMAIL_REFRESH_TOKEN into .env. The token is never printed.
//
// Scopes: gmail.send (send) + gmail.readonly (only used to verify a "sent" status before any retry, so a timed-out
// send is never duplicated). The app itself can only ever address mail to the owner's own inbox.

import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

function readEnv() {
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function setEnvVar(key, value) {
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  let found = false;
  const next = lines.map((l) => (l.startsWith(`${key}=`) ? ((found = true), `${key}=${value}`) : l));
  if (!found) next.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, next.join("\n"), { mode: 0o600 });
}

const env = readEnv();
if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
  console.error("Put GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first (see README, Gmail setup).");
  process.exit(1);
}

const state = Math.random().toString(36).slice(2);
const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    login_hint: "rahulmp458@gmail.com",
    state,
  });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  if (u.searchParams.get("state") !== state) {
    res.writeHead(400).end("State mismatch");
    return;
  }
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`Consent failed: ${u.searchParams.get("error") ?? "no code"}`);
    console.error("Consent failed:", u.searchParams.get("error"));
    server.close();
    return;
  }
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const j = await tr.json();
  if (!j.refresh_token) {
    res.writeHead(500).end("No refresh token returned. Remove the app from your Google account permissions and retry.");
    console.error("No refresh token returned:", j.error ?? "", j.error_description ?? "");
    server.close();
    return;
  }
  setEnvVar("GMAIL_REFRESH_TOKEN", j.refresh_token);
  res.writeHead(200, { "content-type": "text/plain" }).end("Sprinto is connected to Gmail. You can close this tab.");
  console.log("Saved GMAIL_REFRESH_TOKEN to .env (not printed). Granted scopes:", j.scope);
  server.close();
});

server.listen(PORT, () => {
  console.log("\nOpen this URL in your browser and approve access for rahulmp458@gmail.com:\n");
  console.log(url + "\n");
  if (process.platform === "darwin") execFile("open", [url], () => {});
});
