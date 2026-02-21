import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface StageResult {
  stage: string;
  input: unknown;
  output: unknown;
  duration: number;
}

export class ValidatorStageAgent extends Agent<Env> {
  async process(input: string): Promise<StageResult> {
    const start = Date.now();

    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Input cannot be empty");
    }

    const output = {
      original: input,
      trimmed,
      lowercased: trimmed.toLowerCase(),
      length: trimmed.length,
      wordCount: trimmed.split(/\s+/).length,
      valid: true
    };

    await new Promise((resolve) => setTimeout(resolve, 150));

    return {
      stage: "validate",
      input,
      output,
      duration: Date.now() - start
    };
  }
}

export class TransformStageAgent extends Agent<Env> {
  async process(validated: {
    trimmed: string;
    lowercased: string;
    wordCount: number;
  }): Promise<StageResult> {
    const start = Date.now();

    const words = validated.lowercased.split(/\s+/);
    const output = {
      uppercase: validated.trimmed.toUpperCase(),
      reversed: validated.trimmed.split("").reverse().join(""),
      words,
      wordFrequency: words.reduce(
        (acc: Record<string, number>, word: string) => {
          acc[word] = (acc[word] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
      charCount: validated.trimmed.replace(/\s/g, "").length
    };

    await new Promise((resolve) => setTimeout(resolve, 200));

    return {
      stage: "transform",
      input: validated,
      output,
      duration: Date.now() - start
    };
  }
}

export class EnrichStageAgent extends Agent<Env> {
  async process(transformed: {
    uppercase: string;
    words: string[];
    charCount: number;
  }): Promise<StageResult> {
    const start = Date.now();

    const output = {
      ...transformed,
      processedAt: new Date().toISOString(),
      hash: await this.simpleHash(transformed.uppercase),
      sentiment: transformed.words.length > 5 ? "detailed" : "brief",
      metadata: {
        stages: 3,
        pipeline: "validate → transform → enrich"
      }
    };

    await new Promise((resolve) => setTimeout(resolve, 100));

    return {
      stage: "enrich",
      input: transformed,
      output,
      duration: Date.now() - start
    };
  }

  private async simpleHash(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
