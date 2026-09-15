import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { Item, parse } from "./item";

// Re-exported so every existing `from "./lib/store"` import keeps working.
export * from "./item";
import { DEFAULT_WEIGHTS, Scored, Signal, Weights, mergeWeights, scoreAll } from "./score";

/** Who made a change. Every journal entry carries one. */
export type Actor = "owner" | "cli" | "inbox" | "migration" | `agent:${string}`;

export interface JournalEntry {
  ts: number;
  actor: Actor;
  op: "add" | "update" | "remove";
  id: string;
  before: Partial<Item> | null;
  after: Partial<Item> | null;
  /** Set when this entry is reversing an earlier group, holding that group's ts. */
  undoOf?: number;
}

const VERSION = 2;

export const FLOW_DIR = join(homedir(), ".flow");
export const ITEMS_FILE = join(FLOW_DIR, "items.json");
export const JOURNAL_FILE = join(FLOW_DIR, "journal.jsonl");
export const INBOX_FILE = join(FLOW_DIR, "inbox.jsonl");
export const FEEDBACK_FILE = join(FLOW_DIR, "feedback.jsonl");
export const ASKS_FILE = join(FLOW_DIR, "asks.jsonl");

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Appends to a .jsonl file. Small writes opened with O_APPEND land whole, so
 * agents and the extension can both write without coordinating.
 */
export async function appendJsonl(file: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(FLOW_DIR, { recursive: true });
  await appendFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

/** Reads a .jsonl file. A missing file is empty; a malformed line is skipped, not fatal. */
export async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A hand-mangled line shouldn't cost us the rest of the file.
    }
  }
  return rows;
}

