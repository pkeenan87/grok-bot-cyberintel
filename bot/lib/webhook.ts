import type { Brief } from "./brief.js";

export type WebhookResult = { posted: boolean; status?: number; error?: string };

export async function postBrief(url: string, format: "slack" | "json", markdown: string, brief: Brief): Promise<WebhookResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(format === "slack" ? { text: markdown } : { markdown, brief }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    return response.ok
      ? { posted: true, status: response.status }
      : { posted: false, status: response.status, error: `Webhook returned HTTP ${response.status}` };
  } catch {
    // Do not echo exception messages: they may contain the secret URL or its token.
    return { posted: false, error: "Webhook request failed (URL redacted)" };
  }
}
