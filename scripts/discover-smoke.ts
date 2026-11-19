// Live discovery check (uses the real Gemini key from .env; not part of the eval). Optional arg: guidance text.
import { DEFAULT_CRITERIA } from "../src/lib/criteria";
import { discoverDomains } from "../src/lib/discover";
import { geminiLLM } from "../src/lib/gemini";
discoverDomains({ ...DEFAULT_CRITERIA, note: process.argv[2] ?? "" }, geminiLLM).then((c) => console.log(c.map((x) => `${x.domain} | ${x.name} | ${x.why}`).join("\n")));
