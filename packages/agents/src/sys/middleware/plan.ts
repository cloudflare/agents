import type { ModelRequest } from "../types";
import type { SystemAgent } from "../agent";
import { getToolMeta } from "..";

export class ModelPlanBuilder {
  private sysParts: string[] = [];
  private _toolChoice: ModelRequest["toolChoice"] = "auto";
  private _responseFormat: ModelRequest["responseFormat"];
  private _temperature?: number;
  private _maxTokens?: number;
  private _stop?: string[];
  private _model?: string;

  constructor(private readonly agent: SystemAgent) {}

  addSystemPrompt(...parts: Array<string | undefined | null>) {
    for (const p of parts) if (p) this.sysParts.push(p);
  }
  setModel(id?: string) {
    if (id) this._model = id;
  }
  setToolChoice(choice: ModelRequest["toolChoice"]) {
    this._toolChoice = choice ?? "auto";
  }
  setResponseFormat(fmt: ModelRequest["responseFormat"]) {
    this._responseFormat = fmt;
  }
  setTemperature(t?: number) {
    this._temperature = t;
  }
  setMaxTokens(n?: number) {
    this._maxTokens = n;
  }
  setStop(stop?: string[]) {
    this._stop = stop;
  }

  build(): ModelRequest {
    const systemPrompt = [this.agent.systemPrompt, ...this.sysParts]
      .filter(Boolean)
      .join("\n\n");

    const toolDefs = Object.values(this.agent.tools).map((tool) => {
      const meta = getToolMeta(tool);
      if (!meta) throw new Error(`Tool ${tool.name} has no metadata`);
      return meta;
    });

    const messages = this.agent.messages.filter((m) => m.role !== "system");
    return {
      model: this._model ?? this.agent.model ?? "openai:gpt-4.1",
      systemPrompt,
      messages,
      toolDefs,
      toolChoice: this._toolChoice,
      responseFormat: this._responseFormat,
      temperature: this._temperature,
      maxTokens: this._maxTokens,
      stop: this._stop
    };
  }
}
