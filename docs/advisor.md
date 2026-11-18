# Advisor: native tool and plugin tool

The advisor lets a cheaper model consult a stronger one before committing to
an approach, when an error repeats, and before it declares the task done. It
reaches the executor in one of two ways.

| | Native | Tool |
| --- | --- | --- |
| What the executor sees | Anthropic's `advisor_20260301` server tool | a plugin function tool named `advisor` with one argument, `question` |
| Who calls the advisor | Anthropic, inside the same request | this plugin, through OpenCode |
| Works with | an Anthropic executor and an Anthropic advisor whose pairing the API accepts | any provider OpenCode has configured |
| Context the advisor sees | the whole transcript | a bounded excerpt of the session |
| Needs | `opencode-claude-accounts` request hooks | nothing besides OpenCode |

Native is the behaviour described in the README and is unchanged when routing
v2 is off. The tool exists only with routing v2 (`v2.enabled: true`).

## Which one a request gets

`advisorImpl(executorModel, config)` decides, per executor model:

1. `none` when the advisor is disabled, or the executor is at or above the
   advisor level, or the executor's model maps to no level (map it in
   `v2.levels`, or the plugin cannot tell whether the advisor is stronger).
2. `v2.advisor.impl: "native"` or `"tool"` forces that implementation.
3. `"auto"` (default): `native` when the executor and the advisor model are
   both Anthropic and the API has not refused that pair in this process;
   `tool` otherwise. A refused pair (HTTP 400 naming the advisor) switches the
   next request of that pair from native to the tool.

With routing v2 off, the rule is the v1 one: native when the executor ranks
below `advisor.model` on the tier ladder, else none.

The advisor's model is `v2.levels[v2.advisor.level].model`, so it can be any
provider's model. The native tool needs that model to be Anthropic's.

## How the tool works

The executor calls `advisor({ question })`. The plugin:

1. reads the session's messages and the executor's model, and checks that the
   tool is active for this session (below);
2. enforces `advisor.maxUses` per executor turn (the session's latest user
   message; a new user message starts a new count). Past the limit the tool
   answers that the limit is reached;
3. builds the excerpt: newest items first until `advisor.maxContextTokens × 4`
   characters, shown oldest first. A tool output over 2,000 characters becomes
   a one-line stub; the item that crosses the limit is cut to its end;
4. asks the advisor level's model for a plan, a correction or `STOP` with the
   reason, in at most 200 words, and returns that text;
5. writes one advice record (`calls`, `inTokens`, `outTokens`, `cost`) and the
   same metrics the native path emits (`model_advisor.advisor.*`), plus a span
   with `advisor.impl = tool`.

Tokens and cost come from OpenCode when it reports them; otherwise tokens are
estimated at four characters each and cost is the list price of the advisor
model when its family is known (zero otherwise).

A failed advisor call returns a short failure note and tells the executor to
continue on its own judgement. It still counts against `maxUses`.

### Which OpenCode API makes the call

- **OpenCode 2:** `ctx.generate.text`, a one-shot completion with the advisor
  model. No session is created and no tools are offered, so the call cannot
  show up as a dispatch and the router never sees it. Auth stays OpenCode's.
- **OpenCode 1:** there is no one-shot call, so the plugin opens a temporary
  top-level session (no parent, title `advisor`), prompts it with the advisor
  model and every tool disabled (`tool.ids`), reads the reply, and deletes the
  session. With no parent it is not a subagent session, so the dispatch router
  and its session links ignore it. The session can be visible in the session
  list for the length of the call. Requests of that session are also skipped by
  the native policy (its prompts start with a fixed marker).

### Per-session gating

- **OpenCode 2:** a `session.context` hook adds the system line and keeps the
  tool for sessions the tool serves, and removes the tool definition from every
  other session's request.
- **OpenCode 1:** a plugin cannot choose tools per session. The tool is
  registered at load only when `v2.enabled` is true (a config change needs a
  restart), the system line is added per session, and `advisor` answers
  `advisor not enabled for this session` where the tool does not apply (native
  or no advisor, shadow mode, orchestrator agents). On requests that pass
  through the `opencode-claude-accounts` hooks, the plugin removes the
  definition and the system line from sessions the tool does not serve, and
  when the native tool is attached, so Anthropic never sees two tools named
  `advisor`.
- Registering the V1 tool imports `@opencode-ai/plugin` for its argument
  schema. If that package cannot be resolved, the tool is skipped and logged.

The tool is active only in `mode: "enforce"`; shadow mode registers nothing
new and the tool answers that it is not enabled.

## Cost

A tool definition costs prompt tokens on every request of every session that
carries it, used or not. The plugin keeps that to the sessions that need it
(OpenCode 2 fully; OpenCode 1 as far as the request path allows). Each advisor
call also costs the excerpt plus the answer on the advisor model. Watch the
call rate: an agent with a low call rate per turn is paying for the definition
and the system line without using them, so turn the advisor off for it (list it
in `orchestrators`, or set `advisor.enabled: false`).

## Config

```jsonc
{
  "advisor": { "enabled": true, "maxUses": 2, "maxContextTokens": 120000 },
  "v2": {
    "enabled": true,
    "advisor": { "level": "frontier", "impl": "auto" }, // auto | native | tool
    "levels": { "frontier": { "model": "openai/gpt-5-pro" } },
  },
}
```

- `advisor.enabled`, `maxUses`, `maxContextTokens` apply to both
  implementations. For the tool, `maxContextTokens` bounds the excerpt at four
  characters per token.
- `v2.advisor.level` names the level whose model is the advisor.
- `v2.advisor.impl` is `auto`, `native` or `tool`.
