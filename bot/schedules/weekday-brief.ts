import { defineSchedule } from "@cursor/bdk/schedules";
import briefChannel from "../channels/brief.js";
import { buildBriefPrompt } from "../lib/prompt.js";
import { GateResultSchema } from "../tools/brief_gate.js";

export default defineSchedule({
  cron: "0 * * * *",
  async run({ callTool, receive, waitUntil, appAuth }) {
    const outcome = await callTool("brief_gate", {});
    if (outcome.isError) throw new Error(outcome.errorMessage ?? "brief_gate failed");
    const gate = GateResultSchema.parse(outcome.result);
    if (gate.shouldRun) {
      waitUntil(receive(briefChannel, { message: buildBriefPrompt(gate), auth: appAuth }));
    }
  },
});
