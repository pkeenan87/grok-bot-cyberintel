import { defineArtifacts } from "@cursor/bdk/artifacts";
import { BriefSchema } from "./lib/brief.js";

export default defineArtifacts({
  kinds: {
    "legal-cyber-brief": {
      description: "Validated, source-cited legal-sector cyber brief.",
      schema: BriefSchema,
    },
  },
});
