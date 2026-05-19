/** @jsxImportSource chat */

import { Actions, Button, Card, CardText } from "chat";
import { CARD_DEMOS, FILE_DEMOS, MARKDOWN_DEMOS } from "./demos";
import type { Demo, DemoThread } from "./demos";

export const MAIN_MENU_ID = "menu-main";
export const ASK_AGENT_ACTION_ID = "ask-agent";
const MARKDOWN_MENU_ID = "menu-md";
const CARDS_MENU_ID = "menu-card";
const FILES_MENU_ID = "menu-file";

export const MENU_IDS = new Set([
  MAIN_MENU_ID,
  MARKDOWN_MENU_ID,
  CARDS_MENU_ID,
  FILES_MENU_ID
]);

const DEMO_GROUPS = [
  {
    id: MARKDOWN_MENU_ID,
    title: "Text and Markdown",
    description: "MarkdownV2 rendering and post+edit streaming.",
    demos: MARKDOWN_DEMOS
  },
  {
    id: CARDS_MENU_ID,
    title: "Cards and Actions",
    description: "Cards rendered with Telegram inline keyboards.",
    demos: CARD_DEMOS
  },
  {
    id: FILES_MENU_ID,
    title: "Files",
    description: "Worker-generated file upload through Chat SDK.",
    demos: FILE_DEMOS
  }
];

export const DEMO_LOOKUP = new Map<string, Demo>(
  DEMO_GROUPS.flatMap((group) => group.demos.map((demo) => [demo.id, demo]))
);

export async function postMainMenu(thread: DemoThread): Promise<void> {
  await thread.post(
    <Card title="Chat SDK on Cloudflare Workers">
      <CardText>
        Pick a category to exercise the Telegram adapter with Agent
        subagent-backed state.
      </CardText>
      {DEMO_GROUPS.map((group) => (
        <Actions key={group.id}>
          <Button id={group.id}>{group.title}</Button>
        </Actions>
      ))}
      <Actions>
        <Button id={ASK_AGENT_ACTION_ID}>Ask the Agent</Button>
      </Actions>
    </Card>
  );
}

export async function postAskAgentInstructions(
  thread: DemoThread
): Promise<void> {
  await thread.post(
    <Card title="Ask the Agent">
      <CardText>
        DM me a question for an AI response. In a group, mention me or start a
        message with /ask. Send /reset to clear this thread's AI history.
      </CardText>
    </Card>
  );
}

export async function postMenu(
  thread: DemoThread,
  menuId: string
): Promise<void> {
  const group = DEMO_GROUPS.find((item) => item.id === menuId);
  if (!group) {
    await postMainMenu(thread);
    return;
  }

  await thread.post(
    <Card title={group.title}>
      <CardText>{group.description}</CardText>
      {group.demos.map((demo) => (
        <Actions key={demo.id}>
          <Button id={demo.id}>{demo.label}</Button>
        </Actions>
      ))}
      <Actions>
        <Button id={MAIN_MENU_ID}>Back to main menu</Button>
      </Actions>
    </Card>
  );
}
