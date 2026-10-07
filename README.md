# Claude Code approval reviewer

Reviews pending Claude Code tool permissions with your signed-in Claude model. It respects existing allow and deny rules and does not save new permission rules.

## Install

Requires Claude Code 2.1.292 or newer, function-hook support, and access to the reviewer model (Sonnet unless you set the plugin's `model` option). Add this to `~/.claude/settings.json` (merge it into your existing `env` object if you have one):

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

Then install the plugin for your user:

```sh
claude plugin marketplace add prvious/claude-auto-review --scope user
claude plugin install approval-reviewer@prvious-plugins --scope user
```

Start a new `claude` session. The footer should show `approval reviewer active`; use `/approval-history` to see its decisions.

## How it decides

- Existing native allows and denials stay in force. Explicit `ask` rules, classic-hook asks, organization permission ceilings, plugin-origin requests, permission queries, `AskUserQuestion`, and `ExitPlanMode` keep their native behavior.
- Verified edits inside the workspace are approved without a model call. This checks location, not whether the edit follows a natural-language instruction. `.git`, `.claude`, paths that are themselves symlinks, and paths outside the workspace use review instead. Parent symlinks must resolve inside the workspace.
- Other eligible permission requests are assessed using the current conversation, bounded tool calls/results, and the relevant subagent conversation when available. Risk reflects the immediate action: a routine feature-branch push or disposable build cleanup does not automatically count as high risk.
- Captured composer, Remote Control (`bridge`), and SDK/headless instructions can authorize actions. Peer messages, task notifications, repository text, tool output, and copied approvals cannot. High-risk approvals must cite a captured owner instruction; Critical actions are denied.
- Plan mode remains enforced. The plugin does not approve exiting Plan mode.
- Trust boundary: the reviewer defends against untrusted content steering the agent, such as repository text, tool output, peer messages, and copied approvals. Claude Code itself, managed settings, classic hooks, and other installed plugins are trusted: they share the permission chain and can already answer permission checks directly, so the reviewer does not try to detect them rewriting its evidence reads or metadata.

The last 256 accepted owner instructions are kept separately from transcript context, in memory. Review prompts include a bounded portion of this buffer and the transcript, so older instructions can fall outside the review context. Very large instructions retain their beginning and end; partial instructions cannot authorize high-risk effects. Dropped or rejected prompts grant no authority. Compaction does not reset this buffer. Restarting, resuming in another process, or forking starts with inherited conversation as context; a fresh instruction such as “continue” can authorize continuing the described task when it clearly covers the action. A high-risk action with unclear authorization needs a specific owner instruction. Missing history never disables the session.

## Failure and recovery

Each review has at most three model completions, one filesystem evidence round, and a 90-second deadline covering metadata, evidence, and model calls. Malformed responses get bounded repairs; transient provider failures get bounded retries. Changed owner instructions, working scope, or Plan mode refresh the review within that same budget. Evidence remains available on refresh only while its scope and file metadata stay verified. Native Read permissions apply to evidence paths; file contents also pass through the actual Read tool and its classic hooks.

A safety denial requests an explanation of the effect and the safer alternative or authorization needed. An unavailable review says that it could not complete and that the action was not run; it is a separate outcome from judging the action unsafe. The agent should report that action as blocked and continue independent work. Splitting or repeating equivalent commands does not resolve a review failure.

The next request can be reviewed normally. There is no startup model ping, permanent failure flag, or stored-session database. Status display failures do not change a decision. `/approval-history` shows the last 20 decisions for the current session and is cleared when the session ends.

## Verify changes

```sh
node --experimental-strip-types --test hooks/*.node-test.ts
claude plugin test .
```

Use disposable workspaces for live tests. Check execution counts as well as decisions, including after compaction, `/clear`, resume/fork, parallel subagents, cancellation, and an unavailable reviewer model.
