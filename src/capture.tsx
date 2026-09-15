import { LaunchProps, showHUD } from "@raycast/api";
import { migrateFromLocalStorage } from "./lib/migrate";
import { addItem, drainInbox } from "./lib/store";

export default async function Capture(props: LaunchProps<{ arguments: { text: string } }>) {
  const text = props.arguments.text.trim();
  if (text.length === 0) {
    await showHUD("Nothing to capture");
    return;
  }

  await migrateFromLocalStorage();
  await drainInbox();
  const item = await addItem(text);
  await showHUD(item.project ? `Captured in ${item.project}` : "Captured");
}
