// Gemini access over plain REST. The key is read from GEMINI_API_KEY (server-side only) and sent in a header.

export type LlmKind = "extract" | "draft" | "discover";
export interface LlmRequest {
  kind: LlmKind;
  system: string;
  prompt: string;
  temperature?: number;
}
export type LLM = (req: LlmRequest) => Promise<unknown>;

export function geminiConfigured() {
  return !!process.env.GEMINI_API_KEY?.trim();
}

function stripFences(s: string) {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

export const geminiLLM: LLM = async ({ system, prompt, temperature = 0.2 }) => {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(40_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature },
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `Gemini HTTP ${res.status}`;
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini HTTP ${res.status}: ${body.replace(key, "<key>").slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text.trim()) {
        lastErr = "empty Gemini response";
        continue;
      }
      try {
        return JSON.parse(stripFences(text));
      } catch {
        lastErr = "Gemini returned invalid JSON";
        continue;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/^Gemini HTTP 4/.test(msg)) throw e;
      lastErr = msg;
    }
  }
  throw new Error(`Gemini failed: ${lastErr}`);
};
