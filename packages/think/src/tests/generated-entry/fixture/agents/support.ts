import { Agent } from "agents";
import { SupportResearcher } from "./support/agents/researcher";

export class Support extends Agent<Cloudflare.Env> {
  async ensureResearcher(name: string) {
    await this.subAgent(SupportResearcher, name);
  }

  override async onBeforeSubAgent(
    _request: Request,
    { className, name }: { className: string; name: string }
  ) {
    if (name.startsWith("gated-") && !this.hasSubAgent(className, name)) {
      return new Response(`${className} "${name}" not found`, {
        status: 404
      });
    }
  }
}
