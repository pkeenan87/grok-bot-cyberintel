import { defineTool, type ToolContext } from "@cursor/bdk/tools";
import { BriefSchema, validateBrief, renderBriefMarkdown, type BriefInput } from "../lib/brief.js";
import { getBriefConfig } from "../lib/config.js";
import { postBrief, type WebhookResult } from "../lib/webhook.js";

function prepare(input: BriefInput) {
  const { brief, warnings } = validateBrief(input);
  return { brief, warnings, markdown: renderBriefMarkdown(brief), artifactKey: `brief:${brief.localDate}` };
}

export async function submitBrief(input: BriefInput, ctx: Pick<ToolContext, "artifacts" | "host" | "session">) {
  const { brief, warnings, markdown, artifactKey } = prepare(input);
  await ctx.artifacts.tag({
    kind: "legal-cyber-brief", key: artifactKey,
    title: `Legal cyber brief — ${brief.localDate}`,
    data: brief, contents: markdown, contentType: "text/markdown",
  });
  let webhook: WebhookResult = { posted: false };
  if (ctx.session.purpose !== "eval") {
    await ctx.host.kv.put("lastSuccessfulUntil", brief.window.until);
    await ctx.host.kv.put(`delivered:${brief.localDate}`, brief.window.until);
    const config = getBriefConfig();
    if (config.webhookUrl) {
      webhook = await postBrief(config.webhookUrl, config.webhookFormat, markdown, brief);
      if (!webhook.posted) console.warn("Brief webhook failed", webhook.error);
    }
  }
  return { stored: true, artifactKey, warnings, webhook, markdown };
}

export function dryRunBrief(input: BriefInput) {
  const { warnings, markdown, artifactKey } = prepare(input);
  return { stored: false, artifactKey, warnings, webhook: { posted: false }, markdown };
}

export default defineTool({
  description: "Validate citations and cross-check policy, store the legal cyber brief, and optionally deliver to the configured webhook. Return final markdown; confirmed incidents need two distinct source hosts.",
  effect: "write",
  inputSchema: BriefSchema,
  dryRunResult: dryRunBrief,
  execute: submitBrief,
});
