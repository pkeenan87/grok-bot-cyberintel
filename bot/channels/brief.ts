import { defineChannel, POST } from "@cursor/bdk/channels";
import { z } from "zod";
import { buildBriefPrompt } from "../lib/prompt.js";
import { GateResultSchema } from "../tools/brief_gate.js";

export default defineChannel({
  routes: [POST("/run", {
    bodySchema: z.object({ force: z.boolean().optional() }),
    async handler(_request, { body, callTool, waitUntil, send }) {
      const outcome = await callTool("brief_gate", { force: body.force ?? true });
      if (outcome.isError) throw new Error(outcome.errorMessage ?? "brief_gate failed");
      const gate = GateResultSchema.parse(outcome.result);
      if (gate.shouldRun) {
        waitUntil(send(buildBriefPrompt(gate), {
          continuationToken: `brief:${gate.localDate}`,
          title: `Legal cyber brief ${gate.localDate}`,
        }));
      }
      return new Response(null, { status: 202 });
    },
  })],
});
