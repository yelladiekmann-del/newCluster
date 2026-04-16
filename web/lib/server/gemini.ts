const GEN_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiInputMessage {
  role: "user" | "model";
  text: string;
}

interface CallGeminiTextOptions {
  apiKey: string;
  prompt?: string;
  systemInstruction?: string;
  history?: GeminiInputMessage[];
  userMessage?: string;
  temperature?: number;
  /**
   * Model to use. Defaults to gemini-2.5-flash.
   * Use "gemini-2.0-flash" for faster structured-output tasks that don't need deep reasoning.
   */
  model?: string;
  /**
   * Set to 0 to disable gemini-2.5-flash thinking mode (faster for structured JSON tasks).
   * Only supported on gemini-2.5-* models — omit when using gemini-2.0-flash.
   */
  thinkingBudget?: number;
  tools?: Array<Record<string, unknown>>;
}

export async function callGeminiText({
  apiKey,
  prompt,
  systemInstruction,
  history = [],
  userMessage,
  temperature = 0.3,
  model = "gemini-2.5-flash",
  thinkingBudget,
  tools,
}: CallGeminiTextOptions): Promise<string> {
  const contents =
    prompt != null
      ? [{ role: "user" as const, parts: [{ text: prompt }] }]
      : [
          ...history.map((msg) => ({
            role: msg.role,
            parts: [{ text: msg.text }],
          })),
          ...(userMessage != null
            ? [{ role: "user" as const, parts: [{ text: userMessage }] }]
            : []),
        ];

  const res = await fetch(`${GEN_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(systemInstruction
        ? { system_instruction: { parts: [{ text: systemInstruction }] } }
        : {}),
      contents,
      ...(tools ? { tools } : {}),
      generationConfig: {
        temperature,
        ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

export function repairJson(raw: string): string {
  return raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim()
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseJsonObject<T>(raw: string): T | null {
  try {
    return JSON.parse(repairJson(raw)) as T;
  } catch {
    return null;
  }
}

export function extractFirstJsonObject(raw: string): string | null {
  const text = repairJson(raw);
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
