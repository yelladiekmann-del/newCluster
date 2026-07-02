/**
 * POST /api/test-chat
 *
 * Automated test route for the chat / cluster-review pipeline.
 * Builds the full system context from a real session and optionally calls Gemini.
 *
 * Body:
 *   uid        string   — session ID to load
 *   message?   string   — user message (default: cluster review prompt)
 *   mode?      "chat" | "review"  (default: "review")
 *   dryRun?    boolean  — if true, return the context + prompt WITHOUT calling Gemini
 *
 * Response:
 *   {
 *     systemPrompt:   string,   // the full system instruction sent to Gemini
 *     userMessage:    string,   // the (possibly wrapped) user message
 *     response?:      string,   // Gemini's raw text (absent if dryRun)
 *     actions?:       object[], // parsed <actions> block (absent if dryRun)
 *     context: {
 *       clusterCount:  number,
 *       companyCount:  number,
 *       outlierCount:  number,
 *       gapHints:      string[],
 *       overlapCandidates: { a: string; b: string; reason: string }[],
 *       clusterNames:  string[],
 *     },
 *     elapsed: number,          // ms total
 *   }
 */

import type { NextRequest } from "next/server";
import { buildChatSystemPrompt, buildStructuredReviewUserMessage } from "@/lib/server/chat-prompts";
import { buildReviewContext } from "@/lib/server/review-context";
import { callGeminiText, parseJsonObject } from "@/lib/server/gemini";
import { getGeminiKey } from "@/lib/server/gemini-key";
import { loadSessionSnapshot } from "@/lib/server/session-data";
import { normalizeAndValidateActions } from "@/lib/server/action-validation";

export const maxDuration = 120;

const DEFAULT_REVIEW_MESSAGE = `Review all clusters and give me a substantive market analysis of this segmentation. Focus on what the companies actually do — their problem domains, customer types, and delivery mechanisms — not statistical properties.

**1. KEEP** — Clusters that represent a genuinely distinct, well-populated market segment. For each: explain in 1–2 sentences what unites these companies substantively.

**2. DELETE** — Clusters that lack a coherent business narrative. For each: name 1–2 example companies and explain why they don't form a real segment.

**3. MERGE** — Pairs or groups where companies are solving the same core problem from slightly different angles. For each: name which clusters, explain the shared substance, and suggest a result name.

**4. ADD** — Market segments clearly visible in the data that no current cluster captures. For each: name the segment and list 3–5 specific company names.

After your analysis, append a machine-readable action list in the required <actions> format.`;

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const apiKey = getGeminiKey();

  const {
    uid,
    message,
    mode = "review",
    dryRun = false,
  } = (await req.json()) as {
    uid: string;
    message?: string;
    mode?: "chat" | "review";
    dryRun?: boolean;
  };

  console.log(`[test-chat] START uid=${uid} mode=${mode} dryRun=${dryRun}`);

  if (!uid) {
    return Response.json({ error: "uid is required" }, { status: 400 });
  }

  try {
    const { session, companies, clusters } = await loadSessionSnapshot(uid);

    const reviewContext = buildReviewContext({
      session,
      companies,
      clusters,
      marketContext: session.chatMarketContextRaw ?? "",
    });

    const systemPrompt = buildChatSystemPrompt(reviewContext);
    const userMessage =
      mode === "review"
        ? buildStructuredReviewUserMessage(message ?? DEFAULT_REVIEW_MESSAGE)
        : (message ?? DEFAULT_REVIEW_MESSAGE);

    // Summarise context for callers (without the full 100k-char system prompt)
    const contextSummary = {
      clusterCount:       reviewContext.clusterCount,
      companyCount:       reviewContext.companyCount,
      outlierCount:       reviewContext.outlierCount,
      gapHints:           reviewContext.gapHints,
      overlapCandidates:  reviewContext.overlapCandidates.map((c) => ({
        a: c.clusterAName,
        b: c.clusterBName,
        reason: c.reason,
      })),
      clusterNames:       reviewContext.clusterSummaries.map((s) => s.clusterName),
    };

    console.log(`[test-chat] uid=${uid} mode=${mode} dryRun=${dryRun} clusters=${contextSummary.clusterCount} companies=${contextSummary.companyCount}`);

    if (dryRun) {
      return Response.json({
        systemPrompt,
        userMessage,
        context: contextSummary,
        elapsed: Date.now() - t0,
      });
    }

    // Call Gemini
    const rawText = await callGeminiText({
      apiKey,
      systemInstruction: systemPrompt,
      history: [],
      userMessage,
      temperature: mode === "review" ? 0.35 : 0.5,
      thinkingBudget: 0,
    });

    const actionsMatch = rawText.match(/<actions>([\s\S]*?)<\/actions>/);
    const text = rawText.replace(/<actions>[\s\S]*?<\/actions>/, "").trim();

    const actionsRaw = actionsMatch?.[1]?.trim() ?? null;
    let actions = null;
    let actionsParseError: string | null = null;
    if (actionsMatch && actionsRaw) {
      const rawActions = parseJsonObject<unknown[]>(actionsRaw);
      if (rawActions) {
        actions = normalizeAndValidateActions(
          rawActions,
          clusters.filter((c) => !c.isOutliers).map((c) => c.name),
          companies.map((c) => c.name)
        );
        if (actions === null) {
          actionsParseError = `JSON parsed OK (${rawActions.length} items) but all failed validation`;
          console.log(`[test-chat] actions validation failed. rawActions=`, JSON.stringify(rawActions).slice(0, 500));
        }
      } else {
        actionsParseError = "parseJsonObject returned null (malformed JSON)";
        console.log(`[test-chat] actions JSON parse failed. raw=`, actionsRaw.slice(0, 500));
      }
    }

    // Quality checks — useful for automated testing
    const qualityFlags: string[] = [];
    const lowerText = text.toLowerCase();

    if (/\d+\.\d+/.test(text) && /cohes|score|percent|%/.test(lowerText)) {
      qualityFlags.push("WARN: response may cite raw metric numbers");
    }
    if (text.split(" ").length < 100) {
      qualityFlags.push("WARN: response unusually short");
    }
    if (!text.includes("##") && !text.includes("**")) {
      qualityFlags.push("INFO: response has no markdown structure");
    }
    const mentionedClusters = clusters
      .filter((c) => !c.isOutliers)
      .filter((c) => text.includes(c.name)).length;
    if (mentionedClusters === 0) {
      qualityFlags.push("WARN: no cluster names mentioned in response");
    }
    if (actions !== null && actions.length === 0) {
      qualityFlags.push("INFO: actions block parsed but empty");
    }
    if (actionsMatch && actions === null) {
      qualityFlags.push("WARN: actions block found but failed to parse");
    }

    return Response.json({
      systemPrompt,
      userMessage,
      response: text,
      actions,
      actionsRaw: actionsRaw?.slice(0, 1000) ?? null,
      actionsParseError,
      context: contextSummary,
      qualityFlags,
      elapsed: Date.now() - t0,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
