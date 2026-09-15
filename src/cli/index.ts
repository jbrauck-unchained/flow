import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import {
  Actor,
  Ask,
  FLOW_DIR,
  Item,
  WEIGHTS_FILE,
  acceptAsk,
  addAsk,
  addFeedback,
  addItem,
  addSignal,
  archiveItems,
  drainInbox,
  initGit,
  loadItems,
  loadWeights,
  matches,
  mutate,
  pruneSignals,
  readAsks,
  readFeedback,
  readSignals,
  removeAsk,
  rescore,
  saveWeights,
  snapshot,
  tidyProposals,
  undoWithFeedback,
} from "../lib/store";
import { DEFAULT_WEIGHTS, scoreItem } from "../lib/score";
import { AGENTS_MD } from "./agents-md";

const STALE_MS = 14 * 24 * 60 * 60 * 1000;

// Replaced by the bundler. The installed binary is a copy, so it can silently
// drift from source — this is how you tell.
declare const __FLOW_BUILT__: string;
const BUILT = typeof __FLOW_BUILT__ === "string" ? __FLOW_BUILT__ : "dev";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[arg.slice(2)] = argv[++i];
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { positional, flags };
}

/**
 * Who this invocation is acting as. Agents should identify themselves so their
 * writes are distinguishable from the owner's in the journal — that's what the
 * "changed since you last looked" view in the extension keys off.
 */
function actorFrom(flags: Args["flags"]): Actor {
  const raw = (typeof flags.actor === "string" && flags.actor) || process.env.FLOW_ACTOR;
  if (!raw) return "cli";
  if (raw === "owner" || raw === "cli") return raw;
  return raw.startsWith("agent:") ? (raw as Actor) : (`agent:${raw}` as Actor);
}

function fail(message: string): never {
  process.stderr.write(`flow: ${message}\n`);
  process.exit(1);
}

