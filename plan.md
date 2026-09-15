# Flow — next steps

Execution plan for an agent picking this up cold. Read this whole file before writing code.

---

## What exists today

A working Raycast extension at the repo root. Two commands:

- `src/capture.tsx` — no-view command with a single required text argument. Hotkey, type, Enter, HUD confirmation, done.
- `src/tasks.tsx` — list view. Search bar doubles as the capture box (`filtering={false}`, manual match). Enter marks done. Done items hidden by default.
- `src/lib/store.ts` — data model, inline-syntax parser, persistence.
- `src/components/edit-item.tsx` — form for adding a description or fixing project/tags after capture.

Item shape:

```ts
interface Item {
  id: string;            // `${Date.now()}-${random}`
  title: string;
  description: string;   // "" unless edited
  project?: string;      // first #word at capture
  tags: string[];        // @words and later #words
  status: "todo" | "done";
  createdAt: number;     // epoch ms
  doneAt?: number;
}
```

Typechecks clean under `npm run typecheck`. `@types/react` is pinned to 18.3.12 with an
npm `overrides` block — do not unpin it, React 19 types break all Raycast JSX components.

## The design constraint that governs everything below

This exists because Obsidian and Linear failed the owner, and they failed for one
reason: **they required a decision at the moment of capture.** Project, status, label,
where does this file live. That half-second is the failure point.

Every change below is judged against that. If a feature adds a decision at capture time,
it does not ship. If it adds a decision at *review* time, that's fine — review is
voluntary and already happening.

## Non-goals — do not build these

- **Hourly or scheduled notifications that interrupt.** Agent output is pull, not push.
  It improves the list; opening the list is the trigger. A prompt that fires sixteen
  times a day gets muted within a week.
- **Slack ingestion.** Highest volume, lowest signal. Would bury everything else.
- **A native hotkey app.** Raycast handles global hotkeys, non-activating panel focus,
  launch-at-login, signing, and updates. Rebuilding that buys nothing. Revisit only if
  capture latency becomes measurably bad or iOS is needed.
- **Due dates, priorities, a third status, sync, reminders.** Each is a capture-time
  decision. Not negotiable without the owner explicitly asking.

---

## Phase 1 — Move storage to a plain file

**Why first:** everything else is blocked on it. Today items live in Raycast's
`LocalStorage`, a sandboxed store inside Raycast's own database with no filesystem path.
Nothing outside the extension can read it. Once items are a file on disk, external
agents need no MCP server and no protocol — they need a path.

**Target:** `~/.flow/items.json`

```json
{
  "version": 1,
  "items": [ /* Item[], newest first */ ]
}
```

**Work:**

1. In `src/lib/store.ts`, replace the two `LocalStorage` calls in `loadItems` /
   `saveItems` with `fs/promises` against `path.join(os.homedir(), ".flow", "items.json")`.
   Raycast extensions run in Node, so this needs no new dependency.
2. `mkdir` the directory with `{ recursive: true }` on every write. Cheap, avoids a
   first-run branch.
3. **Write atomically.** Write to `items.json.tmp`, then `fs.rename` over the target.
   Rename is atomic on the same filesystem, so an agent reading mid-write gets either
   the old file or the new one, never a truncated one.
4. Missing file returns `[]`. Malformed JSON returns `[]` rather than throwing — a
   corrupt file must not make the extension unopenable.
5. **Migrate once.** On load, if the file does not exist and `LocalStorage` key
   `flow.items` does, import those items, write the file, then delete the
   `LocalStorage` key so migration doesn't re-run.

**Done when:** capture something via the hotkey, then `cat ~/.flow/items.json` in a
terminal and see it. Mark it done in the list, `cat` again, see `status: "done"` and a
`doneAt`. Pre-existing items survived the migration.

**Leave alone:** `parse`, `matches`, `splitTags`, and both command files. They're pure
functions over the item shape and don't care where it's stored.

---

## Phase 2 — An append-only inbox for agents

**Problem this solves:** if an external agent writes `items.json` while the extension
has state in memory, the next extension write clobbers the agent's. Locking is overkill
for a single-user local file.

**Solution:** a second file that agents only ever append to, and the extension drains.

