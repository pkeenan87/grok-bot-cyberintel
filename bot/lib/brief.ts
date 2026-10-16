import { z } from "zod";

const text = z.string().trim().min(1);
const SourceSchema = z.object({
  url: z.url({ protocol: /^https$/ }),
  publisher: text,
  publishedAt: z.iso.datetime({ offset: true }).optional(),
});
export const IncidentSchema = z.object({
  title: text,
  organization: text,
  orgType: z.enum(["law_firm", "court_or_government_legal", "bar_or_legal_body", "legal_tech_vendor", "other_legal"]),
  attackType: text,
  status: z.enum(["confirmed", "reported", "unconfirmed"]),
  summary: text.max(600),
  whyItMatters: text.max(300),
  sources: z.array(SourceSchema).min(1).max(6),
});
export const BriefSchema = z.object({
  localDate: z.iso.date(),
  timezone: text.refine((timezone) => {
    try { new Intl.DateTimeFormat(undefined, { timeZone: timezone }); return true; }
    catch { return false; }
  }, "Invalid timezone"),
  window: z.object({
    since: z.iso.datetime({ offset: true }),
    until: z.iso.datetime({ offset: true }),
  }).refine(({ since, until }) => Date.parse(since) <= Date.parse(until), "Invalid window"),
  headline: text.max(280),
  incidents: z.array(IncidentSchema).max(8),
  watchlist: z.array(text).max(5).optional(),
  noIncidentsNote: text.optional(),
}).refine((brief) => brief.incidents.length > 0 || Boolean(brief.noIncidentsNote), {
  message: "An empty brief requires noIncidentsNote", path: ["noIncidentsNote"],
});
export type BriefInput = z.input<typeof BriefSchema>;
export type Brief = z.output<typeof BriefSchema>;

export function validateBrief(input: unknown): { brief: Brief; warnings: string[] } {
  const brief = BriefSchema.parse(input);
  const warnings: string[] = [];
  for (const incident of brief.incidents) {
    const seen = new Set<string>();
    incident.sources = incident.sources.filter((source) => {
      if (seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    });
    const hosts = new Set(incident.sources.map(({ url }) => new URL(url).hostname.replace(/^www\./, "")));
    if (incident.status === "confirmed" && hosts.size < 2) {
      incident.status = "reported";
      warnings.push(`${incident.title}: downgraded from confirmed to reported; requires sources on at least two distinct hosts.`);
    }
  }
  return { brief, warnings };
}

// Keep model-supplied text from introducing markdown links or extra sections.
const escape = (value: string) => value.replace(/\s+/g, " ").replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");

export function renderBriefMarkdown(brief: Brief): string {
  const sources = new Map<string, { number: number; publisher: string }>();
  for (const incident of brief.incidents) {
    for (const source of incident.sources) {
      if (!sources.has(source.url)) sources.set(source.url, { number: sources.size + 1, publisher: source.publisher });
    }
  }
  const lines = [
    `# Legal cyber brief — ${brief.localDate} (${brief.timezone})`,
    `Window: ${brief.window.since} – ${brief.window.until}`, "",
    escape(brief.headline), "",
  ];
  brief.incidents.forEach((incident, index) => {
    const citations = [...new Set(incident.sources.map(({ url }) => sources.get(url)!.number))].map((n) => `[${n}]`).join(" ");
    lines.push(`${index + 1}. **${escape(incident.title)}** — **${incident.status}** ${citations}`,
      `   ${escape(incident.organization)} · ${escape(incident.attackType)}. ${escape(incident.summary)}`,
      `   Why it matters: ${escape(incident.whyItMatters)}`, "");
  });
  if (!brief.incidents.length) lines.push(escape(brief.noIncidentsNote!), "");
  if (brief.watchlist?.length) lines.push("## Watchlist", ...brief.watchlist.map((item) => `- ${escape(item)}`), "");
  lines.push("## Sources", ...[...sources].map(([url, source]) => `[${source.number}] ${escape(source.publisher)} — <${url}>`));
  return lines.join("\n").trim();
}
