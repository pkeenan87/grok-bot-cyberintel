import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import agent from "../bot/agent.js";
import { FEEDS, FEED_HOSTS, parseFeed, type FeedConfig, type FeedItem } from "../bot/lib/feeds.js";
import { scoreItem } from "../bot/lib/relevance.js";
import tool, { fetchFeeds, windowSchema } from "../bot/tools/fetch_feeds.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), "utf8");
const feed: FeedConfig = { id: "test", name: "Test Source", url: "https://example.com/feed", kind: "security" };
const window = { since: "2026-10-13T12:00:00.000Z", until: "2026-10-16T12:00:00.000Z" };
const item = (title: string, summary = ""): FeedItem => ({ feedId: "test", source: "Test", title, summary, url: "https://example.com", publishedAt: null });

describe("parseFeed", () => {
  it("normalizes RSS, decodes XML entities, strips tags and rejects unsafe/missing links", () => {
    const items = parseFeed(fixture("rss"), feed);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ feedId: "test", source: "Test Source", title: "Example LLP discloses ransomware & data theft", url: "https://example.com/incident", publishedAt: "2026-10-14T10:00:00.000Z", summary: "A law firm reports ransomware ." });
    expect(items[1].publishedAt).toBeNull();
    expect(items[1].summary).toBe("Service interruption");
  });
  it("normalizes Atom alternate links, published/updated and relative URLs", () => {
    const items = parseFeed(fixture("atom"), feed);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Court & tribunal cyberattack", url: "https://example.com/court", publishedAt: "2026-10-15T10:00:00.000Z", summary: "Court systems offline after a breach." });
    expect(items[1]).toMatchObject({ url: "https://example.com/vendor", publishedAt: "2026-10-14T09:00:00.000Z" });
  });
  it("handles singleton entries, empty feeds and summaries capped at 400", () => {
    expect(parseFeed("<rss><channel/></rss>", feed)).toEqual([]);
    expect(parseFeed("<feed/>", feed)).toEqual([]);
    const xml = `<rss><channel><item><title>Law firm breach</title><link>https://example.com/a</link><description>${"x".repeat(500)}</description></item></channel></rss>`;
    expect(parseFeed(xml, feed)[0].summary).toHaveLength(400);
  });
  it("rejects malformed XML and non-feed responses", () => {
    expect(() => parseFeed("<rss>", feed)).toThrow("Invalid feed XML");
    expect(() => parseFeed("<html>blocked</html>", feed)).toThrow("Expected RSS");
  });
});

describe("scoreItem", () => {
  it.each(["security", "government"] as const)("requires legal terms for %s feeds", (kind) => {
    expect(scoreItem(item("Hospital ransomware"), kind).relevant).toBe(false);
    expect(scoreItem(item("EXAMPLE LLP reports breach"), kind)).toEqual({ relevant: true, matched: ["llp"] });
    expect(scoreItem(item("Notice", "A court reports downtime"), kind).relevant).toBe(true);
    expect(scoreItem(item("Courteous hackers"), kind).relevant).toBe(false);
  });
  it("requires cyber terms in legal feeds with word boundaries", () => {
    expect(scoreItem(item("Law firm merger"), "legal").relevant).toBe(false);
    expect(scoreItem(item("Breach notification"), "legal").relevant).toBe(true);
    expect(scoreItem(item("New hire", "Business email compromise"), "legal").relevant).toBe(true);
    expect(scoreItem(item("Hackney office opening"), "legal").relevant).toBe(false);
  });
});

function rss(entries: { title: string; url: string; date?: string }[]) {
  return `<rss><channel>${entries.map((e) => `<item><title>${e.title}</title><link>${e.url}</link>${e.date ? `<pubDate>${e.date}</pubDate>` : ""}</item>`).join("")}</channel></rss>`;
}
afterEach(() => vi.unstubAllGlobals());

