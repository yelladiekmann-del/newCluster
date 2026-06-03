import type { NextRequest } from "next/server";
import { generateSlides } from "@/lib/slides/generate";
import type { SlidesData } from "@/lib/slides/types";

export const maxDuration = 60;

const TEMPLATE_ID =
  process.env.NEXT_PUBLIC_SLIDES_TEMPLATE_ID ?? "16XfrganVuisxWhIHAfQcfNb1t18s1bgPJ2M8HXBJTeM";

export async function POST(req: NextRequest) {
  const { token, data } = (await req.json()) as {
    token: string;
    data: SlidesData;
  };

  if (!token) {
    return Response.json({ error: "Google OAuth token required" }, { status: 401 });
  }
  if (!data?.client_company) {
    return Response.json({ error: "data.client_company is required" }, { status: 400 });
  }

  try {
    const url = await generateSlides(token, TEMPLATE_ID, data);
    return Response.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[generate-slides]", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