/** Ids are long; agents shouldn't have to echo them exactly. Unique prefixes resolve. */
function resolve(items: Item[], needle: string): Item {
  const exact = items.find((item) => item.id === needle);
  if (exact) return exact;
  const hits = items.filter((item) => item.id.startsWith(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) fail(`no item matching '${needle}'`);
  fail(`'${needle}' matches ${hits.length} items — use a longer id`);
}

function isStale(item: Item): boolean {
  return item.status === "todo" && Date.now() - item.createdAt > STALE_MS;
}

function line(item: Item): string {
  const bits = [item.status === "done" ? "x" : " ", item.id.padEnd(20)];
  if (item.priority !== undefined) bits.push(item.priority.toFixed(2));
  else bits.push("    ");
  bits.push(item.title);
  if (item.project) bits.push(`#${item.project}`);
  for (const tag of item.tags) bits.push(`@${tag}`);
  if (item.pinned) bits.push("[pinned]");
  if (isStale(item)) bits.push("[stale]");
  const head = `[${bits[0]}] ${bits.slice(1).join(" ")}`;
  return item.why ? `${head}\n       ↳ ${item.why}` : head;
}

const SETTABLE = [
  "priority",
  "why",
  "cluster",
  "source",
  "pinned",
  "title",
  "description",
  "project",
  "status",
] as const;

function coerce(field: string, raw: string): unknown {
  if (field === "priority") {
    const value = Number(raw);
    if (Number.isNaN(value) || value < 0 || value > 1) fail("priority must be a number from 0 to 1");
    return value;
  }
  if (field === "pinned") return raw !== "false" && raw !== "0";
  if (field === "status") {
    if (raw !== "todo" && raw !== "done") fail("status must be 'todo' or 'done'");
    return raw;
  }
  return raw;
}

const USAGE = `flow — agent-native capture

  flow add <text> [--source S] [--json]
  flow list [--json] [--status todo|done|all] [--project P] [--cluster C]
            [--stale] [--search Q] [--limit N]
  flow set <id> <field> <value> [--why W]     fields: ${SETTABLE.join(", ")}
  flow done <id>                              flow rm <id>
  flow pin <id> [--off]
  flow ask <question> [--item ID] [--options a,b]
  flow suggest <message> --items id1,id2
  flow asks [--json]                          flow answer <askId> <answer>
  flow feedback [--since TS] [--json]
  flow undo [n]

  flow signal <kind> <note> [--project P] [--tags a,b] [--items id1,id2]
              [--at ISO] [--source S] [--weight 0..1] [--expires ISO]
  flow score [--explain] [--dry]              recompute priorities from signals
  flow signals [--json]                       flow weights [--json]
  flow tidy [--propose] [--json]              find work that has quietly finished
  flow archive <id...> [--reason R]           flow accept <askId>
  flow snapshot [-m MESSAGE]                  commit ~/.flow
  flow init                                   contract, weights, git repo
  flow version                                which build is installed

  --actor agent:<name>   identify yourself (or set FLOW_ACTOR)
`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const actor = actorFrom(flags);
  const json = flags.json === true || flags.json === "true";
  const out = (text: string) => process.stdout.write(text + "\n");

  switch (command) {
    case "add": {
      const text = rest.join(" ").trim();
      if (!text) fail("nothing to add");
      const extra: Partial<Item> = {};
      if (typeof flags.source === "string") extra.source = flags.source;
      const item = await addItem(text, actor, extra);
      out(json ? JSON.stringify(item) : `added ${item.id}`);
      return;
    }

    case "list": {
      await drainInbox();
      let items = await loadItems();
      const status = typeof flags.status === "string" ? flags.status : "todo";
      if (status !== "all") items = items.filter((item) => item.status === status);
      if (typeof flags.project === "string") items = items.filter((item) => item.project === flags.project);
      if (typeof flags.cluster === "string") items = items.filter((item) => item.cluster === flags.cluster);
      if (typeof flags.search === "string") items = items.filter((item) => matches(item, flags.search as string));
      if (flags.stale) items = items.filter(isStale);
      items = sorted(items);
      if (typeof flags.limit === "string") items = items.slice(0, Number(flags.limit));
      out(json ? JSON.stringify(items, null, 2) : items.map(line).join("\n") || "(nothing)");
      return;
    }

    case "set": {
      const [needle, field, ...value] = rest;
      if (!needle || !field) fail("usage: flow set <id> <field> <value>");
      if (!(SETTABLE as readonly string[]).includes(field)) {
        fail(`cannot set '${field}' — try one of: ${SETTABLE.join(", ")}`);
      }
      const item = resolve(await loadItems(), needle);
      const patch: Record<string, unknown> = {
        [field]: coerce(field, value.join(" ")),
      };
      if (typeof flags.why === "string") patch.why = flags.why;
      if (actor.startsWith("agent:")) patch.agentTouchedAt = Date.now();
      await mutate(actor, (items) => items.map((c) => (c.id === item.id ? ({ ...c, ...patch } as Item) : c)));
      out(json ? JSON.stringify({ id: item.id, ...patch }) : `set ${field} on ${item.id}`);
      return;
    }

    case "done":
    case "rm": {
      const item = resolve(await loadItems(), rest[0] ?? fail("usage: flow " + command + " <id>"));
      await mutate(actor, (items) =>
        command === "rm"
          ? items.filter((c) => c.id !== item.id)
          : items.map((c) => (c.id === item.id ? { ...c, status: "done" as const, doneAt: Date.now() } : c)),
      );
      out(`${command === "rm" ? "removed" : "done"} ${item.id}`);
      return;
    }

    case "pin": {
      const item = resolve(await loadItems(), rest[0] ?? fail("usage: flow pin <id>"));
      const pinned = !flags.off;
      await mutate(actor, (items) => items.map((c) => (c.id === item.id ? { ...c, pinned } : c)));
      await addFeedback([{ ts: Date.now(), kind: "pin", actor, itemId: item.id, pinned }]);
      out(`${pinned ? "pinned" : "unpinned"} ${item.id}`);
      return;
    }

    case "ask":
    case "suggest": {
      const message = rest.join(" ").trim();
      if (!message) fail(`usage: flow ${command} <message>`);
      const itemIds = typeof flags.items === "string" ? flags.items.split(",").map((s) => s.trim()) : undefined;
      const single = typeof flags.item === "string" ? [flags.item] : undefined;
      const ask = await addAsk({
        kind: command === "ask" ? "question" : "suggestion",
        actor,
        message,
        ...(itemIds || single ? { itemIds: itemIds ?? single } : {}),
        ...(typeof flags.options === "string" ? { options: flags.options.split(",").map((s) => s.trim()) } : {}),
      });
      out(json ? JSON.stringify(ask) : `${command} queued as ${ask.id}`);
      return;
    }

    case "asks": {
      const asks = await readAsks();
      out(json ? JSON.stringify(asks, null, 2) : asks.map((a: Ask) => `${a.id}  ${a.message}`).join("\n") || "(none)");
      return;
    }

    case "answer": {
      const [askId, ...answer] = rest;
      if (!askId || answer.length === 0) fail("usage: flow answer <askId> <answer>");
      const ask = (await readAsks()).find((a) => a.id === askId || a.id.startsWith(askId));
      if (!ask) fail(`no ask matching '${askId}'`);
      await addFeedback([
        {
          ts: Date.now(),
          kind: "answer",
          actor: "owner",
          askId: ask.id,
          question: ask.message,
          answer: answer.join(" "),
        },
      ]);
      await removeAsk(ask.id);
      out(`answered ${ask.id}`);
      return;
    }

    case "feedback": {
      const since = typeof flags.since === "string" ? Number(flags.since) : 0;
      const rows = await readFeedback(since);
      out(json ? JSON.stringify(rows, null, 2) : rows.map((r) => JSON.stringify(r)).join("\n") || "(none)");
      return;
    }

    case "undo": {
      const n = rest[0] ? Number(rest[0]) : 1;
      const result = await undoWithFeedback(n);
      out(result.undone === 0 ? "nothing to undo" : `undid ${result.undone} change${result.undone === 1 ? "" : "s"}`);
      return;
    }

    case "signal": {
      const [kind, ...note] = rest;
      if (!kind || note.length === 0) fail("usage: flow signal <kind> <note>");
      const at = typeof flags.at === "string" ? Date.parse(flags.at) : undefined;
      if (at !== undefined && Number.isNaN(at)) fail("--at must be a parseable date");
      const expiresAt = typeof flags.expires === "string" ? Date.parse(flags.expires) : undefined;
      if (expiresAt !== undefined && Number.isNaN(expiresAt)) fail("--expires must be a parseable date");

      const signal = await addSignal({
        kind,
        note: note.join(" "),
        source: typeof flags.source === "string" ? flags.source : actor,
        ...(typeof flags.project === "string" ? { project: flags.project } : {}),
        ...(typeof flags.tags === "string" ? { tags: flags.tags.split(",").map((t) => t.trim()) } : {}),
        ...(typeof flags.items === "string" ? { itemIds: flags.items.split(",").map((t) => t.trim()) } : {}),
        ...(typeof flags.cluster === "string" ? { cluster: flags.cluster } : {}),
        ...(typeof flags.match === "string" ? { match: flags.match } : {}),
        ...(typeof flags.weight === "string" ? { weight: Number(flags.weight) } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      out(json ? JSON.stringify(signal) : `recorded ${signal.kind} signal ${signal.id}`);
      return;
    }

    case "signals": {
      const signals = await readSignals();
      out(
        json
          ? JSON.stringify(signals, null, 2)
          : signals.map((s) => `${s.id}  ${s.kind.padEnd(10)} ${s.note}`).join("\n") || "(none)",
      );
      return;
    }

    case "weights": {
      const weights = await loadWeights();
      out(JSON.stringify(weights, null, 2));
      if (!json) out(`\n# tune these in ${FLOW_DIR}/weights.json, then run: flow score`);
      return;
    }

    case "score": {
      const weights = await loadWeights();
      if (flags.explain) {
        const signals = await readSignals();
        const items = (await loadItems()).filter((item) => item.status === "todo");
        for (const item of items) {
          const score = scoreItem(item, signals, weights);
          if (score.contributions.length === 0 && score.priority === 0) continue;
          out(`${score.priority.toFixed(2)}  ${item.title}`);
          for (const contribution of score.contributions) {
            out(`        +${contribution.amount.toFixed(2)}  ${contribution.signal.kind}: ${contribution.signal.note}`);
          }
        }
        return;
      }
      if (flags.dry) {
        out(JSON.stringify(await loadItems(), null, 2));
        return;
      }
      const pruned = await pruneSignals(weights);
      const scored = await rescore(actor);
      const moved = scored.filter((entry) => entry.changed).length;
      out(
        `rescored ${moved} item${moved === 1 ? "" : "s"}${pruned ? `, pruned ${pruned} spent signal${pruned === 1 ? "" : "s"}` : ""}`,
      );
      return;
    }

    case "tidy": {
      const proposals = await tidyProposals();
      if (json) {
        out(JSON.stringify(proposals, null, 2));
        return;
      }
      if (proposals.length === 0) {
        out("nothing looks finished");
        return;
      }
      for (const proposal of proposals) {
        if (flags.propose) {
          const ask = await addAsk({
            kind: "suggestion",
            actor,
            message: proposal.message,
            ...(proposal.openIds.length > 0 ? { itemIds: proposal.openIds } : {}),
            action: { kind: "archive", itemIds: proposal.itemIds, reason: proposal.reason },
          });
          out(`proposed ${ask.id}: ${proposal.message}`);
        } else {
          out(`${proposal.message} (${proposal.itemIds.length} item${proposal.itemIds.length === 1 ? "" : "s"})`);
        }
      }
      return;
    }

    case "archive": {
      if (rest.length === 0) fail("usage: flow archive <id...>");
      const items = await loadItems();
      const ids = rest.map((needle) => resolve(items, needle).id);
      const reason = typeof flags.reason === "string" ? flags.reason : "manual";
      const rows = await archiveItems(ids, reason as "manual", actor);
      out(`archived ${rows.length} item${rows.length === 1 ? "" : "s"}`);
      return;
    }

    case "accept": {
      const askId = rest[0] ?? fail("usage: flow accept <askId>");
      const ask = (await readAsks()).find((a) => a.id === askId || a.id.startsWith(askId));
      if (!ask) fail(`no ask matching '${askId}'`);
      out(await acceptAsk(ask));
      return;
    }

    case "snapshot": {
      const message = typeof flags.m === "string" ? flags.m : rest.join(" ") || "flow: snapshot";
      out((await snapshot(message)) ? "committed" : "nothing to commit");
      return;
    }

    case "version": {
      out(`flow (built ${BUILT})`);
      return;
    }

    case "init": {
      await mkdir(FLOW_DIR, { recursive: true });
      const target = join(FLOW_DIR, "AGENTS.md");
      await writeFile(target, AGENTS_MD, "utf8");
      out(`wrote ${target}`);

      try {
        await readFile(WEIGHTS_FILE, "utf8");
      } catch {
        await saveWeights(DEFAULT_WEIGHTS);
        out(`wrote ${WEIGHTS_FILE}`);
      }

      if (await initGit()) out(`initialised git repo in ${FLOW_DIR}`);
      return;
    }

    default:
      process.stdout.write(USAGE);
      process.exit(command === undefined || command === "help" || flags.help ? 0 : 1);
  }
}

/** Same order the extension shows: pinned, then priority, then stale, then newest. */
function sorted(items: Item[]): Item[] {
  return [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const pa = a.priority ?? -1;
    const pb = b.priority ?? -1;
    if (pa !== pb) return pb - pa;
    if (isStale(a) !== isStale(b)) return isStale(a) ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
