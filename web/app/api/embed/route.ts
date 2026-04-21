import type { NextRequest } from "next/server";
import { embedAll } from "@/lib/gemini/embed";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-gemini-key");
    if (!apiKey) {
      return Response.json({ error: "Missing x-gemini-key header" }, { status: 401 });
    }

    const body = await req.json();
    const { companies, weights, existingMatrix } = body as {
      companies: Array<{ id: string; dimensions: Record<string, string> }>;
      weights?: Record<string, number> | null;
      /** Previously saved feature matrix. Non-zero rows are skipped (incremental re-embed). */
      existingMatrix?: number[][] | null;
    };

    if (!companies?.length) {
      return Response.json({ error: "companies is empty" }, { status: 400 });
    }

    // Stream SSE progress back to the client
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: object) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));

        try {
          for await (const event of embedAll(companies, apiKey, weights, existingMatrix)) {
            send(event);
          }
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/embed] Error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
