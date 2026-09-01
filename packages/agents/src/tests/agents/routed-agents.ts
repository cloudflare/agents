import { Agent } from "../../index.ts";
import { RoutedAgents } from "../../routing/index.ts";
import type { Connection, WSMessage } from "../../index.ts";

export type RoutedChatMetadata = {
  readonly title: string;
};

/** Independent Agent addressed through RoutingOwnerAgent.chats. */
export class RoutedChatAgent extends Agent<Cloudflare.Env> {
  onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS namespace_chat_values (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;
  }

  getPhysicalName(): string {
    return this.name;
  }

  setValue(key: string, value: string): void {
    this.sql`
      INSERT INTO namespace_chat_values (key, value)
      VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }

  getValue(key: string): string | null {
    const [row] = this.sql<{ value: string }>`
      SELECT value FROM namespace_chat_values WHERE key = ${key}
    `;
    return row?.value ?? null;
  }

  override onRequest(request: Request): Response {
    return Response.json({
      source: "namespace-chat",
      name: this.name,
      path: new URL(request.url).pathname
    });
  }

  override onConnect(connection: Connection): void {
    connection.send(`connected:${this.name}`);
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    if (typeof message === "string") {
      connection.send(`chat:${this.name}:${message}`);
    }
  }
}

/** Agent with one routed namespace of independent chat Agents. */
export class RoutingOwnerAgent extends Agent<Cloudflare.Env> {
  readonly chats = this.use(
    new RoutedAgents<RoutedChatAgent, RoutedChatMetadata>({
      namespace: this.env.RoutedChatAgent,
      route: "chats"
    })
  );

  createChat(title: string) {
    return this.chats.create({ metadata: { title } });
  }

  listChats() {
    return this.chats.list();
  }

  setChatMetadata(id: string, title: string) {
    return this.chats.setMetadata(id, { title });
  }

  async physicalName(id: string): Promise<string | null> {
    const chat = await this.chats.get(id);
    return chat ? chat.getPhysicalName() : null;
  }

  async setChatValue(id: string, key: string, value: string): Promise<boolean> {
    const chat = await this.chats.get(id);
    if (!chat) return false;
    await chat.setValue(key, value);
    return true;
  }

  deleteChat(id: string) {
    return this.chats.delete(id);
  }
}