export async function loadItems(): Promise<Item[]> {
  let raw: string;
  try {
    raw = await readFile(ITEMS_FILE, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // Tolerate a bare array so a hand-edited or v1-shaped file still opens.
    if (Array.isArray(parsed)) return parsed as Item[];
    if (parsed !== null && typeof parsed === "object") {
      const items = (parsed as { items?: unknown }).items;
      if (Array.isArray(items)) return items as Item[];
    }
    await quarantine();
    return [];
  } catch {
    // A corrupt file must not make the extension unopenable — but it must not be
    // silently destroyed by the next write either.
    await quarantine();
    return [];
  }
}

/**
 * Moves unreadable content aside before we start over on top of it.
 *
 * Returning [] keeps the list openable; this keeps the bytes recoverable. Without
 * it, one malformed write from an agent would quietly take the whole list with it.
 */
async function quarantine(): Promise<void> {
  try {
    // Rename rather than copy, so the next read finds nothing and we don't pile
    // up a new quarantine file on every attempt.
    await rename(ITEMS_FILE, `${ITEMS_FILE}.corrupt-${Date.now()}`);
  } catch {
    // Best effort. Never block opening the list on this.
  }
}

/**
 * Writes items atomically: a uniquely named temp file, then rename over the
 * target. Rename is atomic on one filesystem, so a reader mid-write gets the
 * old file or the new one, never a truncated one. The temp name carries the
 * pid so two writers can't collide on it.
 */
async function writeItems(items: Item[]): Promise<void> {
  await mkdir(FLOW_DIR, { recursive: true });
  const tmp = `${ITEMS_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: VERSION, items }, null, 2), "utf8");
  await rename(tmp, ITEMS_FILE);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/** Long enough that a live holder is never mistaken for a dead one. */
const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 12;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn while holding an exclusive on-disk lock.
 *
 * Atomic writes stop a reader seeing half a file, but they do nothing about two
 * writers that both read, both decide, and both write — the second silently
 * discards the first. Every read-modify-write in here has to be one critical
 * section, and `open(path, "wx")` is the primitive that gives us that: exclusive
 * create is atomic, so exactly one caller wins the race to create the file.
 *
 * A holder that crashes would otherwise wedge the list permanently, so a lock
 * older than LOCK_STALE_MS is treated as abandoned and broken.
 */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(FLOW_DIR, { recursive: true });
  const lockPath = join(FLOW_DIR, `${name}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;

  while (!held) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid}`).catch(() => undefined);
      await handle.close();
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // Released between our open and our stat — just try again.
      }

      if (Date.now() > deadline) {
        // Failing loudly beats writing anyway and losing someone else's work.
        throw new Error(`could not lock ${name} after ${LOCK_TIMEOUT_MS}ms (${lockPath})`);
      }
      // Jittered, so queued writers don't all wake at the same instant.
      await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The one write path
// ---------------------------------------------------------------------------

const FIELDS: (keyof Item)[] = [
  "title",
  "description",
  "project",
  "tags",
  "status",
  "createdAt",
  "doneAt",
  "priority",
  "why",
  "cluster",
  "source",
  "agentTouchedAt",
  "pinned",
];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Only the fields that actually moved, so the journal stays readable. */
function changed(prev: Item, next: Item): { before: Partial<Item>; after: Partial<Item> } {
  const before: Partial<Item> = {};
  const after: Partial<Item> = {};
  for (const field of FIELDS) {
    if (same(prev[field], next[field])) continue;
    (before as Record<string, unknown>)[field] = prev[field] ?? null;
    (after as Record<string, unknown>)[field] = next[field] ?? null;
  }
  return { before, after };
}

function diff(actor: Actor, before: Item[], after: Item[], ts: number, undoOf?: number): JournalEntry[] {
  const was = new Map(before.map((item) => [item.id, item]));
  const is = new Map(after.map((item) => [item.id, item]));
  const entries: JournalEntry[] = [];

  for (const [id, item] of is) {
    const prev = was.get(id);
    if (!prev) {
      entries.push({
        ts,
        actor,
        op: "add",
        id,
        before: null,
        after: item,
        ...(undoOf ? { undoOf } : {}),
      });
      continue;
    }
    const delta = changed(prev, item);
    if (Object.keys(delta.after).length > 0) {
      entries.push({
        ts,
        actor,
        op: "update",
        id,
        ...delta,
        ...(undoOf ? { undoOf } : {}),
      });
    }
  }
  for (const [id, item] of was) {
    if (!is.has(id)) {
      entries.push({
        ts,
        actor,
        op: "remove",
        id,
        before: item,
        after: null,
        ...(undoOf ? { undoOf } : {}),
      });
    }
  }
  return entries;
}

/**
 * The only way items change. Loads fresh from disk, applies the mutation, writes
 * atomically, then journals what moved.
 *
 * Loading fresh rather than trusting an in-memory array is what makes it safe for
 * the extension, the CLI and an agent to write concurrently — a stale caller can
 * no longer clobber a write it never saw.
 */
export async function mutate(actor: Actor, apply: (items: Item[]) => Item[], undoOf?: number): Promise<Item[]> {
  return withLock("items", async () => {
    const before = await loadItems();
    const after = apply(before);
    const ts = Date.now();
    const entries = diff(actor, before, after, ts, undoOf);
    if (entries.length === 0) return before;
    await writeItems(after);
    await appendJsonl(JOURNAL_FILE, entries);
    return after;
  });
}

export async function addItem(input: string, actor: Actor = "owner", extra?: Partial<Item>): Promise<Item> {
  const item = { ...parse(input), ...extra };
  await mutate(actor, (items) => [item, ...items]);
  return item;
}

/** Bulk insert that keeps the given ids and timestamps. Used by the one-time migration. */
export async function importItems(incoming: Item[], actor: Actor = "migration"): Promise<Item[]> {
  return mutate(actor, (items) => {
    const known = new Set(items.map((item) => item.id));
    return [...incoming.filter((item) => !known.has(item.id)), ...items];
  });
}

export async function readJournal(): Promise<JournalEntry[]> {
  return readJsonl<JournalEntry>(JOURNAL_FILE);
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * A single mutation writes several entries sharing one ts. Undo works on those
 * groups, newest first, skipping groups that have already been reversed and the
 * reversals themselves — so repeated undo walks back through history rather than
 * toggling the same change on and off.
 */
function undoableGroups(journal: JournalEntry[]): Map<number, JournalEntry[]> {
  const reversed = new Set<number>();
  for (const entry of journal) if (entry.undoOf) reversed.add(entry.undoOf);

  const groups = new Map<number, JournalEntry[]>();
  for (const entry of journal) {
    if (entry.undoOf || reversed.has(entry.ts)) continue;
    const group = groups.get(entry.ts);
    if (group) group.push(entry);
    else groups.set(entry.ts, [entry]);
  }
  return groups;
}

function reverse(entries: JournalEntry[], items: Item[]): Item[] {
  let next = items;
  for (const entry of entries) {
    if (entry.op === "add") {
      next = next.filter((item) => item.id !== entry.id);
    } else if (entry.op === "remove" && entry.before) {
      next = [entry.before as Item, ...next.filter((item) => item.id !== entry.id)];
    } else if (entry.op === "update" && entry.before) {
      const restore = entry.before;
      next = next.map((item) => {
        if (item.id !== entry.id) return item;
        const merged: Record<string, unknown> = { ...item };
        for (const [field, value] of Object.entries(restore)) {
          if (value === null) delete merged[field];
          else merged[field] = value;
        }
        return merged as unknown as Item;
      });
    }
  }
  return next;
}

export interface UndoResult {
  undone: number;
  entries: JournalEntry[];
}

/**
 * Reverses one specific mutation, identified by its journal ts.
 *
 * Targeting a single change is what lets the owner reject one agent decision
 * without discarding the rest, and it records the rejection in feedback.jsonl.
 * That record is the only reason unrestricted agent writes are workable — undo
 * is how the owner says no, and the agent is required to read it.
 */
export async function undoGroup(ts: number): Promise<UndoResult> {
  const journal = await readJournal();
  const group = journal.filter((entry) => entry.ts === ts && !entry.undoOf);
  if (group.length === 0) return { undone: 0, entries: [] };

  await mutate("owner", (items) => reverse(group, items), ts);
  await addFeedback(
    group
      .filter((entry) => entry.actor !== "owner" && entry.actor !== "migration")
      .map((entry) => ({
        ts: Date.now(),
        kind: "undo" as const,
        actor: "owner" as const,
        itemId: entry.id,
        reverted: (entry.after ?? {}) as Partial<Item>,
      })),
  );
  return { undone: 1, entries: group };
}

/** Reverses the most recent n mutations, newest first. */
export async function undoLast(n = 1): Promise<UndoResult> {
  const journal = await readJournal();
  const timestamps = [...undoableGroups(journal).keys()].sort((a, b) => b - a).slice(0, n);

  const entries: JournalEntry[] = [];
  let undone = 0;
  for (const ts of timestamps) {
    const result = await undoGroup(ts);
    undone += result.undone;
    entries.push(...result.entries);
  }
  return { undone, entries };
}

/**
 * What agents have changed since the owner last looked, newest first.
 *
 * Full write authority is only tolerable if what was done on the owner's behalf
 * is visible afterwards. This is that view. Already-reversed changes are excluded
 * so a rejection doesn't keep resurfacing.
 */
export async function agentChangesSince(since: number): Promise<JournalEntry[]> {
  const journal = await readJournal();
  const reversed = new Set<number>();
  for (const entry of journal) if (entry.undoOf) reversed.add(entry.undoOf);

  return journal
    .filter((entry) => entry.ts > since && entry.actor.startsWith("agent:") && !entry.undoOf && !reversed.has(entry.ts))
    .sort((a, b) => b.ts - a.ts);
}

/** A short phrase for what one journal entry did, for the list subtitle. */
export function describeChange(entry: JournalEntry): string {
  const who = entry.actor.replace("agent:", "");
  if (entry.op === "add") return `added by ${who}`;
  if (entry.op === "remove") return `removed by ${who}`;
  const fields = Object.keys(entry.after ?? {}).filter((field) => field !== "agentTouchedAt");
  return `${fields.length > 0 ? fields.join(", ") : "updated"} \u2014 ${who}`;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/**
 * Drains ~/.flow/inbox.jsonl into the list.
 *
 * The inbox is JSONL rather than a JSON array specifically so a writer can append
 * with `echo … >> inbox.jsonl` and nothing else — no read, no parse, no rewrite.
 * That one line is the whole contract for getting a thought into Flow from outside.
 *
 * Draining renames the file out of the way first. Rename is atomic, so an append
 * landing a microsecond later goes to a fresh inbox and waits for the next drain
 * rather than being truncated away.
 */
export async function drainInbox(): Promise<Item[]> {
  const draining = join(FLOW_DIR, "inbox.draining");
  try {
    await rename(INBOX_FILE, draining);
  } catch {
    // No inbox, or someone else got there first. Either way there's nothing to do.
    return [];
  }

  let raw: string;
  try {
    raw = await readFile(draining, "utf8");
  } catch {
    return [];
  }

  const captured: Item[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text.length === 0) continue;
    // A line may be a bare string or a JSON-quoted one. Both are fine.
    let input = text;
    if (text.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(text);
        if (typeof decoded === "string") input = decoded;
      } catch {
        // Not valid JSON — take it literally rather than dropping the thought.
      }
    }
    captured.push(parse(input));
  }

  if (captured.length > 0) {
    await mutate("inbox", (items) => [...captured, ...items]);
  }
  await unlink(draining).catch(() => undefined);
  return captured;
}

// ---------------------------------------------------------------------------
// Asks and feedback — the agent/owner conversation
// ---------------------------------------------------------------------------

/**
 * Something an agent proposes to do that it has chosen not to just do.
 *
 * Agents write advisory fields freely, but anything destructive is proposed rather
 * than executed. `action` is what makes accepting a one-keystroke affair instead of
 * a round trip that waits for the agent's next run.
 */
export interface Ask {
  id: string;
  ts: number;
  kind: "question" | "suggestion";
  actor: Actor;
  message: string;
  itemIds?: string[];
  options?: string[];
  action?: { kind: "archive"; itemIds: string[]; reason: ArchiveRow["reason"] };
}

/** Carries out an accepted ask. Returns a line describing what happened. */
export async function acceptAsk(ask: Ask): Promise<string> {
  if (!ask.action) return "nothing to do";
  const rows = await archiveItems(ask.action.itemIds, ask.action.reason, "owner");
  await addFeedback([
    { ts: Date.now(), kind: "answer", actor: "owner", askId: ask.id, question: ask.message, answer: "accepted" },
  ]);
  await removeAsk(ask.id);
  return `archived ${rows.length} item${rows.length === 1 ? "" : "s"}`;
}

export type Feedback =
  | {
      ts: number;
      kind: "undo";
      actor: Actor;
      itemId: string;
      reverted: Partial<Item>;
    }
  | {
      ts: number;
      kind: "answer";
      actor: Actor;
      askId: string;
      question: string;
      answer: string;
    }
  | { ts: number; kind: "pin"; actor: Actor; itemId: string; pinned: boolean }
  | {
      ts: number;
      kind: "dismiss";
      actor: Actor;
      askId: string;
      question: string;
    };

export async function readAsks(): Promise<Ask[]> {
  return readJsonl<Ask>(ASKS_FILE);
}

export async function addAsk(ask: Omit<Ask, "id" | "ts">): Promise<Ask> {
  const full: Ask = {
    ...ask,
    id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
  };
  await appendJsonl(ASKS_FILE, [full]);
  return full;
}

/**
 * Asks are answered once and never resurface, so removing one rewrites the file.
 * Rewriting is a read-modify-write like any other, so it takes the asks lock —
 * otherwise answering one ask while an agent queues another drops one of them.
 */
export async function removeAsk(askId: string): Promise<void> {
  await withLock("asks", async () => {
    const remaining = (await readAsks()).filter((ask) => ask.id !== askId);
    const tmp = `${ASKS_FILE}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      remaining.map((ask) => JSON.stringify(ask)).join("\n") + (remaining.length ? "\n" : ""),
      "utf8",
    );
    await rename(tmp, ASKS_FILE);
  });
}