describe("fetch_feeds", () => {
  it("returns a 72h window, relevant dated items, newest first and URL dedupe despite a failed feed", async () => {
    const xml = rss([
      { title: "Court breach", url: "https://example.com/new#fragment", date: window.until },
      { title: "Law firm ransomware", url: "https://example.com/old", date: window.since },
      { title: "Law firm ransomware", url: "https://example.com/outside", date: "2026-10-12T00:00:00Z" },
      { title: "Law firm ransomware", url: "https://example.com/future", date: "2026-10-17T00:00:00Z" },
      { title: "Law firm ransomware", url: "https://example.com/undated" },
      { title: "Hospital news", url: "https://example.com/unrelated", date: window.until },
    ]);
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers).toHaveProperty("user-agent");
      if (url === FEEDS[0].url) throw new Error("Network unavailable");
      return new Response(xml);
    });
    vi.stubGlobal("fetch", fetch);
    const result = await fetchFeeds(window);
    expect(result.window).toEqual(window);
    expect(result.items.map((item) => item.url)).toEqual(["https://example.com/new", "https://example.com/old"]);
    expect(result.feedErrors).toEqual([{ feedId: FEEDS[0].id, error: "Network unavailable" }]);
    expect(fetch).toHaveBeenCalledTimes(FEEDS.length);
  });
  it("collects HTTP, timeout and invalid XML failures without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === FEEDS[0].url) return new Response("unavailable", { status: 503 });
      if (url === FEEDS[1].url) throw new DOMException("Timed out", "TimeoutError");
      return new Response("<html>not XML feed</html>");
    }));
    const result = await fetchFeeds(window);
    expect(result.items).toEqual([]);
    expect(result.feedErrors).toHaveLength(FEEDS.length);
    expect(result.window).toEqual(window);
  });
  it("caps output at 40 newest items", async () => {
    const xml = rss(Array.from({ length: 45 }, (_, i) => ({ title: "Law firm breach", url: `https://example.com/${i}`, date: new Date(Date.parse(window.since) + i * 60_000).toISOString() })));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(xml)));
    const result = await fetchFeeds(window);
    expect(result.items).toHaveLength(40);
    expect(result.items[0].url).toBe("https://example.com/44");
    expect(result.items[39].url).toBe("https://example.com/5");
  });
  it("validates absolute dates and rejects reversed windows", () => {
    expect(windowSchema.safeParse({ ...window, since: "yesterday" }).success).toBe(false);
    expect(windowSchema.safeParse({ since: window.until, until: window.since }).success).toBe(false);
    expect(windowSchema.safeParse(window).success).toBe(true);
    expect(tool.effect).toBe("read");
    expect(tool.timeArgs).toEqual(["since", "until"]);
  });
});

describe("project constraints", () => {
  it("validates/discovers the BDK project and calls the tool through the CLI despite a failed feed", () => {
    const cli = "node_modules/@cursor/bdk/dist/bin/agent-serve.js";
    const run = (args: string[], imports: string[] = []) => execFileSync(process.execPath, [...imports, cli, ...args], { encoding: "utf8", timeout: 20_000 });
    expect(run(["validate", "--dir", "."])).toContain("has no diagnostics");
    const info = JSON.parse(run(["info", "--dir", ".", "--json"]));
    expect(info.agents[0].model.id).toBe("grok-4.5");
    expect(info.agents[0].tools.map((tool: { name: string }) => tool.name)).toContain("fetch_feeds");
    const dir = mkdtempSync(join(tmpdir(), "legal-cyber-cli-"));
    try {
      const preload = join(dir, "mock-fetch.mjs");
      writeFileSync(preload, `
        import { readFileSync } from "node:fs";
        const xml = readFileSync("test/fixtures/rss.xml", "utf8");
        const originalFetch = globalThis.fetch;
        const feedUrls = ${JSON.stringify(FEEDS.map((feed) => feed.url))};
        globalThis.fetch = async (url, options) => {
          if (!feedUrls.includes(url)) return originalFetch(url, options);
          if (url === ${JSON.stringify(FEEDS[0].url)}) throw new Error("Simulated unavailable feed");
          return new Response(xml, { headers: { "content-type": "application/rss+xml" } });
        };
      `);
      const result = JSON.parse(run(["call", "fetch_feeds", "--dir", ".", "--input", JSON.stringify(window)], ["--import", pathToFileURL(preload).href]));
      expect(result.ok).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.result.window).toEqual(window);
      expect(result.result.items).toHaveLength(1);
      expect(result.result.feedErrors).toEqual([{ feedId: FEEDS[0].id, error: "Simulated unavailable feed" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
  it("limits the agent to web research, configured egress/secrets and two turns", () => {
    expect(agent.model).toEqual({ id: "grok-4.5", params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] });
    expect(agent.tools).toEqual(["webSearch", "webFetch"]);
    expect(agent.local?.sandbox).toBeUndefined();
    expect(agent.concurrency?.maxRunningTurns).toBe(2);
    expect(agent.hosting?.egressDomains).toEqual([...FEED_HOSTS, "hooks.slack.com", "*.webhook.office.com", "*.logic.azure.com"]);
    expect(agent.hosting?.secretNames).toEqual(["BRIEF_TIMEZONE", "BRIEF_WEBHOOK_URL", "BRIEF_WEBHOOK_FORMAT", "BRIEF_LOCAL_HOUR"]);
  });
  it("allows process.env only inside the call-time configuration function, never at module top level", () => {
    function check(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) check(path);
        else if (path.endsWith(".ts")) {
          const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
          function visit(node: ts.Node) {
            if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
              if (/process(?:\s*\.\s*env|\s*\[\s*["']env["']\s*\])/.test(node.getText(file))) {
                let parent: ts.Node | undefined = node.parent;
                while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
                expect(path).toBe(join("bot", "lib", "config.ts"));
                expect(parent && ts.isFunctionDeclaration(parent) && parent.name?.text).toBe("getBriefConfig");
              }
            }
            ts.forEachChild(node, visit);
          }
          visit(file);
        }
      }
    }
    check("bot");
  });
});
