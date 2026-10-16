import { prompt } from "@cursor/bdk";

export function buildBriefPrompt({ localDate, timezone, window }: {
  localDate: string;
  timezone: string;
  window: { since: string; until: string };
}): string {
  return prompt`
    Produce the legal-sector cyber brief for ${localDate} in ${timezone}.
    Research reporting within the inclusive window ${window.since} to ${window.until}.
    Call fetch_feeds with this window, discover and cross-check public sources,
    then call submit_brief with localDate, timezone, window, headline and incidents.
    For zero incidents include noIncidentsNote. Reply only with the returned markdown.
  `;
}