export async function readFeedback(since = 0): Promise<Feedback[]> {
  return (await readJsonl<Feedback>(FEEDBACK_FILE)).filter((row) => row.ts >= since);
}

export async function addFeedback(rows: Feedback[]): Promise<void> {
  await appendJsonl(FEEDBACK_FILE, rows);
}

/** Undo the most recent n mutations. Kept as the CLI's entry point. */
export async function undoWithFeedback(n = 1): Promise<UndoResult> {
  return undoLast(n);
}

// ---------------------------------------------------------------------------
// Signals, weights and scoring
// ---------------------------------------------------------------------------

export const SIGNALS_FILE = join(FLOW_DIR, "signals.jsonl");
export const WEIGHTS_FILE = join(FLOW_DIR, "weights.json");
export const ARCHIVE_FILE = join(FLOW_DIR, "archive.jsonl");

export async function readSignals(): Promise<Signal[]> {
  return readJsonl<Signal>(SIGNALS_FILE);
}

export async function addSignal(signal: Omit<Signal, "id" | "ts">): Promise<Signal> {
  const full: Signal = { ...signal, id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() };
  await appendJsonl(SIGNALS_FILE, [full]);
  return full;
}

/**
 * Drops signals that can no longer affect any score, so the file doesn't grow
 * without bound. Kept generous — a signal is cheap and re-deriving one is not.
 */
