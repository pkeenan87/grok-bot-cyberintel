import { defineTool, type ToolContext } from "@cursor/bdk/tools";
import { z } from "zod";
import { getBriefConfig } from "../lib/config.js";
import { computeWindow, localParts, shouldFire } from "../lib/time.js";

export const GateResultSchema = z.discriminatedUnion("shouldRun", [
  z.object({ shouldRun: z.literal(false), reason: z.string(), localDate: z.string().optional(), timezone: z.string().optional() }),
  z.object({ shouldRun: z.literal(true), reason: z.string(), localDate: z.string(), timezone: z.string(), window: z.object({ since: z.string(), until: z.string() }) }),
]);
export type GateResult = z.infer<typeof GateResultSchema>;

function decision(result: GateResult): GateResult {
  console.info("brief_gate", result);
  return result;
}

export async function briefGate(input: { force?: boolean; now?: string }, ctx: Pick<ToolContext, "host">): Promise<GateResult> {
  const { timezone, localHour } = getBriefConfig();
  if (!timezone) return decision({ shouldRun: false, reason: "BRIEF_TIMEZONE not set or invalid" });
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) return decision({ shouldRun: false, reason: "Invalid now timestamp", timezone });
  const localDate = localParts(now, timezone).date;
  const skip = (reason: string) => decision({ shouldRun: false, reason, localDate, timezone });
  if (!input.force && !shouldFire(now, timezone, localHour)) return skip("Outside local weekday scheduling window");
  const kv = ctx.host.kv;
  if (!input.force && await kv.get(`delivered:${localDate}`) != null) return skip("Already delivered");
  const claim = await kv.get(`claim:${localDate}`);
  if (typeof claim === "string" && now.getTime() - Date.parse(claim) < 30 * 60 * 1000) return skip("Already claimed (30 minute lease)");
  const lastSuccess = await kv.get("lastSuccessfulUntil");
  const window = computeWindow(now, typeof lastSuccess === "string" ? lastSuccess : null);
  await kv.put(`claim:${localDate}`, now.toISOString());
  return decision({ shouldRun: true, reason: input.force ? "Forced run claimed" : "Scheduled run claimed", localDate, timezone, window });
}

export default defineTool({
  description: "Gate and claim a local weekday brief, with two hourly catch-up attempts. Force bypasses time and delivery checks, not an active claim or missing timezone.",
  effect: "write",
  inputSchema: z.object({ force: z.boolean().optional(), now: z.iso.datetime({ offset: true }).optional() }),
  dryRunResult: () => ({ shouldRun: false, reason: "Dry run: no claim written" }),
  execute: briefGate,
});
