import { Agent, type Connection, type WSMessage } from "../../index.ts";

export type OnErrorCapture = {
  firstArgIsConnection: boolean;
  firstArgErrorMessage: string | null;
  connectionId: string | null;
  errorDefined: boolean;
  errorName: string | null;
  errorMessage: string | null;
};

// Overrides onError exactly the way users do per the documented websocket
// signature (#388): two parameters, reading the error from the second one.
// The captures record what actually arrived in each slot.
export class TestOnErrorAgent extends Agent<Cloudflare.Env> {
  captures: OnErrorCapture[] = [];

  async onMessage(_connection: Connection, message: WSMessage) {
    if (message === "throw-sql") {
      this.sql`SELECT * FROM table_that_does_not_exist`;
    }
  }

  override onError(connection: Connection, error?: unknown): void {
    const isConnection =
      typeof connection === "object" &&
      connection !== null &&
      typeof (connection as Connection).send === "function";
    this.captures.push({
      firstArgIsConnection: isConnection,
      firstArgErrorMessage:
        connection instanceof Error ? connection.message : null,
      connectionId: isConnection ? (connection as Connection).id : null,
      errorDefined: error !== undefined,
      errorName: error instanceof Error ? error.name : null,
      errorMessage: error instanceof Error ? error.message : null
    });
    // Like the issue reporter's handler: observe the error, don't rethrow.
  }

  async getCaptures(): Promise<OnErrorCapture[]> {
    return this.captures;
  }
}
