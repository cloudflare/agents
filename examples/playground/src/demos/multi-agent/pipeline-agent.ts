import { callable, getAgentByName } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";
import type {
  ValidatorStageAgent,
  TransformStageAgent,
  EnrichStageAgent,
  StageResult
} from "./stage-agents";

export interface PipelineResult {
  input: string;
  stages: StageResult[];
  totalDuration: number;
}

export interface PipelineState {
  lastRun: PipelineResult | null;
}

export class PipelineOrchestratorAgent extends Agent<Env, PipelineState> {
  initialState: PipelineState = { lastRun: null };

  @callable({ description: "Run text through the 3-stage pipeline" })
  async runPipeline(input: string): Promise<PipelineResult> {
    const start = Date.now();
    const stages: StageResult[] = [];

    const validator = await getAgentByName<Env, ValidatorStageAgent>(
      this.env.ValidatorStageAgent,
      `validator-${this.name}`
    );
    const validateResult: StageResult = await validator.process(input);
    stages.push(validateResult);

    const validatedOutput = validateResult.output as {
      trimmed: string;
      lowercased: string;
      wordCount: number;
    };

    const transformer = await getAgentByName<Env, TransformStageAgent>(
      this.env.TransformStageAgent,
      `transformer-${this.name}`
    );
    const transformResult: StageResult =
      await transformer.process(validatedOutput);
    stages.push(transformResult);

    const transformedOutput = transformResult.output as {
      uppercase: string;
      words: string[];
      charCount: number;
    };

    const enricher = await getAgentByName<Env, EnrichStageAgent>(
      this.env.EnrichStageAgent,
      `enricher-${this.name}`
    );
    const enrichResult: StageResult = await enricher.process(transformedOutput);
    stages.push(enrichResult);

    const result: PipelineResult = {
      input,
      stages,
      totalDuration: Date.now() - start
    };

    this.setState({ lastRun: result });
    return result;
  }
}
