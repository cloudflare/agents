import "react";

// These declarations cover the experimental WebMCP surface used by this demo
// until the attributes and browser APIs ship in React and TypeScript's DOM types.
declare module "react" {
  interface FormHTMLAttributes<T> {
    toolname?: string;
    tooldescription?: string;
    toolautosubmit?: "";
  }

  interface InputHTMLAttributes<T> {
    toolparamdescription?: string;
  }
}

declare global {
  interface WebMCPTool {
    name: string;
    description: string;
    inputSchema: object;
    annotations?: {
      readOnlyHint?: boolean;
      untrustedContentHint?: boolean;
    };
    execute(input: unknown): Promise<unknown>;
  }

  interface WebMCPRegisterToolOptions {
    signal?: AbortSignal;
  }

  interface Document {
    readonly modelContext?: {
      registerTool(
        tool: WebMCPTool,
        options?: WebMCPRegisterToolOptions
      ): Promise<void>;
    };
  }

  interface SubmitEvent {
    readonly agentInvoked: boolean;
    respondWith(response: Promise<unknown>): void;
  }
}
