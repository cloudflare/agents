import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockPartySocket {
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

const partySocketState = vi.hoisted(() => ({
  socket: null as MockPartySocket | null
}));

vi.mock("partysocket", () => ({
  PartySocket: class {
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor() {
      partySocketState.socket = this;
    }

    send(): void {}

    close(): void {}
  }
}));

import { VoiceClient, type VoiceConnectionDiagnostic } from "../voice-client";

beforeEach(() => {
  partySocketState.socket = null;
});

describe("WebSocketVoiceTransport diagnostics", () => {
  it("forwards the browser WebSocket error event through VoiceClient", () => {
    const client = new VoiceClient({
      agent: "test-agent",
      host: "example.com"
    });
    const diagnostics: VoiceConnectionDiagnostic[] = [];
    const errors: Array<string | null> = [];
    client.addEventListener("connectiondiagnostic", (diagnostic) =>
      diagnostics.push(diagnostic)
    );
    client.addEventListener("error", (error) => errors.push(error));

    client.connect();
    const event = new Event("error");
    partySocketState.socket?.onerror?.(event);

    expect(diagnostics).toEqual([{ type: "error", cause: event }]);
    const diagnostic = diagnostics[0];
    expect(diagnostic?.type).toBe("error");
    if (diagnostic?.type !== "error") throw new Error("expected error");
    expect(diagnostic.cause).toBe(event);
    expect(client.error).toBe("Connection lost. Reconnecting...");
    expect(errors.at(-1)).toBe("Connection lost. Reconnecting...");
  });

  it("forwards useful browser WebSocket close details through VoiceClient", () => {
    const client = new VoiceClient({
      agent: "test-agent",
      host: "example.com"
    });
    const diagnostics: VoiceConnectionDiagnostic[] = [];
    client.addEventListener("connectiondiagnostic", (diagnostic) =>
      diagnostics.push(diagnostic)
    );

    client.connect();
    const event = new CloseEvent("close", {
      code: 4001,
      reason: "authentication expired",
      wasClean: false
    });
    partySocketState.socket?.onclose?.(event);

    expect(diagnostics).toEqual([
      {
        type: "close",
        code: 4001,
        reason: "authentication expired",
        wasClean: false
      }
    ]);
    expect(client.error).toBeNull();
  });
});
