/** @jsxImportSource chat */

import { Actions, Button, Card, CardText, LinkButton } from "chat";
import type { Demo } from "./types";

export const APPROVE_ACTION_ID = "act-ok";
export const REJECT_ACTION_ID = "act-no";

export const CARD_DEMOS: Demo[] = [
  {
    id: "card-approve",
    label: "Approval card",
    async run(thread) {
      await thread.post(
        <Card title="Deploy preview">
          <CardText>
            This card renders as Telegram MarkdownV2 plus inline keyboard
            buttons.
          </CardText>
          <Actions>
            <Button id={APPROVE_ACTION_ID} style="primary">
              Approve
            </Button>
            <Button id={REJECT_ACTION_ID} style="danger">
              Reject
            </Button>
          </Actions>
        </Card>
      );
    }
  },
  {
    id: "card-link",
    label: "Link button",
    async run(thread) {
      await thread.post(
        <Card title="Chat SDK docs">
          <CardText>Open the Telegram adapter docs.</CardText>
          <Actions>
            <LinkButton url="https://chat-sdk.dev/adapters/official/telegram">
              View docs
            </LinkButton>
          </Actions>
        </Card>
      );
    }
  },
  {
    id: "card-size",
    label: "Callback data limit",
    async run(thread) {
      await thread.post({
        markdown:
          "Telegram callback data is limited to 64 bytes. This example keeps all button action IDs intentionally short."
      });
    }
  }
];
