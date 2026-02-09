import { Surface, Text, CodeBlock } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";

export function PipelineDemo() {
  return (
    <DemoWrapper
      title="Pipeline Pattern"
      description="Chain of responsibility where data flows through a series of processing agents."
    >
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Diagram */}
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Architecture</Text>
          </div>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <div className="text-sm text-kumo-subtle">Input</div>
            <div className="w-8 h-px bg-kumo-line" />

            <div className="bg-kumo-control px-4 py-2 rounded border border-kumo-line text-kumo-default">
              ValidatorAgent
            </div>
            <div className="w-8 h-px bg-kumo-line" />

            <div className="bg-kumo-control px-4 py-2 rounded border border-kumo-line text-kumo-default">
              TransformAgent
            </div>
            <div className="w-8 h-px bg-kumo-line" />

            <div className="bg-kumo-control px-4 py-2 rounded border border-kumo-line text-kumo-default">
              EnricherAgent
            </div>
            <div className="w-8 h-px bg-kumo-line" />

            <div className="bg-kumo-contrast text-kumo-inverse px-4 py-2 rounded">
              StorageAgent
            </div>
            <div className="w-8 h-px bg-kumo-line" />

            <div className="text-sm text-kumo-subtle">Output</div>
          </div>
        </Surface>

        {/* Description */}
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">How It Works</Text>
          </div>
          <div className="space-y-4 text-kumo-subtle">
            <p>
              The Pipeline pattern chains multiple agents together, where each
              agent performs a specific transformation and passes the result to
              the next stage.
            </p>
            <ol className="list-decimal list-inside space-y-2">
              <li>Data enters the pipeline at the first stage</li>
              <li>Each stage processes and transforms the data</li>
              <li>
                Result is passed to the next agent via{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  getAgentByName()
                </code>
              </li>
              <li>Final stage returns or stores the processed result</li>
            </ol>
          </div>
        </Surface>

        {/* Code Example */}
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Example Code</Text>
          </div>
          <CodeBlock
            lang="ts"
            code={`// validator-agent.ts
async process(data: RawInput): Promise<ValidatedData> {
  // Validate the input
  const validated = this.validate(data);
  
  // Pass to next stage
  const transformer = await getAgentByName(
    this.env.TransformAgent,
    "main"
  );
  return transformer.process(validated);
}

// transform-agent.ts
async process(data: ValidatedData): Promise<TransformedData> {
  // Transform the data
  const transformed = this.transform(data);
  
  // Pass to next stage
  const enricher = await getAgentByName(
    this.env.EnricherAgent,
    "main"
  );
  return enricher.process(transformed);
}

// enricher-agent.ts
async process(data: TransformedData): Promise<EnrichedData> {
  // Enrich with external data
  const enriched = await this.enrich(data);
  
  // Final stage - store
  const storage = await getAgentByName(
    this.env.StorageAgent,
    "main"
  );
  return storage.store(enriched);
}`}
          />
        </Surface>

        {/* Use Cases */}
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Use Cases</Text>
          </div>
          <ul className="space-y-3 text-kumo-subtle">
            <li className="flex gap-3">
              <span className="text-kumo-inactive">•</span>
              <div>
                <strong className="text-kumo-default">ETL Pipelines</strong> —
                Extract, transform, and load data through stages
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-kumo-inactive">•</span>
              <div>
                <strong className="text-kumo-default">Validation Chains</strong>{" "}
                — Multi-step validation with different rules per stage
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-kumo-inactive">•</span>
              <div>
                <strong className="text-kumo-default">
                  Document Processing
                </strong>{" "}
                — Parse, analyze, summarize, store
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-kumo-inactive">•</span>
              <div>
                <strong className="text-kumo-default">Order Processing</strong>{" "}
                — Validate → Reserve Inventory → Charge → Ship
              </div>
            </li>
          </ul>
        </Surface>

        {/* Variations */}
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Variations</Text>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Linear Pipeline
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Data flows A → B → C → D in order
                </Text>
              </div>
            </div>
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Branching Pipeline
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Stage can route to different next stages based on data
                </Text>
              </div>
            </div>
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Saga Pipeline
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Each stage has a compensating action for rollback
                </Text>
              </div>
            </div>
            <div className="p-4 bg-kumo-elevated rounded">
              <Text bold size="sm">
                Async Pipeline
              </Text>
              <div className="mt-1">
                <Text variant="secondary" size="xs">
                  Stages are decoupled via queues for resilience
                </Text>
              </div>
            </div>
          </div>
        </Surface>

        {/* Considerations */}
        <Surface className="p-6 rounded-lg bg-kumo-elevated">
          <div className="mb-4">
            <Text variant="heading3">Considerations</Text>
          </div>
          <ul className="space-y-2 text-sm text-kumo-subtle">
            <li>
              • Each stage is a Durable Object with its own state for tracking
              progress
            </li>
            <li>
              • Consider using Workflows for pipelines that need durability
              guarantees
            </li>
            <li>
              • Add observability at each stage for debugging and monitoring
            </li>
            <li>• Handle partial failures and design for idempotency</li>
          </ul>
        </Surface>
      </div>
    </DemoWrapper>
  );
}
