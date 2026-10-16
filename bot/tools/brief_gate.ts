import { supportsKvCas } from "@cursor/bdk";
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

const LEASE_MS = 30 * 60 * 1000;
export type RunClaim = { claimedAt: string; timezone: string; window: { since: string; until: string }; submittedAt?: string };

/** Parse a stored claim; legacy claims were a bare ISO timestamp. */
export function parseClaim(value: unknown): Partial<RunClaim> & { claimedAt?: string } | null {
  if (typeof value === "string") return { claimedAt: value };
  if (value && typeof value === "object" && typeof (value as RunClaim).claimedAt === "string") return value as RunClaim;
  return null;
}
const leaseActive = (value: unknown, now: Date) => {
  const claimedAt = parseClaim(value)?.claimedAt;
  return claimedAt !== undefined && now.getTime() - Date.parse(claimedAt) < LEASE_MS;
};

type Kv = ToolContext["host"]["kv"];
/** Claim atomically: CAS when the store supports it; in-process serialization always. */
async function tryClaim(kv: Kv, key: string, claim: RunClaim, now: Date): Promise<boolean> {
  if (supportsKvCas(kv)) {
    const current = await kv.getWithVersion(key);
    if (current === undefined) return (await kv.putIfAbsent(key, claim)).ok;
    if (leaseActive(current.value, now)) return false;
    return (await kv.putIfVersion(key, claim, current.version)).ok;
  }
  if (leaseActive(await kv.get(key), now)) return false;
  await kv.put(key, claim);
  return true;
}

let gateQueue: Promise<unknown> = Promise.resolve();
/** Serializes gate and submission claim updates within this process. */
export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = gateQueue.then(task, task);
  gateQueue = run.catch(() => undefined);
  return run;
}

/**
 * Atomically mark a claimed run as submitted, so retried or concurrent submissions
 * for one run deliver once. Returns the claim on success, or the reason it was refused.
 */
export function consumeClaim(kv: Kv, localDate: string, now: Date, matches: (claim: RunClaim) => boolean):
  Promise<{ ok: true; claim: RunClaim; version?: string } | { ok: false; reason: "missing" | "mismatch" | "submitted" | "conflict"; claim?: RunClaim }> {
  const key = `claim:${localDate}`;
  return serialized(async () => {
    const entry = supportsKvCas(kv) ? await kv.getWithVersion(key) : { value: await kv.get(key), version: "" };
    const claim = parseClaim(entry?.value);
    if (!entry || !claim?.window || !claim.timezone) return { ok: false as const, reason: "missing" as const };
    const full = claim as RunClaim;
    if (!matches(full)) return { ok: false as const, reason: "mismatch" as const, claim: full };
    if (full.submittedAt) return { ok: false as const, reason: "submitted" as const, claim: full };
    const consumed: RunClaim = { ...full, submittedAt: now.toISOString() };
    if (supportsKvCas(kv)) {
      const result = await kv.putIfVersion(key, consumed, entry.version);
      if (!result.ok) return { ok: false as const, reason: "conflict" as const, claim: full };
      return { ok: true as const, claim: consumed, version: result.version };
    }
    await kv.put(key, consumed);
    return { ok: true as const, claim: consumed };
  });
}

/**
 * Undo consumeClaim after a failed submission so the same run can retry.
 * Only restores the claim if it is still the one this submission consumed.
 */
export function releaseClaim(kv: Kv, localDate: string, consumed: { claim: RunClaim; version?: string }): Promise<boolean> {
  const key = `claim:${localDate}`;
  const { submittedAt: _submittedAt, ...restored } = consumed.claim;
  return serialized(async () => {
    if (supportsKvCas(kv) && consumed.version !== undefined) {
      return (await kv.putIfVersion(key, restored, consumed.version)).ok;
    }
    const current = parseClaim(await kv.get(key));
    if (current?.submittedAt !== consumed.claim.submittedAt || current?.claimedAt !== consumed.claim.claimedAt) return false;
    await kv.put(key, restored);
    return true;
  });
}

export function briefGate(input: { force?: boolean; now?: string }, ctx: Pick<ToolContext, "host">): Promise<GateResult> {
  return serialized(() => evaluateGate(input, ctx));
}

async function evaluateGate(input: { force?: boolean; now?: string }, ctx: Pick<ToolContext, "host">): Promise<GateResult> {
  const { timezone, localHour } = getBriefConfig();
  if (!timezone) return decision({ shouldRun: false, reason: "BRIEF_TIMEZONE not set or invalid" });
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isFinite(now.getTime())) return decision({ shouldRun: false, reason: "Invalid now timestamp", timezone });
  const localDate = localParts(now, timezone).date;
  const skip = (reason: string) => decision({ shouldRun: false, reason, localDate, timezone });
  if (!input.force && !shouldFire(now, timezone, localHour)) return skip("Outside local weekday scheduling window");
  const kv = ctx.host.kv;
  if (!input.force && await kv.get(`delivered:${localDate}`) != null) return skip("Already delivered");
  const lastSuccess = await kv.get("lastSuccessfulUntil");
  const window = computeWindow(now, typeof lastSuccess === "string" ? lastSuccess : null);
  const claimed = await tryClaim(kv, `claim:${localDate}`, { claimedAt: now.toISOString(), timezone, window }, now);
  if (!claimed) return skip("Already claimed (30 minute lease)");
  return decision({ shouldRun: true, reason: input.force ? "Forced run claimed" : "Scheduled run claimed", localDate, timezone, window });
}

export default defineTool({
  description: "Gate and claim a local weekday brief, with two hourly catch-up attempts. Force bypasses time and delivery checks, not an active claim or missing timezone.",
  effect: "write",
  inputSchema: z.object({ force: z.boolean().optional(), now: z.iso.datetime({ offset: true }).optional() }),
  dryRunResult: () => ({ shouldRun: false, reason: "Dry run: no claim written" }),
  execute: briefGate,
});
