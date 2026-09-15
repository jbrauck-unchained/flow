import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { Item, splitTags } from "../lib/store";

interface Values {
  title: string;
  description: string;
  project: string;
  tags: string;
}

export function EditItem({ item, onSave }: { item: Item; onSave: (item: Item) => void }) {
  const { pop } = useNavigation();

  function handleSubmit(values: Values) {
    const title = values.title.trim();
    if (title.length === 0) return;
    onSave({
      ...item,
      title,
      description: values.description.trim(),
      project: values.project.trim().toLowerCase() || undefined,
      tags: splitTags(values.tags),
    });
    pop();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Changes" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" defaultValue={item.title} />
      <Form.TextArea
        id="description"
        title="Description"
        placeholder="Only if you want it"
        defaultValue={item.description}
      />
      <Form.TextField id="project" title="Project" defaultValue={item.project ?? ""} />
      <Form.TextField
        id="tags"
        title="Tags"
        placeholder="comma or space separated"
        defaultValue={item.tags.join(", ")}
      />
    </Form>
  );
}
