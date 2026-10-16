import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { EvalTestContext } from "@cursor/bdk/evals";
import agent from "../bot/agent.js";
import smoke from "../evals/brief-smoke.eval.js";
import config from "../evals/evals.config.js";

it("authors a live smoke contract with a fixed 72h UTC prompt and ordered research assertions", async () => {
  const t = {
    send: vi.fn().mockResolvedValue(undefined),
    succeeded: vi.fn(),
    calledTool: vi.fn(),
    toolOrder: vi.fn(),
    check: vi.fn(),
    reply: "Brief\n## Sources\nhttps://example.com/report",
  };
  await smoke.test!(t as unknown as EvalTestContext);
  expect(smoke.tags).toEqual(["smoke", "live"]);
  expect(config.maxConcurrency).toBe(2);
  expect(t.send).toHaveBeenCalledOnce();
  const prompt = t.send.mock.calls[0][0] as string;
  expect(prompt).toContain("2026-10-16 in UTC");
  const dates = prompt.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g)!;
  expect(dates).toHaveLength(2);
  expect(Date.parse(dates[1]) - Date.parse(dates[0])).toBe(72 * 60 * 60 * 1000);
  expect(t.succeeded).toHaveBeenCalledOnce();
  expect(t.calledTool.mock.calls).toEqual([
    ["fetch_feeds"], ["webSearch"], ["submit_brief", { count: 1, status: "completed" }],
  ]);
  expect(t.toolOrder).toHaveBeenCalledWith(["fetch_feeds", "webSearch", "submit_brief"]);
  expect(t.check.mock.calls).toEqual([
    [t.reply, { kind: "includes", value: /https:\/\// }],
    [t.reply, { kind: "includes", value: /Sources/i }],
  ]);
});

it("documents every declared secret and exact deployment/hidden-prompt commands without assigned values", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const name of agent.hosting!.secretNames!) {
    expect(readme).toContain(`| \`${name}\` |`);
    expect(readme).toContain(`npx bdk secrets set legal-cyber-brief ${name}\n`);
    expect(readme).not.toMatch(new RegExp(`${name}\\s*=`));
  }
  for (const command of [
    "git push", "npx bdk validate --dir .", "npx bdk deploy --slug legal-cyber-brief",
    'npx bdk deploy --slug legal-cyber-brief --allow-domain "$WEBHOOK_HOST"',
  ]) expect(readme).toContain(command);
});

it("includes eval definitions and config in the typecheck project", () => {
  const tsconfig = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"));
  expect(tsconfig.include).toContain("evals/**/*.ts");
});