export async function pruneSignals(weights: Weights, now = Date.now()): Promise<number> {
  return withLock("signals", async () => {
    const signals = await readSignals();
    const horizon = Math.max(weights.decayHalfLifeDays * 8, 30) * 24 * 60 * 60 * 1000;
    const keep = signals.filter((signal) => {
      if (signal.expiresAt !== undefined && now > signal.expiresAt) return false;
      return now - (signal.at ?? signal.ts) < horizon;
    });
    if (keep.length === signals.length) return 0;

    const tmp = `${SIGNALS_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, keep.map((s) => JSON.stringify(s)).join("\n") + (keep.length ? "\n" : ""), "utf8");
    await rename(tmp, SIGNALS_FILE);
    return signals.length - keep.length;
  });
}

export async function loadWeights(): Promise<Weights> {
  try {
    return mergeWeights(JSON.parse(await readFile(WEIGHTS_FILE, "utf8")));
  } catch {
    // Missing or unreadable weights must never stop scoring — fall back to defaults.
    return DEFAULT_WEIGHTS;
  }
}

export async function saveWeights(weights: Weights): Promise<void> {
  await mkdir(FLOW_DIR, { recursive: true });
  await writeFile(WEIGHTS_FILE, JSON.stringify(weights, null, 2) + "\n", "utf8");
}

/** Recomputes every priority from the current signals. Returns how many moved. */
export async function rescore(actor: Actor = "cli", now = Date.now()): Promise<Scored[]> {
  const [signals, weights] = await Promise.all([readSignals(), loadWeights()]);
  const scored = scoreAll(await loadItems(), signals, weights, now);
  const moved = scored.filter((entry) => entry.changed);
  if (moved.length === 0) return scored;

  const next = new Map(moved.map((entry) => [entry.item.id, entry.item]));
  await mutate(actor, (items) => items.map((item) => next.get(item.id) ?? item));
  return scored;
}

// ---------------------------------------------------------------------------
// Archive and cleanup
// ---------------------------------------------------------------------------

export interface ArchiveRow {
  archivedAt: number;
  reason: "project-finished" | "age" | "manual";
  actor: Actor;
  item: Item;
}

export async function readArchive(): Promise<ArchiveRow[]> {
  return readJsonl<ArchiveRow>(ARCHIVE_FILE);
}

/**
 * Removes items from the list, keeping the full record.
 *
 * Archiving is the only operation here that destroys anything, so it writes the
 * items out before touching them and takes a git snapshot first. The archive is
 * append-only and complete — it's the substrate for a later stats project, so
 * nothing is summarised away at this point.
 */
export async function archiveItems(
  ids: string[],
  reason: ArchiveRow["reason"],
  actor: Actor = "cli",
): Promise<ArchiveRow[]> {
  const wanted = new Set(ids);
  const doomed = (await loadItems()).filter((item) => wanted.has(item.id));
  if (doomed.length === 0) return [];

  await snapshot(`before archiving ${doomed.length} item${doomed.length === 1 ? "" : "s"} (${reason})`);

  const rows: ArchiveRow[] = doomed.map((item) => ({ archivedAt: Date.now(), reason, actor, item }));
  await appendJsonl(ARCHIVE_FILE, rows);
  await mutate(actor, (items) => items.filter((item) => !wanted.has(item.id)));
  // And again afterwards, so the repo isn't left dirty and the restore point stays
  // a clean "just before" rather than blurring into whatever happens next.
  await snapshot(`archived ${rows.length} item${rows.length === 1 ? "" : "s"} (${reason})`);
  return rows;
}

export interface TidyProposal {
  reason: ArchiveRow["reason"];
  project?: string;
  itemIds: string[];
  openIds: string[];
  message: string;
}

/**
 * Looks for work that has quietly finished.
 *
 * Two triggers, both the owner's: a project where everything is done and nothing
 * new has arrived in a while, and done items old enough that nobody is coming back
 * to them. Neither one archives anything — they produce a proposal, because a list
 * disappearing without being asked is exactly the heaviness this avoids.
 */
export async function tidyProposals(quietDays = 21, ageDays = 90, now = Date.now()): Promise<TidyProposal[]> {
  const items = await loadItems();
  const proposals: TidyProposal[] = [];
  const day = 24 * 60 * 60 * 1000;

  const projects = new Map<string, Item[]>();
  for (const item of items) {
    if (!item.project) continue;
    const list = projects.get(item.project);
    if (list) list.push(item);
    else projects.set(item.project, [item]);
  }

  for (const [project, group] of projects) {
    const done = group.filter((item) => item.status === "done");
    const open = group.filter((item) => item.status === "todo");
    if (done.length === 0) continue;
    const newest = Math.max(...group.map((item) => item.createdAt));
    if (now - newest < quietDays * day) continue;
    // Mostly finished: a couple of stragglers is still "finished enough" to ask about.
    if (open.length > Math.max(2, group.length * 0.25)) continue;

    proposals.push({
      reason: "project-finished",
      project,
      itemIds: done.map((item) => item.id),
      openIds: open.map((item) => item.id),
      message:
        open.length === 0
          ? `#${project} looks finished — ${done.length} done, nothing new in ${Math.floor((now - newest) / day)} days. Archive it?`
          : `#${project} looks finished apart from ${open.length} straggler${open.length === 1 ? "" : "s"} — archive the ${done.length} done item${done.length === 1 ? "" : "s"}?`,
    });
  }

  const claimed = new Set(proposals.flatMap((proposal) => proposal.itemIds));
  const aged = items.filter(
    (item) => item.status === "done" && !claimed.has(item.id) && now - (item.doneAt ?? item.createdAt) > ageDays * day,
  );
  if (aged.length > 0) {
    proposals.push({
      reason: "age",
      itemIds: aged.map((item) => item.id),
      openIds: [],
      message: `${aged.length} item${aged.length === 1 ? "" : "s"} finished more than ${ageDays} days ago. Archive them?`,
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * Commits the current state of ~/.flow.
 *
 * Deliberately not called on capture. That path has to stay instant, and it is the
 * one thing the whole project is organised around — so snapshots happen at agent
 * runs and immediately before anything destructive, where a restore point is
 * actually worth having.
 */
export async function snapshot(message: string): Promise<boolean> {
  const git = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn("git", ["-C", FLOW_DIR, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
      child.on("error", () => resolve({ code: 1, out: "git not available" }));
    });

  if ((await git(["rev-parse", "--git-dir"])).code !== 0) return false;
  if ((await git(["status", "--porcelain"])).out.trim().length === 0) return false;

  await git(["add", "-A"]);
  // -c keeps this working even where the user has no global git identity set.
  const result = await git(["-c", "user.name=Flow", "-c", "user.email=flow@localhost", "commit", "-m", message]);
  return result.code === 0;
}

/** Turns ~/.flow into a git repo. Idempotent. */
export async function initGit(): Promise<boolean> {
  await mkdir(FLOW_DIR, { recursive: true });
  const ignore = ["*.tmp", "*.lock", "inbox.draining", ".last-prioritize", "items.json.corrupt-*", ""].join("\n");
  await writeFile(join(FLOW_DIR, ".gitignore"), ignore, "utf8");

  const run = (args: string[]) =>
    new Promise<number>((resolve) => {
      const child = spawn("git", ["-C", FLOW_DIR, ...args], { stdio: "ignore" });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });

  if ((await run(["rev-parse", "--git-dir"])) === 0) return false;
  if ((await run(["init", "-q"])) !== 0) return false;
  await snapshot("flow: initial snapshot");
  return true;
}
