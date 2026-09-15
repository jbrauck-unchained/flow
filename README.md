# Flow

One text box in, two statuses out. Built so that capturing a thought never requires
deciding where it goes.

Everything lives in plain files under `~/.flow/`, so local agents can read and write the
list without an MCP server, a protocol, or a running process — they need a path.

## Run it

```bash
npm install
npm run dev
```

`npm run dev` registers the extension with your local Raycast and hot-reloads on save.
Leave it running while you're changing things. When you're happy, quit it — the
extension stays installed.

Then open Raycast → Settings → Extensions → Flow and assign a global hotkey to
**Capture**. That hotkey is the whole point; pick something you can hit without looking.

## The two commands

**Capture** — hotkey, type, Enter. No window renders, so it's as fast as Raycast itself.
Closes with a HUD confirmation and nothing else.

**Tasks** — the list. The search bar doubles as the capture box: type anything that
isn't a match and the top row becomes "Add to the list."

## Syntax

Everything is optional. A bare line of text is a perfectly good item.

```
fix deferred deep link on android #referral @bug
```

- First `#word` → project
- Any `@word`, and any later `#word` → tag
- Everything else → title

Description is deliberately not capturable inline. Add it later with `Cmd+E`, or never.

## Keys

| | |
|---|---|
| `Enter` | Mark done (or add, when capturing) |
| `Cmd+E` | Edit |
| `Cmd+P` | Pin — the agent leaves pinned items alone |
| `Cmd+Shift+A` | Accept an agent's proposal |
| `Cmd+Z` | Undo the last change, whoever made it |
| `Cmd+Shift+C` | Copy title |
| `Ctrl+X` | Delete |
| `Cmd+Shift+D` | Show/hide done items |
| `Cmd+Shift+Backspace` | Clear all done items |

## The CLI

Agents write through `flow`, never by editing the JSON:

```bash
npm run build:cli && npm link      # or symlink bin/flow onto your PATH
flow init                          # writes ~/.flow/AGENTS.md
```

```bash
flow add 'fix deep link #referral @bug'
flow list --json --status todo
flow signal meeting 'Trading fee sync, Thu 2pm' --project tradingfees --at 2026-09-17T14:00
flow score --explain
flow tidy --propose
flow feedback --json --since <ts>
flow undo
```

Agents should identify themselves with `FLOW_ACTOR=agent:name` (or `--actor`), so their
writes are distinguishable from yours in the journal — that's what the "changed since you
last looked" section keys off.

## Getting things in from anywhere

The inbox is append-only JSONL, which makes the contract a single line with no
dependencies:

```bash
echo 'follow up on android attribution #referral @bug' >> ~/.flow/inbox.jsonl
```

It's drained the next time you open the list, or on any `flow list`.

## How priority is decided

Agents don't pick priority numbers. They report **facts they observed** — a meeting on
your calendar, a review landing in Slack — and a scorer turns those into a ranking:

```
signals.jsonl                          weights.json
  meeting, #tradingfees, Thu 2pm  ──┐    meeting:   0.8
  unblocked, @acceptance          ──┼──▶ unblocked: 0.6   ──▶  priority 0.83
                                    │    halfLife:  3d          why: "code review
                                    │                            approved in #eng ·
                                    └── decayed by time          Thu 2pm sync"
```

A meeting gets *more* urgent as it approaches; an observation fades from the day it
happened. Several signals on one item accumulate but never exceed 1.

The point of the split is that you can interrogate it:

```bash
flow score --explain     # every item, the signals that moved it, and by how much
```

If the ranking feels wrong, edit `~/.flow/weights.json` and run `flow score` again. The
weighting is a file you tune, not a prompt you rewrite and hope.

Priority is fully derived, so it's recomputed from scratch each run — last week's meeting
can't leave something stuck at the top. Pinned items are never scored at all.

## Finishing and cleaning up

`flow tidy` looks for work that has quietly finished: a project where everything is done
and nothing new has arrived in weeks, and done items old enough that nobody is coming
back. Agents can `flow tidy --propose` to file those as asks, which you accept with one
keystroke (`Cmd+Shift+A`).

Nothing is ever deleted. Archived items are written to `archive.jsonl` in full — the
substrate for a stats project later — and a git commit is taken immediately before and
after, so there are two independent ways back.

## The files

`~/.flow` is a git repo. `flow init` sets it up; snapshots are taken when an agent run
finishes and around anything destructive. The capture hotkey never touches git — that
path stays instant.

| file | who writes | shape |
|---|---|---|
| `items.json` | CLI and extension | `{version, items[]}` — canonical |
| `inbox.jsonl` | anyone, append only | one raw capture line per row |
| `signals.jsonl` | agents, append only | observations that drive the ranking |
| `weights.json` | you | how signals turn into priority |
| `journal.jsonl` | CLI and extension, append only | every mutation, with before/after |
| `feedback.jsonl` | you, append only | pushback the agent is required to read |
| `asks.jsonl` | agents | questions and proposals awaiting your answer |
| `archive.jsonl` | CLI only, append only | items removed from the list, in full |
| `digest.md` | agents | optional morning brief |
| `AGENTS.md` | `flow init` | the contract a cold agent reads to orient itself |

`items.json` is written atomically — temp file, then rename — so an agent reading
mid-write gets the old file or the new one, never a truncated one. Every write re-reads
from disk first, so the extension, the CLI and an agent can all write without locking and
without clobbering each other.

## How the agent loop works

Agents have **full write access**. They emit signals, group duplicate captures into
clusters, and reshape the ranking, all without asking. That's the point — the cognitive
load of organizing moves off you.

What makes that safe is the journal and undo:

- Every change is recorded with actor, before and after.
- Opening Tasks shows **"changed since you last looked"** for anything an agent did.
- `Cmd+Z`, or "Revert This Change", reverses it.
- **Reverting is how you push back.** It writes to `feedback.jsonl`, and the agent is
  required to read that before its next run and not repeat itself.
- `Cmd+P` pins an item, which agents must leave alone entirely.

A reference agent lives in `agents/` — a prompt, a runner, and a launchd plist for a
single morning run. It reads your calendar and messages, emits signals, and the runner
scores and snapshots afterwards. Set `FLOW_AGENT_CMD` to whatever you drive (`codex exec`,
`claude -p`). It runs once at a boundary, never hourly: output is pull, not push.

## Design decisions you may want to undo later

Done items are hidden by default and there is no count of them anywhere. The list only
ever shrinks. If you find yourself wanting a "completed today" view, add it — but notice
first whether wanting it is the same instinct that made Linear and Obsidian too heavy.

`Enter` marks done rather than opening a detail view. There is no detail view.

Items with no priority sort by recency exactly as they always did, so a list no agent has
touched behaves identically to the original.

## Not included on purpose

No due dates, no priorities *you* have to set, no third status, no sync, no reminders.
Each one is a decision at capture time, which is the thing that breaks. A computed
priority is fine — it costs you nothing at capture.

No notifications. Agent output improves the list; opening the list is the trigger.
