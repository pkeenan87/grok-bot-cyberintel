import { defineTool, type ToolContext } from "@cursor/bdk/tools";
import { BriefSchema, validateBrief, renderBriefMarkdown, type BriefInput } from "../lib/brief.js";
import { getBriefConfig } from "../lib/config.js";
import { postBrief, type WebhookResult } from "../lib/webhook.js";
import { consumeClaim, releaseClaim, type RunClaim } from "./brief_gate.js";

const sameInstant = (a: string | undefined, b: string) => a !== undefined && Date.parse(a) === Date.parse(b);

function prepare(input: BriefInput) {
  const { brief, warnings } = validateBrief(input);
  return { brief, warnings, markdown: renderBriefMarkdown(brief), artifactKey: `brief:${brief.localDate}` };
}

export async function submitBrief(input: BriefInput, ctx: Pick<ToolContext, "artifacts" | "host" | "session">) {
  const { brief, warnings, markdown, artifactKey } = prepare(input);
  // Delivery state is bound to the run the gate claimed, not to model-supplied values,
  // and the claim is consumed atomically so each claimed run delivers at most once.
  let consumed: { claim: RunClaim; version?: string } | null = null;
  if (ctx.session.purpose !== "eval") {
    const outcome = await consumeClaim(ctx.host.kv, brief.localDate, new Date(), (claim) =>
      claim.timezone === brief.timezone && sameInstant(claim.window.since, brief.window.since) && sameInstant(claim.window.until, brief.window.until));
    if (outcome.ok) consumed = outcome;
    else if (outcome.reason === "missing") warnings.push(`No claimed run for ${brief.localDate}; delivery state and webhook skipped.`);
    else if (outcome.reason === "mismatch") {
      const { claim } = outcome;
      throw new Error(`Brief does not match the claimed run for ${brief.localDate}: use timezone ${claim!.timezone} and window ${claim!.window.since} to ${claim!.window.until}.`);
    } else {
      throw new Error(`The brief for this run was already submitted; do not call submit_brief again. Reply with the markdown from the first submission.`);
    }
  }
  try {
    await ctx.artifacts.tag({
      kind: "legal-cyber-brief", key: artifactKey,
      title: `Legal cyber brief — ${brief.localDate}`,
      data: brief, contents: markdown, contentType: "text/markdown",
    });
    if (consumed) {
      await ctx.host.kv.put("lastSuccessfulUntil", brief.window.until);
      await ctx.host.kv.put(`delivered:${brief.localDate}`, brief.window.until);
    }
  } catch (error) {
    // Persistence failed: release the claim so a retry of this run can deliver.
    if (consumed) {
      const released = await releaseClaim(ctx.host.kv, brief.localDate, consumed).catch(() => false);
      if (!released) console.warn("submit_brief could not release the run claim; the next catch-up tick will retry after the lease");
    }
    throw error;
  }
  let webhook: WebhookResult = { posted: false };
  if (consumed) {
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
  description: "Validate citations and cross-check policy, store the legal cyber brief, and optionally deliver to the configured webhook. Return final markdown; confirmed incidents need two distinct source domains. Use the exact localDate, timezone and window from the prompt.",
  effect: "write",
  inputSchema: BriefSchema,
  dryRunResult: dryRunBrief,
  execute: submitBrief,
});
