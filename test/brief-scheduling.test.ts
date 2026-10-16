import { describe, expect, it, vi } from "vitest";
import type { ScheduleHandlerArgs } from "@cursor/bdk/schedules";
import brief from "../bot/channels/brief.js";
import schedule from "../bot/schedules/weekday-brief.js";

const gate = { shouldRun: true, reason: "claimed", localDate: "2026-06-08", timezone: "America/New_York", window: { since: "2026-06-05T13:00:00Z", until: "2026-06-08T13:00:00Z" } };
function setup(result: unknown = gate, isError = false) {
  return { callTool: vi.fn(async () => ({ result, isError, errorMessage: isError ? "gate failed" : undefined })), receive: vi.fn(async () => ({})), send: vi.fn(async () => ({})), waitUntil: vi.fn(), appAuth: { authenticator: "schedule", principalId: "weekday-brief", principalType: "app" } };
}
describe("weekday brief schedule", () => {
  it("is hourly UTC and hands a successful gate to the channel with app auth", async () => {
    const args = setup();
    expect(schedule.cron).toBe("0 * * * *");
    await schedule.run!(args as unknown as ScheduleHandlerArgs);
    expect(args.callTool).toHaveBeenCalledWith("brief_gate", {});
    expect(args.receive).toHaveBeenCalledWith(brief, { message: expect.stringContaining(gate.window.since), auth: args.appAuth });
    expect(args.waitUntil).toHaveBeenCalledOnce();
  });
  it("never starts a session when gated off or when the gate errors", async () => {
    const off = setup({ shouldRun: false, reason: "off" });
    await schedule.run!(off as unknown as ScheduleHandlerArgs);
    expect(off.receive).not.toHaveBeenCalled();
    expect(off.waitUntil).not.toHaveBeenCalled();
    const error = setup(null, true);
    await expect(schedule.run!(error as unknown as ScheduleHandlerArgs)).rejects.toThrow("gate failed");
    expect(error.receive).not.toHaveBeenCalled();
  });
});
describe("manual brief route", () => {
  const route = brief.routes![0];
  type Args = Parameters<typeof route.handler>[1];
  it.each([undefined, false, true])("defaults force to true, preserves explicit %s, returns 202", async force => {
    const args = { ...setup(), body: force === undefined ? {} : { force } };
    expect(route.path).toBe("/run");
    expect(route.method).toBe("POST");
    const response = await route.handler(new Request("http://localhost/run"), args as unknown as Args);
    expect(response.status).toBe(202);
    expect(args.callTool).toHaveBeenCalledWith("brief_gate", { force: force ?? true });
    expect(args.send).toHaveBeenCalledWith(expect.stringContaining(gate.localDate), { continuationToken: "brief:2026-06-08", title: "Legal cyber brief 2026-06-08" });
    expect(args.waitUntil).toHaveBeenCalledOnce();
  });
  it("acknowledges a gated-off manual run without sending", async () => {
    const args = { ...setup({ shouldRun: false, reason: "claimed" }), body: {} };
    expect((await route.handler(new Request("http://localhost/run"), args as unknown as Args)).status).toBe(202);
    expect(args.send).not.toHaveBeenCalled();
    expect(args.waitUntil).not.toHaveBeenCalled();
  });
  it("does not send after a tool failure", async () => {
    const args = { ...setup(null, true), body: {} };
    await expect(route.handler(new Request("http://localhost/run"), args as unknown as Args)).rejects.toThrow("gate failed");
    expect(args.send).not.toHaveBeenCalled();
  });
});
