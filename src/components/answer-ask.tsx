import { Action, ActionPanel, Form, useNavigation } from "@raycast/api";
import { Ask } from "../lib/store";

/**
 * Free-text answer to an agent's question. Deliberately one field and nothing
 * else — an ask is already a decision handed back to the owner, so answering one
 * shouldn't cost more than typing a sentence.
 */
export function AnswerAsk({ ask, onAnswer }: { ask: Ask; onAnswer: (answer: string) => void }) {
  const { pop } = useNavigation();

  function handleSubmit(values: { answer: string }) {
    const answer = values.answer.trim();
    if (answer.length === 0) return;
    onAnswer(answer);
    pop();
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send to the Agent" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Description title="Asking" text={ask.message} />
      <Form.TextArea id="answer" title="Answer" placeholder="Whatever you'd tell a colleague" />
    </Form>
  );
}
