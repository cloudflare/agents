import { Agent } from "../../index.ts";
import type { AgentContext } from "../../index.ts";

class NativeRpcBaseAgent extends Agent {
  shadowedMethod(): string {
    return "inherited method";
  }
}

export class TestNativeRpcAgent extends NativeRpcBaseAgent {
  private constructionFinished = false;
  private fieldInitializerObservation = this.observeConstruction("field");
  private constructorObservation: string;
  private ready = false;

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    this.constructorObservation = this.observeConstruction("constructor");
    this.constructionFinished = true;
  }

  private observeConstruction(location: string): string {
    return `${location}:${this.constructionFinished ? "finished" : "constructing"}`;
  }

  override async onStart(): Promise<void> {
    if (await this.ctx.storage.get<boolean>("fail_if_started")) {
      throw new Error("condemned agent must not start");
    }

    const starts =
      (await this.ctx.storage.get<number>("test_start_count")) ?? 0;
    await this.ctx.storage.put("test_start_count", starts + 1);
    this.ready = true;
  }

  async applicationRpc(): Promise<{
    name: string;
    ready: boolean;
    startCount: number;
    fieldInitializerObservation: string;
    constructorObservation: string;
    shadowedValue: string;
  }> {
    return {
      name: this.name,
      ready: this.ready,
      startCount: (await this.ctx.storage.get<number>("test_start_count")) ?? 0,
      fieldInitializerObservation: this.fieldInitializerObservation,
      constructorObservation: this.constructorObservation,
      shadowedValue: (this as unknown as { shadowedMethod: string })
        .shadowedMethod
    };
  }
}

// The nearest descriptor must remain authoritative during RPC wrapper discovery.
// Defining this after the class avoids TypeScript treating the intentional
// method-to-getter shadow as an invalid override.
Object.defineProperty(TestNativeRpcAgent.prototype, "shadowedMethod", {
  configurable: true,
  enumerable: false,
  get() {
    return "nearest getter";
  }
});
