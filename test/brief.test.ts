import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefSchema, validateBrief, renderBriefMarkdown, type BriefInput } from "../bot/lib/brief.js";
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

function context(purpose = "interactive") {
  const tag = vi.fn().mockResolvedValue({});
  const put = vi.fn().mockResolvedValue(undefined);
  const ctx = { artifacts: { tag }, host: { kv: { put } }, session: { purpose } } as unknown as ToolContext;
  return { ctx, tag, put };
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
    expect(put.mock.calls).toEqual([["lastSuccessfulUntil", fixture().window.until], ["delivered:2026-06-08", fixture().window.until]]);
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
  expect(buildBriefPrompt(fixture())).toContain(fixture().window.since);
});
