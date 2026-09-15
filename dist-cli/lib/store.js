"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARCHIVE_FILE = exports.WEIGHTS_FILE = exports.SIGNALS_FILE = exports.ASKS_FILE = exports.FEEDBACK_FILE = exports.INBOX_FILE = exports.JOURNAL_FILE = exports.ITEMS_FILE = exports.FLOW_DIR = void 0;
exports.appendJsonl = appendJsonl;
exports.readJsonl = readJsonl;
exports.loadItems = loadItems;
exports.mutate = mutate;
exports.addItem = addItem;
exports.importItems = importItems;
exports.readJournal = readJournal;
exports.undoGroup = undoGroup;
exports.undoLast = undoLast;
exports.agentChangesSince = agentChangesSince;
exports.describeChange = describeChange;
exports.drainInbox = drainInbox;
exports.acceptAsk = acceptAsk;
exports.readAsks = readAsks;
exports.addAsk = addAsk;
exports.removeAsk = removeAsk;
exports.readFeedback = readFeedback;
exports.addFeedback = addFeedback;
exports.undoWithFeedback = undoWithFeedback;
exports.readSignals = readSignals;
exports.addSignal = addSignal;
exports.pruneSignals = pruneSignals;
exports.loadWeights = loadWeights;
exports.saveWeights = saveWeights;
exports.rescore = rescore;
exports.readArchive = readArchive;
exports.archiveItems = archiveItems;
exports.tidyProposals = tidyProposals;
exports.snapshot = snapshot;
exports.initGit = initGit;
const promises_1 = require("fs/promises");
const child_process_1 = require("child_process");
const os_1 = require("os");
const path_1 = require("path");
const item_1 = require("./item");
// Re-exported so every existing `from "./lib/store"` import keeps working.
__exportStar(require("./item"), exports);
const score_1 = require("./score");
const VERSION = 2;
exports.FLOW_DIR = (0, path_1.join)((0, os_1.homedir)(), ".flow");
exports.ITEMS_FILE = (0, path_1.join)(exports.FLOW_DIR, "items.json");
exports.JOURNAL_FILE = (0, path_1.join)(exports.FLOW_DIR, "journal.jsonl");
exports.INBOX_FILE = (0, path_1.join)(exports.FLOW_DIR, "inbox.jsonl");
exports.FEEDBACK_FILE = (0, path_1.join)(exports.FLOW_DIR, "feedback.jsonl");
exports.ASKS_FILE = (0, path_1.join)(exports.FLOW_DIR, "asks.jsonl");
// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
/**
 * Appends to a .jsonl file. Small writes opened with O_APPEND land whole, so
 * agents and the extension can both write without coordinating.
 */
