import { WorkerEntrypoint } from "cloudflare:workers";
import type { JsonSchemaToolDescriptors } from "../json-schema-types";
import type { ConnectorDescription, ToolAnnotations } from "./types";

/**
 * Base class for codemode connectors.
 *
 * Connectors define the service and execute tools. The proxy tool
 * checks annotations and routes calls — the connector just executes.
 */
export abstract class CodemodeConnector<
  Env = unknown,
  Props = unknown
> extends WorkerEntrypoint<Env, Props> {
  abstract name(): string;

  protected instructions(): string | undefined {
    return undefined;
  }

  /** Per-method annotations. Public so the proxy tool can read them. */
  annotations(): Record<string, ToolAnnotations> {
    return {};
  }

  protected abstract loadDescriptors(): Promise<JsonSchemaToolDescriptors>;

  /** Execute a tool method by name. */
  abstract executeTool(method: string, args: unknown): Promise<unknown>;

  /**
   * Revert a previously-applied action. Optional — implement for connectors
   * that support rollback. Receives the original method, args, and the result
   * the action produced (for locating what to undo).
   */
  revertAction?(method: string, args: unknown, result: unknown): Promise<void>;

  async describe(): Promise<ConnectorDescription> {
    const descriptors = await this.getDescriptors();
    return {
      name: this.name(),
      instructions: this.instructions(),
      descriptors,
      annotations: this.annotations()
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    const { generateTypesFromJsonSchema } =
      await import("../json-schema-types");
    const descriptors = await this.getDescriptors();
    return generateTypesFromJsonSchema(descriptors).replace(
      "declare const codemode",
      `declare const ${this.name()}`
    );
  }

  #descriptorsPromise?: Promise<JsonSchemaToolDescriptors>;

  protected getDescriptors(): Promise<JsonSchemaToolDescriptors> {
    return (this.#descriptorsPromise ??= this.loadDescriptors());
  }
}
