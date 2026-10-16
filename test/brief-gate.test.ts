import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@cursor/bdk/tools";
import tool, { briefGate } from "../bot/tools/brief_gate.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 1));
function setup() {
  const values = new Map<string, unknown>();
  // Yield between read and write so unsynchronized check-then-put would race.
  const kv = {
    get: vi.fn(async (key: string) => { await tick(); return values.get(key); }),
    put: vi.fn(async (key: string, value: unknown) => { await tick(); values.set(key, value); }),
  };
  return { values, kv, ctx: { host: { kv } } as unknown as ToolContext };
}
function casSetup() {
  const values = new Map<string, { value: unknown; version: string }>();
  let version = 0;
  const kv = {
    get: vi.fn(async (key: string) => values.get(key)?.value),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, { value, version: String(++version) }); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
    list: vi.fn(async () => []),
    listKeys: vi.fn(async () => [...values.keys()]),
    getWithVersion: vi.fn(async (key: string) => { await tick(); return values.get(key); }),
    putIfAbsent: vi.fn(async (key: string, value: unknown) => {
      const current = values.get(key);
      if (current) return { ok: false, current };
      values.set(key, { value, version: String(++version) }); return { ok: true, version: String(version) };
    }),
    putIfVersion: vi.fn(async (key: string, value: unknown, expected: string) => {
      const current = values.get(key);
      if (current?.version !== expected) return { ok: false, current };
      values.set(key, { value, version: String(++version) }); return { ok: true, version: String(version) };
    }),
  };
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
    expect(values.get("claim:2026-06-08")).toEqual({ claimedAt: "2026-06-08T13:15:00.000Z", timezone: "America/New_York", window: first.shouldRun ? first.window : null });
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
  it("claims only once under concurrent schedule and manual calls", async () => {
    const { ctx } = setup();
    const results = await Promise.all([
      briefGate({ now: "2026-06-08T13:00:00Z" }, ctx),
      briefGate({ force: true, now: "2026-06-08T13:00:00Z" }, ctx),
      briefGate({ now: "2026-06-08T13:00:01Z" }, ctx),
    ]);
    expect(results.filter(r => r.shouldRun)).toHaveLength(1);
  });
  it("uses compare-and-set claims when the store supports them", async () => {
    const { ctx, kv, values } = casSetup();
    const results = await Promise.all([
      briefGate({ now: "2026-06-08T13:00:00Z" }, ctx),
      briefGate({ force: true, now: "2026-06-08T13:00:00Z" }, ctx),
    ]);
    expect(results.filter(r => r.shouldRun)).toHaveLength(1);
    expect(kv.putIfAbsent).toHaveBeenCalledOnce();
    expect(kv.put).not.toHaveBeenCalled();
    // An expired lease is replaced only at its observed version.
    expect(await briefGate({ now: "2026-06-08T13:30:00Z" }, ctx)).toMatchObject({ shouldRun: true });
    expect(kv.putIfVersion).toHaveBeenCalledOnce();
    expect((values.get("claim:2026-06-08")!.value as { claimedAt: string }).claimedAt).toBe("2026-06-08T13:30:00.000Z");
  });
  it("loses the claim when another runtime wins the CAS race", async () => {
    const { ctx, kv } = casSetup();
    kv.putIfAbsent.mockResolvedValueOnce({ ok: false, current: undefined } as never);
    expect(await briefGate({ now: "2026-06-08T13:00:00Z" }, ctx)).toMatchObject({ shouldRun: false, reason: expect.stringContaining("claimed") });
  });
  it("is a write tool and dry runs never claim", () => {
    expect(tool.effect).toBe("write");
    expect(typeof tool.dryRunResult).toBe("function");
  });
});