**Target:** `~/.flow/inbox.json` — a bare JSON array of strings, each a raw capture line
in the normal inline syntax (`"follow up on android attribution #referral @bug"`).

**Work:**

1. Add `drainInbox()` to `store.ts`: read the array, `parse()` each string into an Item,
   prepend them to items, write `items.json`, then truncate `inbox.json` to `[]`.
2. Call it in the `useEffect` in `src/tasks.tsx`, before `loadItems` resolves into state.
   Also call it at the top of `src/capture.tsx`.
3. Missing or malformed inbox file is a no-op, not an error.
4. Document the contract in `README.md` so future agents know the file exists and that
   **strings in, nothing else** — agents never write `items.json` directly.

**Done when:** `echo '["test from agent #flow"]' > ~/.flow/inbox.json`, open Tasks, the
item appears parsed with project `flow`, and the inbox file is now `[]`.

---

## Phase 3 — Derived signals, surfaced in the list

Two things, and they are not the same kind of thing.

### 3a. Staleness — no AI involved

Anything `status: "todo"` with `createdAt` older than 14 days is stale. This is a sort
order and a subtle accessory icon, not an insight. Implement it as pure code in
`tasks.tsx`. Do not add a badge count or a warning color — the point is a gentle nudge,
not a guilt surface.

### 3b. Clustering — where a model actually earns its place

The owner captures the same half-thought repeatedly in different words across weeks.
That's invisible to him and legible to a model.

**Contract:** an external agent (scheduled Codex run) reads `~/.flow/items.json` and
writes `~/.flow/suggestions.json`:

```json
{
  "generatedAt": 1757800000000,
  "suggestions": [
    {
      "id": "sug-1",
      "kind": "cluster",
      "itemIds": ["1757...-a1b2c3", "1757...-d4e5f6"],
      "message": "Three separate captures about Android attribution — same thing?"
    }
  ]
}
```

**Extension work:** render a `Suggestions` section at the top of the Tasks list, above
`To Do`, only when the file is non-empty. Each suggestion gets two actions: one that
acts on it, one that dismisses. Dismissal removes it from the file so it doesn't
resurface.

**Hard rule:** suggestions never mutate items on their own. The agent proposes, the
owner accepts with a keystroke. An agent silently merging or reprioritizing his list is
exactly the heaviness this whole project exists to avoid.

**Done when:** hand-write a `suggestions.json`, open Tasks, see the section, dismiss one,
confirm it's gone from the file and doesn't return.

---

## Phase 4 — One morning digest

**Not hourly. Once, at a boundary.**

A scheduled Codex run reads `items.json` plus the owner's calendar and writes
`~/.flow/digest.md` — plain markdown, a few lines:

> You have 90 free minutes at 2pm. Six open `#referral` items, three of them stale.
> Nothing captured since Thursday under `#onboarding`.

**Extension work:** a third command, `digest`, `mode: "view"`, rendering the file with
Raycast's `<Detail markdown={...} />`. If the file is missing or older than 24 hours,
say so plainly rather than showing stale content as if it were current.

Register it in `package.json` under `commands`. Any new `.tsx` at the root of `src/`
must have a matching command entry or the build will complain — put helpers in
`src/lib/` or `src/components/`.

**Done when:** writing a digest file by hand and opening the command renders it.

---

## Order and stopping points

Phase 1 is unambiguously correct and unblocks everything. Do it regardless.

Phase 2 is correct if any agent work is happening at all. Do it alongside Phase 1.

**Stop after Phase 2 and get the owner to use it for two weeks before building 3 or 4.**
Both phases are speculative about what he'll actually want, and the whole history of
this problem is tools that added features he didn't need. Real usage data on what the
list looks like after two weeks should drive whether clustering or the digest gets built
first, or either.

## Open questions for the owner — don't decide these unilaterally

- Should done items be purged automatically after N days, or kept forever? Currently
  kept, hidden, with no count shown anywhere. That was deliberate; confirm it still
  feels right once the list has real history in it.
- Does `~/.flow/` want to be a git repo? Free history and a sync path, but it's a
  decision with maintenance attached.
- Phase 3 or Phase 4 first, or neither.
