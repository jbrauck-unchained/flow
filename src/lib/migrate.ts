import { LocalStorage } from "@raycast/api";
import { access } from "fs/promises";
import { ITEMS_FILE, Item, importItems } from "./store";

const KEY = "flow.items";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time move out of Raycast's LocalStorage and into ~/.flow/items.json.
 *
 * This lives apart from store.ts because it needs @raycast/api, and store.ts has
 * to stay pure Node for the CLI to share it. Call it from a command entry point
 * before the first load.
 */
export async function migrateFromLocalStorage(): Promise<void> {
  if (await exists(ITEMS_FILE)) return;

  const raw = await LocalStorage.getItem<string>(KEY);
  if (!raw) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Leave the key in place so the data can still be recovered by hand.
    return;
  }

  if (!Array.isArray(parsed)) return;
  if (parsed.length > 0) await importItems(parsed as Item[]);

  // Only now — so a failure above means we retry next launch rather than lose it.
  await LocalStorage.removeItem(KEY);
}
