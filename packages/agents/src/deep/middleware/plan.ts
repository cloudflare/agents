import type { ModelRequest, ToolMeta } from "../types";
import type { Store } from "../agent/store";

export class ModelPlanBuilder {
  private sysParts: string[] = [];
  private defs = new Map<string, ToolMeta>();
  private _toolChoice: ModelRequest["toolChoice"] = "auto";
  private _responseFormat: ModelRequest["responseFormat"];
  private _temperature?: number;
  private _maxTokens?: number;
  private _stop?: string[];
  private _model?: string;

  constructor(private readonly store: Store) {}

  addSystemPrompt(...parts: Array<string | undefined | null>) {
    for (const p of parts) if (p) this.sysParts.push(p);
  }

  addToolDefs(...defs: ToolMeta[]) {
    for (const d of defs) if (d?.name) this.defs.set(d.name, d);
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
    const persisted = this.store.meta<ToolMeta[]>("toolDefs") ?? [];
    for (const d of persisted) {
      if (d?.name && !this.defs.has(d.name)) this.defs.set(d.name, d);
    }
    const systemPrompt = [this.store.meta("systemPrompt"), ...this.sysParts]
      .filter(Boolean)
      .join("\n\n");
    const messages = this.store
      .listMessages()
      .filter((m) => m.role !== "system");
    return {
      model: this._model ?? this.store.meta("model") ?? "openai:gpt-4.1",
      systemPrompt,
      messages,
      toolDefs: Array.from(this.defs.values()),
      toolChoice: this._toolChoice,
      responseFormat: this._responseFormat,
      temperature: this._temperature,
      maxTokens: this._maxTokens,
      stop: this._stop
    };
  }
}
