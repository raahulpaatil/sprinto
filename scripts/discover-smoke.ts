import { discoverDomains } from "../src/lib/discover";
import { geminiLLM } from "../src/lib/gemini";
discoverDomains(process.argv[2], geminiLLM).then((c) => console.log(c.map((x) => `${x.domain} | ${x.name} | ${x.why}`).join("\n")));
