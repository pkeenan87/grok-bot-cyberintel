# Legal cyber brief

A Grok-powered BDK agent that produces a short, source-cited brief on public
cyberattack reporting affecting law firms, courts, bar associations, and
legal-tech vendors. It fetches RSS/Atom feeds, discovers and corroborates reports
with web search, then validates and renders a structured brief (up to eight
incidents) with numbered HTTPS citations. Submission stores a BDK artifact and
records delivery state; an optional webhook receives Slack text or JSON.
Single-source claims cannot be marked confirmed. Feed and search content is
untrusted data, not instructions.

## Layout

- `bot/agent.ts`: model, tool permissions, declared secrets and egress hosts.
- `bot/instructions.md`, `bot/skills/legal-cyber-research/`: procedure and research playbook.
- `bot/tools/`: `fetch_feeds`, `brief_gate`, and `submit_brief`.
- `bot/lib/`: feed list/parser, relevance policy, time/config, prompt, renderer, webhook.
- `bot/channels/brief.ts`: manual `POST /run` route.
- `bot/schedules/weekday-brief.ts`: hourly UTC tick.
- `bot/artifacts.ts`: `legal-cyber-brief` artifact schema.
- `evals/`: live smoke eval and concurrency configuration.
- `test/`: deterministic Vitest tests and fixtures.

## Prerequisites

- Node **22.13+** and npm.
- Install with `npm ci`, then authenticate with `npx bdk login`.
- BDK access to the configured Grok model and network access for feeds/search.
  Hosted deploys and evals require Cursor Privacy Mode (or the applicable team setting).

Commands below use `npx bdk` to run the pinned project dependency; with BDK on
PATH, the equivalent commands are `bdk dev`, `bdk call`, etc.

## Local development

Provide the desired configuration in the development process environment using
your local secret manager. Do not commit, echo, or place secret values in command
arguments. `BRIEF_TIMEZONE` must be set even for forced manual runs. Omit the
webhook configuration unless you intend to send real notifications.

```sh
npx bdk dev --dir . --port 3000
```

Use the mounted slug printed by `dev`/`bdk info` (in this checkout it is
`grok-bot-cyberintel`, derived from the directory name). In a second terminal:

```sh
DEV_URL=http://127.0.0.1:3000/grok-bot-cyberintel
npx bdk call fetch_feeds --url "$DEV_URL" --input '{"since":"2026-10-13T12:00:00Z","until":"2026-10-16T12:00:00Z"}'
curl --fail-with-body -X POST "$DEV_URL/v1/dev/schedules/weekday-brief"
curl --fail-with-body -X POST "$DEV_URL/v1/channels/brief/run" \
  -H 'Content-Type: application/json' -d '{"force":true}'
```

Adjust the sample feed window to the reporting dates you need. Dev schedules do
**not** fire automatically: dispatch the dev schedule endpoint above. A gated-off
tick returns without starting a model session. The manual route defaults to
`force: true`: it bypasses weekday/hour and prior delivery checks, but not a missing
or invalid timezone or an active 30-minute claim. Send `{"force":false}` to honor
the normal gate. Local routes require direct loopback requests, without proxy
forwarding headers. A successful manual request returns 202; inspect the session
in the dev playground rather than expecting the brief in the HTTP response.
Manual submissions outside evals update local delivery state and can POST to a
configured webhook.

## Checks and live smoke eval

```sh
npm test
npm run typecheck
npx bdk validate --dir .
npx bdk eval --dir . --list
npx bdk eval --dir . brief-smoke --timeout-ms 1200000
```

`brief-smoke` is tagged `smoke` and `live`, with suite concurrency capped at two.
It sends `buildBriefPrompt` for a committed 72-hour UTC window, asserts a successful
turn, feed → web search → submission order, exactly one completed submission, and
an HTTPS citation plus a Sources section in the reply. This is a paid, live-model
and network-dependent check, not a deterministic unit test. The fixed window is
2026-10-13 through 2026-10-16; deliberately refresh it when testing newer reporting.
Do not fabricate incidents to satisfy it: no qualifying reports or unavailable
sources can legitimately cause the cited-brief assertion to fail.

The `submit_brief` eval-purpose guard still validates/renders and tags an eval
artifact, but skips **all KV delivery updates and webhook POSTs**. It does not
claim a scheduled day because this eval sends the prompt directly, not through
the gate. Listing evals does not execute a model turn.

## Deploy and configure

Run from the project root after your normal review/commit workflow. Push the
approved code, validate, then deploy:

```sh
git push
npx bdk validate --dir .
npx bdk deploy --slug legal-cyber-brief
npx bdk secrets set legal-cyber-brief BRIEF_TIMEZONE
```

