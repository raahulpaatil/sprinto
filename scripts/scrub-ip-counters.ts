// One-off maintenance: replace raw visitor IPs in counter keys with the salted hash, WITHOUT resetting live windows.
//  - rows for the CURRENT hour are re-keyed to the hashed id with the same count
//  - rows for earlier hours (their windows are over) are deleted
// Run once after IP hashing is deployed:  npx tsx --env-file=.env scripts/scrub-ip-counters.ts
import { hashIp } from "../src/lib/limits";
import { getStore, SqlStore } from "../src/lib/store";

async function main() {
  const store = getStore();
  if (!(store instanceof SqlStore)) throw new Error("expected a SQL store");
  const T = store.kind === "postgres" ? "sprinto.counters" : "counters";
  const hour = new Date().toISOString().slice(0, 13);
  const rows = await store.rawExec(`SELECT k, n FROM ${T}`);
  const ip = /^(runs:h|discover:h|gmailstart|ownerlogin:h):(\d{4}-\d{2}-\d{2}T\d{2}):(\d{1,3}(?:\.\d{1,3}){3})$/;
  let rekeyed = 0, deleted = 0;
  for (const r of rows) {
    const m = ip.exec(String(r.k));
    if (!m) continue;
    const [, prefix, h, raw] = m;
    if (h === hour) {
      await store.hit(`${prefix}:${h}:${hashIp(raw)}`, Number(r.n)); // keeps the live window's count under the hashed key
      rekeyed++;
    } else deleted++;
    await store.rawExec(`DELETE FROM ${T} WHERE k = ?`, [String(r.k)]);
  }
  const left = (await store.rawExec(`SELECT k FROM ${T}`)).filter((r) => /\d+\.\d+\.\d+\.\d+/.test(String(r.k))).length;
  console.log(`re-keyed (current hour) ${rekeyed}, deleted (past hours) ${deleted}, rows still embedding an IPv4: ${left}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
