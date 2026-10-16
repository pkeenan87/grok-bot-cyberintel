import { defineAgent } from "@cursor/bdk";
import { FEED_HOSTS } from "./lib/feeds.js";

export default defineAgent({
  description: "Source-cited public cyber incident research for the legal sector.",
  model: {
    id: "grok-4.5",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  },
  tools: ["webSearch", "webFetch"],
  hosting: {
    egressDomains: [...FEED_HOSTS, "hooks.slack.com", "*.webhook.office.com", "*.logic.azure.com"],
    secretNames: ["BRIEF_TIMEZONE", "BRIEF_WEBHOOK_URL", "BRIEF_WEBHOOK_FORMAT", "BRIEF_LOCAL_HOUR"],
  },
  concurrency: { maxRunningTurns: 2 },
});
