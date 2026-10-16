import { describe, expect, it } from "vitest";
import { computeWindow, isLocalWeekday, localParts, shouldFire } from "../bot/lib/time.js";

const date = (iso: string) => new Date(iso);
describe("local schedule", () => {
  it.each([
    ["2026-03-06T14:00:00Z", "America/New_York", "2026-03-06"],
    ["2026-03-09T13:00:00Z", "America/New_York", "2026-03-09"],
    ["2026-10-30T13:00:00Z", "America/New_York", "2026-10-30"],
    ["2026-11-02T14:00:00Z", "America/New_York", "2026-11-02"],
    ["2026-06-07T23:00:00Z", "Australia/Sydney", "2026-06-08"],
    ["2026-06-08T03:30:00Z", "Asia/Kolkata", "2026-06-08"],
  ])("fires at local 09 across DST and UTC dates: %s %s", (iso, tz, localDate) => {
    expect(localParts(date(iso), tz)).toMatchObject({ date: localDate, hour: 9 });
    expect(isLocalWeekday(date(iso), tz)).toBe(true);
    expect(shouldFire(date(iso), tz, 9)).toBe(true);
  });
  it.each([["2026-06-13T13:00:00Z", false], ["2026-06-08T12:59:00Z", false], ["2026-06-08T13:59:00Z", true], ["2026-06-08T14:00:00Z", true], ["2026-06-08T15:59:00Z", true], ["2026-06-08T16:00:00Z", false]])("gates weekday and catch-up hours: %s", (iso, expected) => {
    expect(shouldFire(date(iso), "America/New_York", 9)).toBe(expected);
  });
  it("uses h23 at midnight and supports a custom catch-up range", () => {
    expect(localParts(date("2026-06-08T04:00:00Z"), "America/New_York").hour).toBe(0);
    expect(shouldFire(date("2026-06-08T14:00:00Z"), "America/New_York", 9, 0)).toBe(false);
  });
});
describe("coverage window", () => {
  const now = date("2026-06-08T13:00:00Z");
  it("falls back 72h without usable history", () => {
    for (const last of [null, "invalid"]) expect(computeWindow(now, last)).toEqual({ since: "2026-06-05T13:00:00.000Z", until: now.toISOString() });
  });
  it("starts at last success and clamps history to 96h", () => {
    expect(computeWindow(now, "2026-06-06T13:00:00Z").since).toBe("2026-06-06T13:00:00.000Z");
    expect(computeWindow(now, "2026-06-01T13:00:00Z").since).toBe("2026-06-04T13:00:00.000Z");
    expect(computeWindow(now, "2026-06-09T13:00:00Z").since).toBe(now.toISOString());
  });
});
