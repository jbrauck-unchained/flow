// The item model and the pure functions over it.
//
// Split out from store.ts so the scorer can use them without importing the
// persistence layer that imports the scorer straight back.

export type Status = "todo" | "done";

export interface Item {
  // Owner-authored at capture. Unchanged since v1.
  id: string;
  title: string;
  description: string;
  project?: string;
  tags: string[];
  status: Status;
  createdAt: number;
  doneAt?: number;

  // Agent-authored. All optional — the extension works fine if none are ever set.
  priority?: number;
  why?: string;
  cluster?: string;
  source?: string;
  agentTouchedAt?: number;

  // Owner override: the agent must not reorder this one.
  pinned?: boolean;
}

/**
 * Turns one line of text into an item.
 *
 * The first #word becomes the project. Any @word, and any later #word,
 * becomes a tag. Everything else is the title. All of it is optional —
 * a bare line of text is a perfectly good item.
 */
export function parse(input: string): Item {
  const tags: string[] = [];
  let project: string | undefined;
  const titleWords: string[] = [];

  for (const word of input.trim().split(/\s+/)) {
    const body = word.slice(1).toLowerCase();
    if (word.startsWith("#") && body.length > 0) {
      if (project === undefined) project = body;
      else tags.push(body);
    } else if (word.startsWith("@") && body.length > 0) {
      tags.push(body);
    } else if (word.length > 0) {
      titleWords.push(word);
    }
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: titleWords.join(" ") || input.trim(),
    description: "",
    project,
    tags: [...new Set(tags)],
    status: "todo",
    createdAt: Date.now(),
  };
}

export function splitTags(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[,\s]+/)
        .map((t) => t.replace(/^[@#]/, "").trim().toLowerCase())
        .filter((t) => t.length > 0),
    ),
  ];
}

export function matches(item: Item, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystack = [item.title, item.description, item.project ?? "", ...item.tags].join(" ").toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term.replace(/^[@#]/, "")));
}
