import { defineEval, includes } from "@cursor/bdk/evals";
import { buildBriefPrompt } from "../bot/lib/prompt.js";

export default defineEval({
  tags: ["smoke", "live"],
  async test(t) {
    // Fixed 72h reporting window: reproducible inputs, live feeds and search.
    await t.send(buildBriefPrompt({
      localDate: "2026-10-16",
      timezone: "UTC",
      window: {
        since: "2026-10-13T12:00:00Z",
        until: "2026-10-16T12:00:00Z",
      },
    }));
    t.succeeded();
    t.calledTool("fetch_feeds");
    t.calledTool("webSearch");
    t.calledTool("submit_brief", { count: 1, status: "completed" });
    t.toolOrder(["fetch_feeds", "webSearch", "submit_brief"]);
    t.check(t.reply, includes(/https:\/\//));
    t.check(t.reply, includes(/Sources/i));
  },
});
