import type { NextRequest } from "next/server";
import { extractAllDimensions, type CompanyRow } from "@/lib/gemini/extract-dimensions";
import { getGeminiKey } from "@/lib/server/gemini-key";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const apiKey = getGeminiKey();

  const { rows } = (await req.json()) as { rows: CompanyRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: "rows must be a non-empty array" }, { status: 400 });
  }

  // Stream progress via SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        const results = await extractAllDimensions(apiKey, rows, (p) => {
          send({ type: "progress", ...p });
        });
        send({ type: "done", results });
      } catch (err) {
        send({ type: "error", message: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
