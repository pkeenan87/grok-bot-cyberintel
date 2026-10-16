import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@cursor/bdk/tools";
import tool, { briefGate } from "../bot/tools/brief_gate.js";

function setup() {
  const values = new Map<string, string>();
  const kv = { get: vi.fn(async (key: string) => values.get(key)), put: vi.fn(async (key: string, value: string) => { values.set(key, value); }) };
  return { values, kv, ctx: { host: { kv } } as unknown as ToolContext };
}
beforeEach(() => {
  vi.stubEnv("BRIEF_TIMEZONE", "America/New_York");
  vi.stubEnv("BRIEF_LOCAL_HOUR", "9");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("brief gate", () => {
  it("claims a weekday once, logging both decisions", async () => {
    const { ctx, values } = setup();
    const first = await briefGate({ now: "2026-06-08T13:15:00Z" }, ctx);
    expect(first).toMatchObject({ shouldRun: true, localDate: "2026-06-08", timezone: "America/New_York", window: { since: "2026-06-05T13:15:00.000Z", until: "2026-06-08T13:15:00.000Z" } });
    expect(values.get("claim:2026-06-08")).toBe("2026-06-08T13:15:00.000Z");
    expect(await briefGate({ now: "2026-06-08T13:15:01Z" }, ctx)).toMatchObject({ shouldRun: false, reason: expect.stringContaining("claimed") });
    expect(console.info).toHaveBeenCalledTimes(2);
  });
  it("expires claims after 30 minutes so failed runs retry at 10 and 11, not 12", async () => {
    const { ctx } = setup();
    for (const hour of [13, 14, 15]) expect(await briefGate({ now: `2026-06-08T${hour}:00:00Z` }, ctx)).toMatchObject({ shouldRun: true });
    expect(await briefGate({ now: "2026-06-08T16:00:00Z" }, ctx)).toMatchObject({ shouldRun: false });
  });
  it("honors the exact lease boundary and last successful coverage", async () => {
    const { ctx, values } = setup();
    values.set("claim:2026-06-08", "2026-06-08T13:00:00Z");
    values.set("lastSuccessfulUntil", "2026-06-06T13:00:00Z");
    expect(await briefGate({ now: "2026-06-08T13:29:59Z" }, ctx)).toMatchObject({ shouldRun: false });
    expect(await briefGate({ now: "2026-06-08T13:30:00Z" }, ctx)).toMatchObject({ shouldRun: true, window: { since: "2026-06-06T13:00:00.000Z" } });
  });
  it("does not claim Saturdays or already delivered dates", async () => {
    const { ctx, kv, values } = setup();
    expect(await briefGate({ now: "2026-06-13T13:00:00Z" }, ctx)).toMatchObject({ shouldRun: false });
    values.set("delivered:2026-06-08", "2026-06-08T13:00:00Z");
    expect(await briefGate({ now: "2026-06-08T14:00:00Z" }, ctx)).toMatchObject({ shouldRun: false, reason: "Already delivered" });
    expect(kv.put).not.toHaveBeenCalled();
  });
  it.each(["", "not-a-timezone"])("fails closed with timezone %s, even forced", async (tz) => {
    vi.stubEnv("BRIEF_TIMEZONE", tz);
    const { ctx, kv } = setup();
    expect(await briefGate({ force: true }, ctx)).toEqual({ shouldRun: false, reason: "BRIEF_TIMEZONE not set or invalid" });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
  it("force bypasses weekday/time and delivery, but not an active claim", async () => {
    const { ctx, values } = setup();
    values.set("delivered:2026-06-13", "2026-06-13T13:00:00Z");
    expect(await briefGate({ force: true, now: "2026-06-13T20:00:00Z" }, ctx)).toMatchObject({ shouldRun: true });
    expect(await briefGate({ force: true, now: "2026-06-13T20:01:00Z" }, ctx)).toMatchObject({ shouldRun: false });
  });
  it("is a write tool and dry runs never claim", () => {
    expect(tool.effect).toBe("write");
    expect(typeof tool.dryRunResult).toBe("function");
  });
});
