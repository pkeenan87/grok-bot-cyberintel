import { XMLParser, XMLValidator } from "fast-xml-parser";

export type FeedConfig = {
  id: string;
  name: string;
  url: string;
  kind: "legal" | "security" | "government";
};

export type FeedItem = {
  feedId: string;
  source: string;
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string;
};

export const FEEDS: FeedConfig[] = [
  { id: "bleepingcomputer", name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/", kind: "security" },
  { id: "hacker-news", name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", kind: "security" },
  { id: "legal-futures", name: "Legal Futures", url: "https://www.legalfutures.co.uk/feed", kind: "legal" },
];

export const FEED_HOSTS: string[] = [...new Set(FEEDS.map((feed) => new URL(feed.url).hostname))];

// Preserve attributes for Atom link href/rel and text for mixed XML nodes.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false });
type Node = Record<string, unknown>;
const object = (value: unknown): Node => value && typeof value === "object" ? value as Node : {};
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === "string" ? value : textNode(value);
function textNode(value: unknown): string {
  const node = object(value);
  return typeof node["#text"] === "string" ? node["#text"] : "";
}
function plain(value: unknown): string {
  return text(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function date(value: unknown): string | null {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function httpUrl(value: string, base: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** Parse RSS 2.0 or Atom; malformed/non-feed documents are feed-level errors. */
export function parseFeed(xml: string, feed: FeedConfig): FeedItem[] {
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid feed XML");
  const root = object(parser.parse(xml));
  const rss = object(root.rss);
  const atom = object(root.feed);
  const isRss = Object.hasOwn(rss, "channel");
  if (!isRss && !Object.hasOwn(root, "feed")) throw new Error("Expected RSS 2.0 or Atom feed");
  const entries = isRss ? object(rss.channel).item : atom.entry;
  return list(entries).flatMap((entry) => {
    const node = object(entry);
    const links = list(node.link).map(object);
    const link = isRss ? text(node.link) : text(
      links.find((link) => link["@_rel"] === "alternate" && (!link["@_type"] || link["@_type"] === "text/html"))?.["@_href"]
      ?? links.find((link) => !link["@_rel"] || link["@_rel"] === "alternate")?.["@_href"],
    );
    const url = httpUrl(link, feed.url);
    const title = plain(node.title);
    if (!url || !title) return [];
    return [{
      feedId: feed.id,
      source: feed.name,
      title,
      url,
      publishedAt: date(isRss ? node.pubDate ?? node["dc:date"] : node.published ?? node.updated),
      summary: plain(node.description ?? node.summary ?? node["content:encoded"] ?? node.content).slice(0, 400),
    }];
  });
}
