import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefSchema, validateBrief, renderBriefMarkdown, registrableDomain, type BriefInput } from "../bot/lib/brief.js";
import { getBriefConfig } from "../bot/lib/config.js";
import { postBrief } from "../bot/lib/webhook.js";
import { buildBriefPrompt } from "../bot/lib/prompt.js";
import tool, { submitBrief, dryRunBrief } from "../bot/tools/submit_brief.js";
import type { ToolContext } from "@cursor/bdk/tools";

const fixture = (): BriefInput => JSON.parse(readFileSync(new URL("./fixtures/brief.json", import.meta.url), "utf8"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("brief policy", () => {
  it("downgrades a single-source confirmed incident without mutating input", () => {
    const input = fixture();
    const { brief, warnings } = validateBrief(input);
    expect(brief.incidents[0].status).toBe("reported");
    expect(warnings).toHaveLength(1);
    expect(input.incidents[0].status).toBe("confirmed");
  });
  it.each([
    ["https://news.example.com/a", "https://blog.example.com/b"],
    ["https://www.example.co.uk/a", "https://legal.example.co.uk/b"],
  ])("treats subdomains of one publisher domain (%s, %s) as a single source domain", (a, b) => {
    const input = fixture();
    input.incidents[0].sources = [{ url: a, publisher: "A" }, { url: b, publisher: "B" }];
    const { brief, warnings } = validateBrief(input);
    expect(brief.incidents[0].status).toBe("reported");
    expect(warnings[0]).toMatch(/distinct domains/);
  });
  it.each([
    "https://evil.example/x>\n## Injected heading",
    "https://evil.example/x\n# h",
    "https://evil.example/a b<c>",
  ])("renders hostile source URL %j only in canonical, inert form", (url) => {
    const input = fixture();
    input.incidents[0].sources = [{ url, publisher: "Evil" }];
    const markdown = renderBriefMarkdown(validateBrief(input).brief);
    const line = markdown.split("\n").find(l => l.startsWith("[1] "))!;
    expect(line).toBe(`[1] Evil — <${new URL(url).href}>`);
    expect(line.match(/[<>]/g)).toEqual(["<", ">"]);
    expect(markdown).not.toMatch(/^#+ (Injected|h)\b/m);
    expect(markdown.split("\n").filter(l => l.startsWith("#"))).toEqual([expect.stringMatching(/^# Legal cyber brief/), "## Sources"]);
  });
  it("normalizes registrable domains", () => {
    expect(registrableDomain("https://WWW.News.Example.com./x")).toBe("example.com");
    expect(registrableDomain("https://a.b.example.com.au/x")).toBe("example.com.au");
    expect(registrableDomain("https://example.com/x")).toBe("example.com");
    expect(registrableDomain("https://security.example.io/x")).toBe("example.io");
  });
  it("strips www and treats same-host URLs as only one host", () => {
    const input = fixture();
    input.incidents[0].sources.push({ url: "https://www.example.com/other", publisher: "Other" });
    expect(validateBrief(input).brief.incidents[0].status).toBe("reported");
  });
  it("deduplicates URLs and accepts two distinct hosts", () => {
    const input = fixture();
    input.incidents[0].sources.push(input.incidents[0].sources[0], { url: "https://independent.example/report", publisher: "Independent" });
    const { brief, warnings } = validateBrief(input);
    expect(brief.incidents[0].sources).toHaveLength(2);
    expect(brief.incidents[0].status).toBe("confirmed");
    expect(warnings).toEqual([]);
  });
  it.each(["reported", "unconfirmed"] as const)("preserves %s status", (status) => {
    const input = fixture(); input.incidents[0].status = status;
    expect(validateBrief(input).warnings).toEqual([]);
  });
  it("requires an explanatory note for zero incidents", () => {
    const input = fixture(); input.incidents = [];
    expect(() => validateBrief(input)).toThrow(/noIncidentsNote/);
    input.noIncidentsNote = "   ";
    expect(() => validateBrief(input)).toThrow();
    input.noIncidentsNote = "No qualifying reports found; feed coverage was limited.";
    expect(renderBriefMarkdown(validateBrief(input).brief)).toContain(input.noIncidentsNote);
  });
  it("enforces all specified array and text limits at their boundaries", () => {
    const input = fixture();
    input.headline = "h".repeat(280);
    input.incidents[0].summary = "s".repeat(600);
    input.incidents[0].whyItMatters = "w".repeat(300);
    input.incidents[0].sources = Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}`, publisher: "Example" }));
    input.incidents = Array.from({ length: 8 }, () => structuredClone(input.incidents[0]));
    input.watchlist = Array(5).fill("Watching public reports");
    expect(BriefSchema.safeParse(input).success).toBe(true);
    for (const field of ["headline", "summary", "whyItMatters", "incidents", "sources", "watchlist"] as const) {
      const invalid = structuredClone(input);
      if (field === "headline") invalid.headline += "x";
      else if (field === "summary" || field === "whyItMatters") invalid.incidents[0][field] += "x";
      else if (field === "incidents") invalid.incidents.push(invalid.incidents[0]);
      else if (field === "sources") invalid.incidents[0].sources.push(invalid.incidents[0].sources[0]);
      else invalid.watchlist!.push("extra");
      expect(BriefSchema.safeParse(invalid).success, field).toBe(false);
    }
  });
  it("requires at least one HTTPS source and valid dates, timezone, and window", () => {
    const input = fixture();
    input.incidents[0].sources = [];
    expect(BriefSchema.safeParse(input).success).toBe(false);
    for (const url of ["http://example.com", "ftp://example.com", "not a URL"]) {
      input.incidents[0].sources = [{ url, publisher: "Example" }];
      expect(BriefSchema.safeParse(input).success).toBe(false);
    }
    expect(BriefSchema.safeParse({ ...fixture(), localDate: "not a date" }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...fixture(), timezone: "Invalid/Zone" }).success).toBe(false);
    expect(BriefSchema.safeParse({ ...fixture(), window: { since: "2026-06-09T00:00:00Z", until: "2026-06-08T00:00:00Z" } }).success).toBe(false);
  });
  it("renders stable global citation numbering and deduplicated Sources", () => {
    const input = fixture();
    const second = structuredClone(input.incidents[0]);
    second.sources.push({ url: "https://independent.example/report", publisher: "Independent" });
    input.incidents.push(second);
    const markdown = renderBriefMarkdown(validateBrief(input).brief);
    expect(markdown).toContain("2026-06-08 (America/New_York)");
    expect(markdown).toContain("1. **Example law firm reports disruption** — **reported** [1]");
    expect(markdown).toContain("2. **Example law firm reports disruption** — **confirmed** [1] [2]");
    expect(markdown).toContain("## Sources\n[1] Example publisher — <https://example.com/report>\n[2] Independent — <https://independent.example/report>");
    expect(markdown.match(/https:\/\/example.com\/report/g)).toHaveLength(1);
  });
});

const claimFor = (input: BriefInput) => ({ claimedAt: input.window.until, timezone: input.timezone, window: { since: new Date(input.window.since).toISOString(), until: new Date(input.window.until).toISOString() } });
function context(purpose = "interactive", claim: unknown = claimFor(fixture())) {
  const store = new Map<string, unknown>([[`claim:${fixture().localDate}`, claim]]);
  const tag = vi.fn().mockResolvedValue({});
  const put = vi.fn(async (key: string, value: unknown) => { if (key.startsWith("claim:")) store.set(key, value); });
  const get = vi.fn(async (key: string) => store.get(key));
  const ctx = { artifacts: { tag }, host: { kv: { put, get } }, session: { purpose } } as unknown as ToolContext;
  return { ctx, tag, put, get };
}

describe("submission and delivery", () => {
  it("stores validated data and markdown, records success, and makes no network call without a configured URL", async () => {
    vi.stubEnv("BRIEF_WEBHOOK_URL", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { ctx, tag, put } = context();
    const result = await submitBrief(fixture(), ctx);
    expect(result).toMatchObject({ stored: true, artifactKey: "brief:2026-06-08", webhook: { posted: false } });
    expect(result.warnings).toHaveLength(1);
    expect(tag).toHaveBeenCalledWith(expect.objectContaining({ kind: "legal-cyber-brief", key: result.artifactKey, contents: result.markdown, contentType: "text/markdown" }));
    expect(tag.mock.calls[0][0].data.incidents[0].status).toBe("reported");
    const deliveryPuts = put.mock.calls.filter(([key]) => !key.startsWith("claim:"));
    expect(deliveryPuts).toEqual([["lastSuccessfulUntil", fixture().window.until], ["delivered:2026-06-08", fixture().window.until]]);
    expect(put).toHaveBeenCalledWith("claim:2026-06-08", expect.objectContaining({ submittedAt: expect.any(String) }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("tags eval artifacts but skips kv and webhook effects", async () => {
    vi.stubEnv("BRIEF_WEBHOOK_URL", "https://example.com/hook");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { ctx, tag, put } = context("eval");
    expect((await submitBrief(fixture(), ctx)).webhook.posted).toBe(false);
    expect(tag).toHaveBeenCalledOnce(); expect(put).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("uses only the configured webhook URL, with a 10 second timeout", async () => {
    vi.stubEnv("BRIEF_WEBHOOK_URL", "https://example.com/configured");
    vi.stubEnv("BRIEF_WEBHOOK_FORMAT", "json");
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }); vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const input = { ...fixture(), webhookUrl: "https://untrusted.example/hook" };
    const result = await submitBrief(input, context().ctx);
    expect(result.webhook).toEqual({ posted: true, status: 200 });
    expect(fetch.mock.calls[0][0]).toBe("https://example.com/configured");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ markdown: result.markdown, brief: { localDate: input.localDate } });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
  it("delivers once when submit_brief is retried or called concurrently in one run", async () => {
    vi.stubEnv("BRIEF_WEBHOOK_URL", "https://example.com/hook");
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }); vi.stubGlobal("fetch", fetch);
    const { ctx, put } = context();
    const results = await Promise.allSettled([submitBrief(fixture(), ctx), submitBrief(fixture(), ctx)]);
    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(submitBrief(fixture(), ctx)).rejects.toThrow(/already submitted/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(put.mock.calls.filter(([key]) => key === "delivered:2026-06-08")).toHaveLength(1);
  });
  it.each(["artifact", "delivered"] as const)("releases the claim when %s storage fails, so a retry delivers once", async (failing) => {
    vi.stubEnv("BRIEF_WEBHOOK_URL", "https://example.com/hook");
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }); vi.stubGlobal("fetch", fetch);
    const { ctx, tag, put, get } = context();
    if (failing === "artifact") tag.mockRejectedValueOnce(new Error("artifact store down"));
    else {
      const original = put.getMockImplementation()!;
      put.mockImplementation(async (key, value) => { if (key.startsWith("delivered:") && !put.mock.calls.slice(0, -1).some(([k]) => k === key)) throw new Error("kv down"); return original(key, value); });
    }
    await expect(submitBrief(fixture(), ctx)).rejects.toThrow(/down/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await get("claim:2026-06-08")).not.toHaveProperty("submittedAt");
    const retry = await submitBrief(fixture(), ctx);
    expect(retry.stored).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await get("claim:2026-06-08")).toHaveProperty("submittedAt");
    await expect(submitBrief(fixture(), ctx)).rejects.toThrow(/already submitted/);
  });
  it("releases a CAS-consumed claim only at the version it wrote", async () => {
    const entry = { value: claimFor(fixture()), version: "1" };
    const putIfVersion = vi.fn().mockResolvedValueOnce({ ok: true, version: "2" }).mockResolvedValueOnce({ ok: true, version: "3" });
    const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), listKeys: vi.fn(), putIfAbsent: vi.fn(),
      getWithVersion: vi.fn(async () => entry), putIfVersion };
    const ctx = { artifacts: { tag: vi.fn().mockRejectedValue(new Error("artifact store down")) }, host: { kv }, session: { purpose: "interactive" } } as unknown as ToolContext;
    await expect(submitBrief(fixture(), ctx)).rejects.toThrow(/down/);
    expect(putIfVersion).toHaveBeenLastCalledWith("claim:2026-06-08", claimFor(fixture()), "2");
  });
  it("warns but still surfaces the original error when the claim cannot be released", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, tag, get, put } = context();
    tag.mockRejectedValueOnce(new Error("artifact store down"));
    get.mockImplementation(async () => claimFor(fixture())); // claim changed underneath: not ours to release
    await expect(submitBrief(fixture(), ctx)).rejects.toThrow("artifact store down");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not release/));
    expect(put.mock.calls.filter(([key]) => !key.startsWith("claim:"))).toEqual([]);
  });
  it("consumes the claim with compare-and-set when supported, and refuses on a lost race", async () => {
    const { submitBrief: submit } = await import("../bot/tools/submit_brief.js");
    const entry = { value: claimFor(fixture()), version: "1" };
    const putIfVersion = vi.fn().mockResolvedValueOnce({ ok: false, current: entry });
    const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn(), listKeys: vi.fn(), putIfAbsent: vi.fn(),
      getWithVersion: vi.fn(async () => entry), putIfVersion };
    const ctx = { artifacts: { tag: vi.fn() }, host: { kv }, session: { purpose: "interactive" } } as unknown as ToolContext;
    await expect(submit(fixture(), ctx)).rejects.toThrow(/already submitted/);
    expect(putIfVersion).toHaveBeenCalledWith("claim:2026-06-08", expect.objectContaining({ submittedAt: expect.any(String) }), "1");
    expect(kv.put).not.toHaveBeenCalled();
  });
  it("skips delivery state and webhook when no run was claimed for the date", async () => {
    vi.stubEnv("BRIEF_WEBHOOK_URL", "https://example.com/hook");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { ctx, tag, put } = context("interactive", null);
    const result = await submitBrief(fixture(), ctx);
    expect(result.stored).toBe(true);
    expect(result.warnings.at(-1)).toMatch(/No claimed run/);
    expect(tag).toHaveBeenCalledOnce(); expect(put).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["future until", { window: { since: "2026-06-05T13:00:00Z", until: "2030-01-01T00:00:00Z" } }],
    ["shifted since", { window: { since: "2026-06-01T13:00:00Z", until: "2026-06-08T13:00:00Z" } }],
    ["different timezone", { timezone: "Europe/London" }],
  ])("rejects a submission whose %s differs from the claimed run, writing nothing", async (_label, change) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { ctx, tag, put } = context();
    await expect(submitBrief({ ...fixture(), ...change }, ctx)).rejects.toThrow(/claimed run/);
    expect(tag).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not record delivery for a wrong localDate (that date has no claim)", async () => {
    const { ctx, put } = context();
    const result = await submitBrief({ ...fixture(), localDate: "2026-06-09" }, ctx);
    expect(result.warnings.at(-1)).toMatch(/No claimed run for 2026-06-09/);
    expect(put).not.toHaveBeenCalled();
  });
  it("accepts legacy string claims only as unbound (no delivery)", async () => {
    const { ctx, put } = context("interactive", "2026-06-08T13:00:00Z");
    await submitBrief(fixture(), ctx);
    expect(put).not.toHaveBeenCalled();
  });
  it.each(["http://example.com/hook", "not a url"])("refuses to POST to non-HTTPS webhook %s", async (url) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await postBrief(url, "slack", "markdown", fixture());
    expect(result.posted).toBe(false);
    expect(result.error).toMatch(/redacted/); expect(result.error).not.toContain("example.com");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("provides a non-writing dry run that still applies citation policy", () => {
    expect(tool.effect).toBe("write");
    expect(tool.dryRunResult).toBe(dryRunBrief);
    const result = dryRunBrief(fixture());
    expect(result.stored).toBe(false); expect(result.markdown).toContain("**reported** [1]"); expect(result.warnings).toHaveLength(1);
  });
  it("does not store or deliver invalid input", async () => {
    const { ctx, tag, put } = context();
    await expect(submitBrief({ ...fixture(), incidents: [] }, ctx)).rejects.toThrow();
    expect(tag).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
  it("sends Slack text and handles HTTP failures and exceptions without exposing the URL", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }); vi.stubGlobal("fetch", fetch);
    const url = "https://example.com/private-token";
    const result = await postBrief(url, "slack", "markdown", fixture());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ text: "markdown" });
    expect(result).toMatchObject({ posted: false, status: 503 });
    fetch.mockRejectedValue(new Error(`Failure at ${url}`));
    const failure = await postBrief(url, "json", "markdown", fixture());
    expect(failure.posted).toBe(false); expect(failure.error).not.toContain("private-token");
    expect(failure.error).toContain("redacted");
  });
  it("returns stored success even when webhook delivery fails", async () => {
    vi.stubEnv("BRIEF_WEBHOOK_URL", "https://example.com/hook");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await submitBrief(fixture(), context().ctx);
    expect(result.stored).toBe(true); expect(result.webhook.posted).toBe(false);
  });
});

it("reads configuration at call time with safe defaults and validates timezones", () => {
  expect(getBriefConfig({})).toEqual({ timezone: null, localHour: 9, webhookUrl: null, webhookFormat: "slack" });
  expect(getBriefConfig({ BRIEF_TIMEZONE: "Invalid/Zone", BRIEF_LOCAL_HOUR: "99" }).timezone).toBeNull();
  expect(getBriefConfig({ BRIEF_TIMEZONE: "UTC", BRIEF_LOCAL_HOUR: "10", BRIEF_WEBHOOK_FORMAT: "json" })).toMatchObject({ timezone: "UTC", localHour: 10, webhookFormat: "json" });
  for (const blank of ["", "   "]) expect(getBriefConfig({ BRIEF_LOCAL_HOUR: blank }).localHour).toBe(9);
  expect(getBriefConfig({ BRIEF_LOCAL_HOUR: " 0 " }).localHour).toBe(0);
  expect(getBriefConfig({ BRIEF_LOCAL_HOUR: "8.5" }).localHour).toBe(9);
  expect(buildBriefPrompt(fixture())).toContain(fixture().window.since);
});