async function appendJsonl(file, rows) {
    if (rows.length === 0)
        return;
    await (0, promises_1.mkdir)(exports.FLOW_DIR, { recursive: true });
    await (0, promises_1.appendFile)(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}
/** Reads a .jsonl file. A missing file is empty; a malformed line is skipped, not fatal. */
async function readJsonl(file) {
    let raw;
    try {
        raw = await (0, promises_1.readFile)(file, "utf8");
    }
    catch {
        return [];
    }
    const rows = [];
    for (const line of raw.split("\n")) {
        if (line.trim().length === 0)
            continue;
        try {
            rows.push(JSON.parse(line));
        }
        catch {
            // A hand-mangled line shouldn't cost us the rest of the file.
        }
    }
    return rows;
}
async function loadItems() {
    let raw;
    try {
        raw = await (0, promises_1.readFile)(exports.ITEMS_FILE, "utf8");
    }
    catch {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        // Tolerate a bare array so a hand-edited or v1-shaped file still opens.
        if (Array.isArray(parsed))
            return parsed;
        if (parsed !== null && typeof parsed === "object") {
            const items = parsed.items;
            if (Array.isArray(items))
                return items;
        }
        await quarantine();
        return [];
    }
    catch {
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
async function quarantine() {
    try {
        // Rename rather than copy, so the next read finds nothing and we don't pile
        // up a new quarantine file on every attempt.
        await (0, promises_1.rename)(exports.ITEMS_FILE, `${exports.ITEMS_FILE}.corrupt-${Date.now()}`);
    }
    catch {
        // Best effort. Never block opening the list on this.
    }
}
/**
 * Writes items atomically: a uniquely named temp file, then rename over the
 * target. Rename is atomic on one filesystem, so a reader mid-write gets the
 * old file or the new one, never a truncated one. The temp name carries the
 * pid so two writers can't collide on it.
 */
async function writeItems(items) {
    await (0, promises_1.mkdir)(exports.FLOW_DIR, { recursive: true });
    const tmp = `${exports.ITEMS_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await (0, promises_1.writeFile)(tmp, JSON.stringify({ version: VERSION, items }, null, 2), "utf8");
    await (0, promises_1.rename)(tmp, exports.ITEMS_FILE);
}
// ---------------------------------------------------------------------------
// The one write path
// ---------------------------------------------------------------------------
const FIELDS = [
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
function same(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
/** Only the fields that actually moved, so the journal stays readable. */
function changed(prev, next) {
    const before = {};
    const after = {};
    for (const field of FIELDS) {
        if (same(prev[field], next[field]))
            continue;
        before[field] = prev[field] ?? null;
        after[field] = next[field] ?? null;
    }
    return { before, after };
}
function diff(actor, before, after, ts, undoOf) {
    const was = new Map(before.map((item) => [item.id, item]));
    const is = new Map(after.map((item) => [item.id, item]));
    const entries = [];
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
async function mutate(actor, apply, undoOf) {
    const before = await loadItems();
    const after = apply(before);
    const ts = Date.now();
    const entries = diff(actor, before, after, ts, undoOf);
    if (entries.length === 0)
        return before;
    await writeItems(after);
    await appendJsonl(exports.JOURNAL_FILE, entries);
    return after;
}
async function addItem(input, actor = "owner", extra) {
    const item = { ...(0, item_1.parse)(input), ...extra };
    await mutate(actor, (items) => [item, ...items]);
    return item;
}
/** Bulk insert that keeps the given ids and timestamps. Used by the one-time migration. */
async function importItems(incoming, actor = "migration") {
    return mutate(actor, (items) => {
        const known = new Set(items.map((item) => item.id));
        return [...incoming.filter((item) => !known.has(item.id)), ...items];
    });
}
async function readJournal() {
    return readJsonl(exports.JOURNAL_FILE);
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
function undoableGroups(journal) {
    const reversed = new Set();
    for (const entry of journal)
        if (entry.undoOf)
            reversed.add(entry.undoOf);
    const groups = new Map();
    for (const entry of journal) {
        if (entry.undoOf || reversed.has(entry.ts))
            continue;
        const group = groups.get(entry.ts);
        if (group)
            group.push(entry);
        else
            groups.set(entry.ts, [entry]);
    }
    return groups;
}
function reverse(entries, items) {
    let next = items;
    for (const entry of entries) {
        if (entry.op === "add") {
            next = next.filter((item) => item.id !== entry.id);
        }
        else if (entry.op === "remove" && entry.before) {
            next = [entry.before, ...next.filter((item) => item.id !== entry.id)];
        }
        else if (entry.op === "update" && entry.before) {
            const restore = entry.before;
            next = next.map((item) => {
                if (item.id !== entry.id)
                    return item;
                const merged = { ...item };
                for (const [field, value] of Object.entries(restore)) {
                    if (value === null)
                        delete merged[field];
                    else
                        merged[field] = value;
                }
                return merged;
            });
        }
    }
    return next;
}
/**
 * Reverses one specific mutation, identified by its journal ts.
 *
 * Targeting a single change is what lets the owner reject one agent decision
 * without discarding the rest, and it records the rejection in feedback.jsonl.
 * That record is the only reason unrestricted agent writes are workable — undo
 * is how the owner says no, and the agent is required to read it.
 */
async function undoGroup(ts) {
    const journal = await readJournal();
    const group = journal.filter((entry) => entry.ts === ts && !entry.undoOf);
    if (group.length === 0)
        return { undone: 0, entries: [] };
    await mutate("owner", (items) => reverse(group, items), ts);
    await addFeedback(group
        .filter((entry) => entry.actor !== "owner" && entry.actor !== "migration")
        .map((entry) => ({
        ts: Date.now(),
        kind: "undo",
        actor: "owner",
        itemId: entry.id,
        reverted: (entry.after ?? {}),
    })));
    return { undone: 1, entries: group };
}
/** Reverses the most recent n mutations, newest first. */
async function undoLast(n = 1) {
    const journal = await readJournal();
    const timestamps = [...undoableGroups(journal).keys()].sort((a, b) => b - a).slice(0, n);
    const entries = [];
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
async function agentChangesSince(since) {
    const journal = await readJournal();
    const reversed = new Set();
    for (const entry of journal)
        if (entry.undoOf)
            reversed.add(entry.undoOf);
    return journal
        .filter((entry) => entry.ts > since && entry.actor.startsWith("agent:") && !entry.undoOf && !reversed.has(entry.ts))
        .sort((a, b) => b.ts - a.ts);
}
/** A short phrase for what one journal entry did, for the list subtitle. */
function describeChange(entry) {
    const who = entry.actor.replace("agent:", "");
    if (entry.op === "add")
        return `added by ${who}`;
    if (entry.op === "remove")
        return `removed by ${who}`;
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
async function drainInbox() {
    const draining = (0, path_1.join)(exports.FLOW_DIR, "inbox.draining");
    try {
        await (0, promises_1.rename)(exports.INBOX_FILE, draining);
    }
    catch {
        // No inbox, or someone else got there first. Either way there's nothing to do.
        return [];
    }
    let raw;
    try {
        raw = await (0, promises_1.readFile)(draining, "utf8");
    }
    catch {
        return [];
    }
    const captured = [];
    for (const line of raw.split("\n")) {
        const text = line.trim();
        if (text.length === 0)
            continue;
        // A line may be a bare string or a JSON-quoted one. Both are fine.
        let input = text;
        if (text.startsWith('"')) {
            try {
                const decoded = JSON.parse(text);
                if (typeof decoded === "string")
                    input = decoded;
            }
            catch {
                // Not valid JSON — take it literally rather than dropping the thought.
            }
        }
        captured.push((0, item_1.parse)(input));
    }
    if (captured.length > 0) {
        await mutate("inbox", (items) => [...captured, ...items]);
    }
    await (0, promises_1.unlink)(draining).catch(() => undefined);
    return captured;
}
/** Carries out an accepted ask. Returns a line describing what happened. */
async function acceptAsk(ask) {
    if (!ask.action)
        return "nothing to do";
    const rows = await archiveItems(ask.action.itemIds, ask.action.reason, "owner");
    await addFeedback([
        { ts: Date.now(), kind: "answer", actor: "owner", askId: ask.id, question: ask.message, answer: "accepted" },
    ]);
    await removeAsk(ask.id);
    return `archived ${rows.length} item${rows.length === 1 ? "" : "s"}`;
}
async function readAsks() {
    return readJsonl(exports.ASKS_FILE);
}
async function addAsk(ask) {
    const full = {
        ...ask,
        id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
    };
    await appendJsonl(exports.ASKS_FILE, [full]);
    return full;
}
/**
 * Asks are answered once and never resurface, so removing one rewrites the file.
 * It's the only non-append write outside items.json, and it's small.
 */
async function removeAsk(askId) {
    const remaining = (await readAsks()).filter((ask) => ask.id !== askId);
    await (0, promises_1.mkdir)(exports.FLOW_DIR, { recursive: true });
    const tmp = `${exports.ASKS_FILE}.${process.pid}.tmp`;
    await (0, promises_1.writeFile)(tmp, remaining.map((ask) => JSON.stringify(ask)).join("\n") + (remaining.length ? "\n" : ""), "utf8");
    await (0, promises_1.rename)(tmp, exports.ASKS_FILE);
}
async function readFeedback(since = 0) {
    return (await readJsonl(exports.FEEDBACK_FILE)).filter((row) => row.ts >= since);
}
async function addFeedback(rows) {
    await appendJsonl(exports.FEEDBACK_FILE, rows);
}
/** Undo the most recent n mutations. Kept as the CLI's entry point. */
async function undoWithFeedback(n = 1) {
    return undoLast(n);
}
// ---------------------------------------------------------------------------
// Signals, weights and scoring
// ---------------------------------------------------------------------------
exports.SIGNALS_FILE = (0, path_1.join)(exports.FLOW_DIR, "signals.jsonl");
exports.WEIGHTS_FILE = (0, path_1.join)(exports.FLOW_DIR, "weights.json");
exports.ARCHIVE_FILE = (0, path_1.join)(exports.FLOW_DIR, "archive.jsonl");
async function readSignals() {
    return readJsonl(exports.SIGNALS_FILE);
}
async function addSignal(signal) {
    const full = { ...signal, id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() };
    await appendJsonl(exports.SIGNALS_FILE, [full]);
    return full;
}
/**
 * Drops signals that can no longer affect any score, so the file doesn't grow
 * without bound. Kept generous — a signal is cheap and re-deriving one is not.
 */
async function pruneSignals(weights, now = Date.now()) {
    const signals = await readSignals();
    const horizon = Math.max(weights.decayHalfLifeDays * 8, 30) * 24 * 60 * 60 * 1000;
    const keep = signals.filter((signal) => {
        if (signal.expiresAt !== undefined && now > signal.expiresAt)
            return false;
        return now - (signal.at ?? signal.ts) < horizon;
    });
    if (keep.length === signals.length)
        return 0;
    await (0, promises_1.mkdir)(exports.FLOW_DIR, { recursive: true });
    const tmp = `${exports.SIGNALS_FILE}.${process.pid}.tmp`;
    await (0, promises_1.writeFile)(tmp, keep.map((s) => JSON.stringify(s)).join("\n") + (keep.length ? "\n" : ""), "utf8");
    await (0, promises_1.rename)(tmp, exports.SIGNALS_FILE);
    return signals.length - keep.length;
}
async function loadWeights() {
    try {
        return (0, score_1.mergeWeights)(JSON.parse(await (0, promises_1.readFile)(exports.WEIGHTS_FILE, "utf8")));
    }
    catch {
        // Missing or unreadable weights must never stop scoring — fall back to defaults.
        return score_1.DEFAULT_WEIGHTS;
    }
}
async function saveWeights(weights) {
    await (0, promises_1.mkdir)(exports.FLOW_DIR, { recursive: true });
    await (0, promises_1.writeFile)(exports.WEIGHTS_FILE, JSON.stringify(weights, null, 2) + "\n", "utf8");
}
/** Recomputes every priority from the current signals. Returns how many moved. */
async function rescore(actor = "cli", now = Date.now()) {
    const [signals, weights] = await Promise.all([readSignals(), loadWeights()]);
    const scored = (0, score_1.scoreAll)(await loadItems(), signals, weights, now);
    const moved = scored.filter((entry) => entry.changed);
    if (moved.length === 0)
        return scored;
    const next = new Map(moved.map((entry) => [entry.item.id, entry.item]));
    await mutate(actor, (items) => items.map((item) => next.get(item.id) ?? item));
    return scored;
}
async function readArchive() {
    return readJsonl(exports.ARCHIVE_FILE);
}
/**
 * Removes items from the list, keeping the full record.
 *
 * Archiving is the only operation here that destroys anything, so it writes the
 * items out before touching them and takes a git snapshot first. The archive is
 * append-only and complete — it's the substrate for a later stats project, so
 * nothing is summarised away at this point.
 */
async function archiveItems(ids, reason, actor = "cli") {
    const wanted = new Set(ids);
    const doomed = (await loadItems()).filter((item) => wanted.has(item.id));
    if (doomed.length === 0)
        return [];
    await snapshot(`before archiving ${doomed.length} item${doomed.length === 1 ? "" : "s"} (${reason})`);
    const rows = doomed.map((item) => ({ archivedAt: Date.now(), reason, actor, item }));
    await appendJsonl(exports.ARCHIVE_FILE, rows);
    await mutate(actor, (items) => items.filter((item) => !wanted.has(item.id)));
    // And again afterwards, so the repo isn't left dirty and the restore point stays
    // a clean "just before" rather than blurring into whatever happens next.
    await snapshot(`archived ${rows.length} item${rows.length === 1 ? "" : "s"} (${reason})`);
    return rows;
}
/**
 * Looks for work that has quietly finished.
 *
 * Two triggers, both the owner's: a project where everything is done and nothing
 * new has arrived in a while, and done items old enough that nobody is coming back
 * to them. Neither one archives anything — they produce a proposal, because a list
 * disappearing without being asked is exactly the heaviness this avoids.
 */
async function tidyProposals(quietDays = 21, ageDays = 90, now = Date.now()) {
    const items = await loadItems();
    const proposals = [];
    const day = 24 * 60 * 60 * 1000;
    const projects = new Map();
    for (const item of items) {
        if (!item.project)
            continue;
        const list = projects.get(item.project);
        if (list)
            list.push(item);
        else
            projects.set(item.project, [item]);
    }
    for (const [project, group] of projects) {
        const done = group.filter((item) => item.status === "done");
        const open = group.filter((item) => item.status === "todo");
        if (done.length === 0)
            continue;
        const newest = Math.max(...group.map((item) => item.createdAt));
        if (now - newest < quietDays * day)
            continue;
        // Mostly finished: a couple of stragglers is still "finished enough" to ask about.
        if (open.length > Math.max(2, group.length * 0.25))
            continue;
        proposals.push({
            reason: "project-finished",
            project,
            itemIds: done.map((item) => item.id),
            openIds: open.map((item) => item.id),
            message: open.length === 0
                ? `#${project} looks finished — ${done.length} done, nothing new in ${Math.floor((now - newest) / day)} days. Archive it?`
                : `#${project} looks finished apart from ${open.length} straggler${open.length === 1 ? "" : "s"} — archive the ${done.length} done item${done.length === 1 ? "" : "s"}?`,
        });
    }
    const claimed = new Set(proposals.flatMap((proposal) => proposal.itemIds));
    const aged = items.filter((item) => item.status === "done" && !claimed.has(item.id) && now - (item.doneAt ?? item.createdAt) > ageDays * day);
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
async function snapshot(message) {
    const git = (args) => new Promise((resolve) => {
        const child = (0, child_process_1.spawn)("git", ["-C", exports.FLOW_DIR, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (out += chunk));
        child.on("close", (code) => resolve({ code: code ?? 1, out }));
        child.on("error", () => resolve({ code: 1, out: "git not available" }));
    });
    if ((await git(["rev-parse", "--git-dir"])).code !== 0)
        return false;
    if ((await git(["status", "--porcelain"])).out.trim().length === 0)
        return false;
    await git(["add", "-A"]);
    // -c keeps this working even where the user has no global git identity set.
    const result = await git(["-c", "user.name=Flow", "-c", "user.email=flow@localhost", "commit", "-m", message]);
    return result.code === 0;
}
/** Turns ~/.flow into a git repo. Idempotent. */
async function initGit() {
    await (0, promises_1.mkdir)(exports.FLOW_DIR, { recursive: true });
    const ignore = ["*.tmp", "inbox.draining", ".last-prioritize", "items.json.corrupt-*", ""].join("\n");
    await (0, promises_1.writeFile)((0, path_1.join)(exports.FLOW_DIR, ".gitignore"), ignore, "utf8");
    const run = (args) => new Promise((resolve) => {
        const child = (0, child_process_1.spawn)("git", ["-C", exports.FLOW_DIR, ...args], { stdio: "ignore" });
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", () => resolve(1));
    });
    if ((await run(["rev-parse", "--git-dir"])) === 0)
        return false;
    if ((await run(["init", "-q"])) !== 0)
        return false;
    await snapshot("flow: initial snapshot");
    return true;
}
