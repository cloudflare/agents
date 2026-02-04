import { DemoWrapper } from "../../layout";

export function PipelineDemo() {
  return (
    <DemoWrapper
      title="Pipeline Pattern"
      description="Chain of responsibility where data flows through a series of processing agents."
    >
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Diagram */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Architecture</h3>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            {/* Input */}
            <div className="text-sm text-neutral-500 dark:text-neutral-400">
              Input
            </div>
            <div className="w-8 h-px bg-neutral-300 dark:bg-neutral-600" />

            {/* Stage 1 */}
            <div className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 rounded border border-neutral-200 dark:border-neutral-700">
              ValidatorAgent
            </div>
            <div className="w-8 h-px bg-neutral-300 dark:bg-neutral-600" />

            {/* Stage 2 */}
            <div className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 rounded border border-neutral-200 dark:border-neutral-700">
              TransformAgent
            </div>
            <div className="w-8 h-px bg-neutral-300 dark:bg-neutral-600" />

            {/* Stage 3 */}
            <div className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 rounded border border-neutral-200 dark:border-neutral-700">
              EnricherAgent
            </div>
            <div className="w-8 h-px bg-neutral-300 dark:bg-neutral-600" />

            {/* Stage 4 */}
            <div className="bg-black dark:bg-white text-white dark:text-black px-4 py-2 rounded">
              StorageAgent
            </div>
            <div className="w-8 h-px bg-neutral-300 dark:bg-neutral-600" />

            {/* Output */}
            <div className="text-sm text-neutral-500 dark:text-neutral-400">
              Output
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">How It Works</h3>
          <div className="space-y-4 text-neutral-600 dark:text-neutral-300">
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
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  getAgentByName()
                </code>
              </li>
              <li>Final stage returns or stores the processed result</li>
            </ol>
          </div>
        </div>

        {/* Code Example */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Example Code</h3>
          <pre className="bg-neutral-50 dark:bg-neutral-900 p-4 rounded overflow-x-auto text-sm">
            {`// validator-agent.ts
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
          </pre>
        </div>

        {/* Use Cases */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Use Cases</h3>
          <ul className="space-y-3 text-neutral-600 dark:text-neutral-300">
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>ETL Pipelines</strong> — Extract, transform, and load
                data through stages
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>Validation Chains</strong> — Multi-step validation with
                different rules per stage
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>Document Processing</strong> — Parse, analyze,
                summarize, store
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>Order Processing</strong> — Validate → Reserve Inventory
                → Charge → Ship
              </div>
            </li>
          </ul>
        </div>

        {/* Variations */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Variations</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Linear Pipeline</h4>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Data flows A → B → C → D in order
              </p>
            </div>
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Branching Pipeline</h4>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Stage can route to different next stages based on data
              </p>
            </div>
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Saga Pipeline</h4>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Each stage has a compensating action for rollback
              </p>
            </div>
            <div className="p-4 bg-neutral-50 dark:bg-neutral-800 rounded">
              <h4 className="font-medium mb-2">Async Pipeline</h4>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Stages are decoupled via queues for resilience
              </p>
            </div>
          </div>
        </div>

        {/* Considerations */}
        <div className="card p-6 bg-neutral-50 dark:bg-neutral-800">
          <h3 className="font-semibold mb-4">Considerations</h3>
          <ul className="space-y-2 text-sm text-neutral-600 dark:text-neutral-300">
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
        </div>
      </div>
    </DemoWrapper>
  );
}
