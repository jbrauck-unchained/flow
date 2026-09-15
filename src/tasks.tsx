import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  Keyboard,
  List,
  LocalStorage,
  confirmAlert,
  showToast,
  Toast,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { AnswerAsk } from "./components/answer-ask";
import { EditItem } from "./components/edit-item";
import { migrateFromLocalStorage } from "./lib/migrate";
import {
  Ask,
  Item,
  JournalEntry,
  acceptAsk,
  addFeedback,
  agentChangesSince,
  describeChange,
  drainInbox,
  loadItems,
  matches,
  mutate,
  parse,
  readAsks,
  removeAsk,
  undoGroup,
  undoLast,
} from "./lib/store";

const ALL = "__all__";
const SEEN_KEY = "flow.lastSeenAt";
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

function isStale(item: Item): boolean {
  return item.status === "todo" && Date.now() - item.createdAt > STALE_MS;
}

/**
 * Pinned first, then whatever the agent thinks matters, then things going quietly
 * stale, then newest. An item with no priority sorts by recency exactly as it did
 * before any of this existed, so a list no agent has touched behaves identically.
 */
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

export default function Tasks() {
  const [items, setItems] = useState<Item[]>([]);
  const [changes, setChanges] = useState<JournalEntry[]>([]);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [project, setProject] = useState(ALL);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    (async () => {
      await migrateFromLocalStorage();
      await drainInbox();
      // Read the previous mark before moving it, so this session shows everything
      // that happened since the last time the list was actually opened.
      const previous = Number((await LocalStorage.getItem<string>(SEEN_KEY)) ?? 0);
      await LocalStorage.setItem(SEEN_KEY, String(Date.now()));
      setChanges(await agentChangesSince(previous));
      setAsks(await readAsks());
      setItems(await loadItems());
      setIsLoading(false);
    })();
  }, []);

  // Takes a function rather than an array: mutate() re-reads from disk and applies
  // it there, so a capture or an agent write that landed while this view was open
  // no longer gets clobbered by our stale copy.
  async function commit(apply: (items: Item[]) => Item[]) {
    setItems(await mutate("owner", apply));
  }

  const projects = useMemo(() => {
    const names = new Set<string>();
    for (const item of items) if (item.project) names.add(item.project);
    return [...names].sort();
  }, [items]);

  const visible = useMemo(
    () =>
      sorted(
        items.filter(
          (item) =>
            (showDone || item.status === "todo") &&
            (project === ALL || item.project === project) &&
            matches(item, searchText),
        ),
      ),
    [items, showDone, project, searchText],
  );

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  async function capture() {
    const text = searchText.trim();
    if (text.length === 0) return;
    const item = parse(text);
    if (project !== ALL && !item.project) item.project = project;
    await commit((current) => [item, ...current]);
    setSearchText("");
  }

  async function toggle(item: Item) {
    const done = item.status === "todo";
    await commit((current) =>
      current.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, status: done ? "done" : "todo", doneAt: done ? Date.now() : undefined }
          : candidate,
      ),
    );
    await showToast({ style: Toast.Style.Success, title: done ? "Done" : "Back on the list" });
  }

  /** The owner's veto. Pinned items are off limits to the agent's reordering. */
  async function togglePin(item: Item) {
    const pinned = !item.pinned;
    await commit((current) => current.map((c) => (c.id === item.id ? { ...c, pinned } : c)));
    await addFeedback([{ ts: Date.now(), kind: "pin", actor: "owner", itemId: item.id, pinned }]);
    await showToast({ style: Toast.Style.Success, title: pinned ? "Pinned" : "Unpinned" });
  }

  async function remove(item: Item) {
    const confirmed = await confirmAlert({
      title: "Delete this item?",
      message: item.title,
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (confirmed) await commit((current) => current.filter((candidate) => candidate.id !== item.id));
  }

  async function clearDone() {
    let removed = 0;
    await commit((current) => {
      const remaining = current.filter((item) => item.status === "todo");
      removed = current.length - remaining.length;
      return remaining;
    });
    if (removed === 0) return;
    await showToast({ style: Toast.Style.Success, title: `Cleared ${removed}` });
  }

  /** Cmd+Z — reverse the last change, whoever made it. */
  async function undo() {
    const result = await undoLast(1);
    if (result.undone === 0) {
      await showToast({ style: Toast.Style.Failure, title: "Nothing to undo" });
      return;
    }
    setItems(await loadItems());
    setChanges((current) => current.filter((entry) => !result.entries.some((undone) => undone.ts === entry.ts)));
    await showToast({ style: Toast.Style.Success, title: "Undone" });
  }

  /** Reject one specific agent change without discarding the others. */
  async function reject(entry: JournalEntry) {
    await undoGroup(entry.ts);
    setItems(await loadItems());
    setChanges((current) => current.filter((candidate) => candidate.ts !== entry.ts));
    await showToast({ style: Toast.Style.Success, title: "Reverted", message: "The agent will see this" });
  }

  /**
   * Some asks carry an action the agent chose to propose rather than perform.
   * Accepting runs it here and now, so saying yes costs one keystroke instead of
   * a round trip that waits for the agent's next run.
   */
  async function accept(ask: Ask) {
    const result = await acceptAsk(ask);
    setAsks((current) => current.filter((candidate) => candidate.id !== ask.id));
    setItems(await loadItems());
    await showToast({ style: Toast.Style.Success, title: result });
  }

  /** Answering closes the ask for good — it never resurfaces. */
  async function answerAsk(ask: Ask, answer: string) {
    await addFeedback([
      { ts: Date.now(), kind: "answer", actor: "owner", askId: ask.id, question: ask.message, answer },
    ]);
    await removeAsk(ask.id);
    setAsks((current) => current.filter((candidate) => candidate.id !== ask.id));
    await showToast({ style: Toast.Style.Success, title: "Sent to the agent" });
  }

  /** Not answering is itself an answer: don't ask this again. */
  async function dismissAsk(ask: Ask) {
    await addFeedback([{ ts: Date.now(), kind: "dismiss", actor: "owner", askId: ask.id, question: ask.message }]);
    await removeAsk(ask.id);
    setAsks((current) => current.filter((candidate) => candidate.id !== ask.id));
  }

  function keep(entry: JournalEntry) {
    setChanges((current) => current.filter((candidate) => candidate.ts !== entry.ts));
  }

  const sharedActions = (
    <>
      <Action
        title="Undo Last Change"
        icon={Icon.ArrowCounterClockwise}
        shortcut={{ modifiers: ["cmd"], key: "z" }}
        onAction={undo}
      />
      <Action
        title={showDone ? "Hide Done Items" : "Show Done Items"}
        icon={showDone ? Icon.EyeDisabled : Icon.Eye}
        shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
        onAction={() => setShowDone(!showDone)}
      />
      <Action
        title="Clear Done Items"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
        onAction={clearDone}
      />
    </>
  );

  return (
    <List
      isLoading={isLoading}
      filtering={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Type a thought, or search"
      searchBarAccessory={
        projects.length > 0 ? (
          <List.Dropdown tooltip="Project" value={project} onChange={setProject}>
            <List.Dropdown.Item title="All projects" value={ALL} />
            {projects.map((name) => (
              <List.Dropdown.Item key={name} title={name} value={name} />
            ))}
          </List.Dropdown>
        ) : undefined
      }
    >
      {searchText.trim().length > 0 && (
        <List.Section title="Capture">
          <List.Item
            icon={Icon.Plus}
            title={searchText.trim()}
            subtitle="Add to the list"
            actions={
              <ActionPanel>
                <Action title="Add to the List" icon={Icon.Plus} onAction={capture} />
                {sharedActions}
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {asks.length > 0 && searchText.trim().length === 0 && (
        <List.Section title="The agent is asking" subtitle={`${asks.length}`}>
          {asks.map((ask) => (
            <List.Item
              key={ask.id}
              icon={{
                source: ask.kind === "question" ? Icon.QuestionMarkCircle : Icon.LightBulb,
                tintColor: Color.Yellow,
              }}
              title={ask.message}
              subtitle={ask.itemIds
                ?.map((id) => byId.get(id)?.title)
                .filter(Boolean)
                .join(" · ")}
              accessories={
                ask.action
                  ? [{ icon: Icon.Box, text: `${ask.action.itemIds.length}`, tooltip: "Items affected" }]
                  : undefined
              }
              actions={
                <ActionPanel>
                  {ask.action && (
                    <Action
                      title="Accept"
                      icon={Icon.Check}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
                      onAction={() => accept(ask)}
                    />
                  )}
                  {ask.options?.map((option) => (
                    <Action key={option} title={option} icon={Icon.Reply} onAction={() => answerAsk(ask, option)} />
                  ))}
                  <Action.Push
                    title="Answer…"
                    icon={Icon.Pencil}
                    target={<AnswerAsk ask={ask} onAnswer={(answer) => answerAsk(ask, answer)} />}
                  />
                  <Action title="Dismiss" icon={Icon.XMarkCircle} onAction={() => dismissAsk(ask)} />
                  {sharedActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {changes.length > 0 && searchText.trim().length === 0 && (
        <List.Section title="Changed since you last looked" subtitle={`${changes.length}`}>
          {changes.map((entry) => {
            const item = byId.get(entry.id);
            return (
              <List.Item
                key={`${entry.ts}-${entry.id}`}
                icon={{ source: Icon.Stars, tintColor: Color.Purple }}
                title={item?.title ?? entry.before?.title ?? entry.after?.title ?? entry.id}
                subtitle={describeChange(entry)}
                accessories={item?.why ? [{ text: item.why, tooltip: item.why }] : undefined}
                actions={
                  <ActionPanel>
                    <Action title="Keep" icon={Icon.Check} onAction={() => keep(entry)} />
                    <Action
                      title="Revert This Change"
                      icon={Icon.ArrowCounterClockwise}
                      onAction={() => reject(entry)}
                    />
                    {item && (
                      <Action
                        title="Pin so the Agent Leaves It Alone"
                        icon={Icon.Pin}
                        shortcut={{ modifiers: ["cmd"], key: "p" }}
                        onAction={() => togglePin(item)}
                      />
                    )}
                    {sharedActions}
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      )}

      <List.Section title={showDone ? "Everything" : "To Do"} subtitle={`${visible.length}`}>
        {visible.map((item) => (
          <List.Item
            key={item.id}
            icon={
              item.status === "done"
                ? { source: Icon.CheckCircle, tintColor: Color.Green }
                : { source: Icon.Circle, tintColor: Color.SecondaryText }
            }
            title={item.title}
            subtitle={item.description || undefined}
            accessories={accessoriesFor(item)}
            actions={
              <ActionPanel>
                <Action
                  title={item.status === "todo" ? "Mark Done" : "Move Back to to Do"}
                  icon={item.status === "todo" ? Icon.CheckCircle : Icon.Circle}
                  onAction={() => toggle(item)}
                />
                <Action.Push
                  title="Edit"
                  icon={Icon.Pencil}
                  shortcut={Keyboard.Shortcut.Common.Edit}
                  target={
                    <EditItem
                      item={item}
                      onSave={(updated) =>
                        commit((current) =>
                          current.map((candidate) => (candidate.id === item.id ? updated : candidate)),
                        )
                      }
                    />
                  }
                />
                <Action
                  title={item.pinned ? "Unpin" : "Pin"}
                  icon={Icon.Pin}
                  shortcut={{ modifiers: ["cmd"], key: "p" }}
                  onAction={() => togglePin(item)}
                />
                <Action.CopyToClipboard
                  title="Copy Title"
                  content={item.title}
                  shortcut={Keyboard.Shortcut.Common.Copy}
                />
                <Action
                  title="Delete"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={Keyboard.Shortcut.Common.Remove}
                  onAction={() => remove(item)}
                />
                {sharedActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.EmptyView
        icon={Icon.Dot}
        title={items.length === 0 ? "Nothing here yet" : "Nothing left"}
        description="Start typing to add something."
      />
    </List>
  );
}

function accessoriesFor(item: Item): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];
  // The agent's reasoning, shown to the owner rather than buried in a file.
  if (item.why) accessories.push({ icon: Icon.Stars, text: item.why, tooltip: item.why });
  if (item.cluster) accessories.push({ tag: { value: item.cluster, color: Color.Purple } });
  if (item.project) accessories.push({ tag: { value: item.project, color: Color.Blue } });
  if (item.tags.length > 0) accessories.push({ text: item.tags.map((tag) => `@${tag}`).join(" ") });
  if (item.pinned) accessories.push({ icon: Icon.Pin, tooltip: "Pinned — the agent leaves this alone" });
  // A gentle nudge, deliberately not a badge or a warning colour.
  if (isStale(item)) accessories.push({ icon: Icon.Clock, tooltip: "Sitting here a while" });
  return accessories;
}
