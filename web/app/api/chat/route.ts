import type { NextRequest } from "next/server";
import type { ChatMessage } from "@/types";

import { normalizeAndValidateActions } from "@/lib/server/action-validation";
import { buildChatSystemPrompt, buildStructuredReviewUserMessage } from "@/lib/server/chat-prompts";
import { callGeminiText } from "@/lib/server/gemini";
import { buildReviewContext } from "@/lib/server/review-context";
import { loadSessionSnapshot } from "@/lib/server/session-data";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-gemini-key");
  if (!apiKey) {
    return Response.json({ error: "Missing x-gemini-key header" }, { status: 401 });
  }

  const {
    uid,
    history,
    message,
    mode,
  } = (await req.json()) as {
    uid: string;
    history: ChatMessage[];
    message: string;
    mode?: "chat" | "review";
  };

  if (!uid || !message) {
    return Response.json({ error: "uid and message are required" }, { status: 400 });
  }

  try {
    const { session, companies, clusters } = await loadSessionSnapshot(uid);
    const reviewContext = buildReviewContext({
      session,
      companies,
      clusters,
      marketContext: session.chatMarketContextRaw ?? "",
    });

    const rawText = await callGeminiText({
      apiKey,
      systemInstruction: buildChatSystemPrompt(reviewContext),
      history: (history ?? []).slice(-40).map((entry) => ({
        role: entry.role === "user" ? "user" : "model",
        text: entry.content,
      })),
      userMessage:
        mode === "review" ? buildStructuredReviewUserMessage(message) : message,
      temperature: mode === "review" ? 0.35 : 0.5,
      thinkingBudget: 0,
    });

    const actionsMatch = rawText.match(/<actions>([\s\S]*?)<\/actions>/);
    const text = rawText.replace(/<actions>[\s\S]*?<\/actions>/, "").trim();
    let actions = null;
    if (actionsMatch) {
      try {
        actions = normalizeAndValidateActions(
          JSON.parse(actionsMatch[1].trim()),
          clusters.filter((cluster) => !cluster.isOutliers).map((cluster) => cluster.name),
          companies.map((company) => company.name)
        );
      } catch {
        actions = null;
      }
    }

    return Response.json({ text, actions });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