Enter values only at the hidden prompts, never as `NAME=VALUE` or CLI arguments.
Every secret name declared in `bot/agent.ts` is documented here:

| Secret | Purpose |
| --- | --- |
| `BRIEF_TIMEZONE` | Required valid IANA timezone. Missing/invalid fails closed, including manual requests. |
| `BRIEF_WEBHOOK_URL` | Optional HTTPS destination; treat the entire URL as a credential. Unset means artifact-only delivery. |
| `BRIEF_WEBHOOK_FORMAT` | Optional format selector: `slack` sends a text field; `json` sends markdown and structured brief. Defaults to Slack format. |
| `BRIEF_LOCAL_HOUR` | Optional integer hour from 0–23; defaults to 9. Invalid settings fall back to 9. |

Set optional secrets only when needed:

```sh
npx bdk secrets set legal-cyber-brief BRIEF_WEBHOOK_URL
npx bdk secrets set legal-cyber-brief BRIEF_WEBHOOK_FORMAT
npx bdk secrets set legal-cyber-brief BRIEF_LOCAL_HOUR
```

New secret values apply to subsequent requests without redeploying. Values are
read inside handlers, never during module loading. Do not print them to verify
configuration. Keep credentials out of the repository, prompts and logs.

### Webhook egress

Default outbound hosts include the committed feed hosts, `hooks.slack.com`,
`*.webhook.office.com`, and `*.logic.azure.com`. Other webhook hosts require a
redeploy that allows the **hostname only**, without a scheme, path or token:

```sh
npx bdk deploy --slug legal-cyber-brief --allow-domain "$WEBHOOK_HOST"
```

Set `WEBHOOK_HOST` to the intended hostname using your deployment environment;
it is not a declared agent secret. Repeat `--allow-domain` for additional hosts
and retain these flags on later deploys, or maintain the permanent host allowlist
in `bot/agent.ts`. Setting a webhook URL alone does not grant egress. Webhook
requests time out after 10 seconds. Failure is logged/reported but does not undo
artifact storage or delivery state, so catch-up ticks do not retry just the webhook.

### Scheduling and runtime limits

BDK cron runs in UTC. `0 * * * *` ticks every hour on **all** UTC days, then the
gate evaluates the weekday and hour in `BRIEF_TIMEZONE`. By default it starts at
09:00 local on local weekdays, automatically shifting the UTC hour across DST;
Monday locally can still be Sunday UTC. Up to two catch-up ticks (10:00 and
11:00 local at the default hour) can recover a missed/failed run. The configured
hour and catch-up range do not wrap past local midnight.

KV `delivered:<localDate>` prevents another normal run after submission; a
`claim:<localDate>` lease blocks overlapping attempts for 30 minutes.
`lastSuccessfulUntil` determines the next reporting window, initially 72 hours
and capped at 96 hours of lookback. Nonmatching ticks do not invoke the model.

A hosted schedule run must finish within **26 minutes**, including background
work passed to `waitUntil`/`receive`. Keep searches bounded (the instructions cap
research effort) and investigate slow sessions before this deadline. For
**self-hosting, use a single process/replica with persistent state**: KV
read-then-write claims are not a distributed lock, so multiple runtimes can race.

### Verify production

After deploy reports running and secrets are set, inspect gate decisions and
sessions:

```sh
npx bdk logs --prod --once --slug legal-cyber-brief
npx bdk session "$SESSION_ID" --prod --slug legal-cyber-brief
```

Take `SESSION_ID` from a `ses_...` header in the logs; rerun session inspection
until it finishes. Confirm fetch/search/submit calls and the final cited markdown
and artifact. An off-hour gate skip should not create a model session.

For a manual hosted run, POST to the deployment alias URL at
`/v1/channels/brief/run` with the same JSON body as locally and the
`X-Agent-Alias-Token` header. Obtain and store the alias token securely from the
first deploy; never paste it into documentation or logs. Hosted custom routes
acknowledge with 202 before background handling finishes, so verify the actual
outcome using logs and session inspection. Forced runs can redeliver a brief.

## Editing feeds

Edit `FEEDS` in `bot/lib/feeds.ts`: give each feed a unique ID, display name,
RSS/Atom URL and kind (`legal`, `security`, or `government`). Legal feeds require
a cyber-term match; security/government feeds require a legal-sector match.
`FEED_HOSTS` is derived from these URLs and imported by `bot/agent.ts` for egress.
Keep parser/relevance fixtures and tests current, run the checks above, then
review, commit/push and **redeploy**. Adding or changing a feed hostname changes
hosted egress and cannot be applied by changing secrets alone. Individual feed
failures are returned to the agent without failing the entire fetch.
