import { Surface, Text, CodeBlock } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";

export function WorkersDemo() {
  return (
    <DemoWrapper
      title="Workers Pattern"
      description="Fan-out parallel processing with a manager agent delegating to multiple worker agents."
    >
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Diagram */}
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Architecture</Text>
          </div>
          <div className="flex flex-col items-center">
            {/* Manager */}
            <div className="bg-kumo-contrast text-kumo-inverse px-6 py-3 rounded-lg font-medium">
              ManagerAgent
            </div>

            {/* Lines */}
            <div className="flex items-center gap-8 my-4">
              <div className="w-px h-8 bg-kumo-line" />
              <div className="w-px h-8 bg-kumo-line" />
              <div className="w-px h-8 bg-kumo-line" />
            </div>

            {/* Fork */}
            <div className="w-64 h-px bg-kumo-line" />

            {/* More lines */}
            <div className="flex items-center gap-8 my-4">
              <div className="w-px h-8 bg-kumo-line" />
              <div className="w-px h-8 bg-kumo-line" />
              <div className="w-px h-8 bg-kumo-line" />
            </div>

            {/* Workers */}
            <div className="flex gap-4">
              <div className="bg-kumo-control px-4 py-2 rounded border border-kumo-line text-kumo-default">
                Worker 1
              </div>
              <div className="bg-kumo-control px-4 py-2 rounded border border-kumo-line text-kumo-default">
                Worker 2
              </div>
              <div className="bg-kumo-control px-4 py-2 rounded border border-kumo-line text-kumo-default">
                Worker N
              </div>
            </div>
          </div>
        </Surface>

        {/* Description */}
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">How It Works</Text>
          </div>
          <div className="space-y-4 text-kumo-subtle">
            <p>
              The Workers pattern uses a central{" "}
              <strong className="text-kumo-default">ManagerAgent</strong> that
              distributes tasks across multiple{" "}
              <strong className="text-kumo-default">WorkerAgent</strong>{" "}
              instances for parallel processing.
            </p>
            <ol className="list-decimal list-inside space-y-2">
              <li>Manager receives a batch of work items</li>
              <li>
                Manager spawns N worker agents using{" "}
                <code className="text-xs bg-kumo-control px-1 rounded text-kumo-default">
                  getAgentByName()
                </code>
              </li>
              <li>Each worker processes its assigned items concurrently</li>
              <li>Manager aggregates results from all workers</li>
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
            code={`// manager-agent.ts
@callable()
async processItems(items: string[]) {
  const chunkSize = Math.ceil(items.length / 4);
  const chunks = [];
  
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  
  // Spawn workers in parallel
  const results = await Promise.all(
    chunks.map(async (chunk, i) => {
      const worker = await getAgentByName(
        this.env.WorkerAgent,
        \`worker-\${i}\`
      );
      return worker.processChunk(chunk);
    })
  );
  
  // Aggregate results
  return results.flat();
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
                <strong className="text-kumo-default">Batch Processing</strong>{" "}
                — Process large datasets by splitting work across workers
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-kumo-inactive">•</span>
              <div>
                <strong className="text-kumo-default">
                  Parallel API Calls
                </strong>{" "}
                — Fan out requests to external APIs without blocking
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-kumo-inactive">•</span>
              <div>
                <strong className="text-kumo-default">Map-Reduce</strong> —
                Distribute computation and aggregate results
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-kumo-inactive">•</span>
              <div>
                <strong className="text-kumo-default">Image Processing</strong>{" "}
                — Process multiple images concurrently
              </div>
            </li>
          </ul>
        </Surface>

        {/* Considerations */}
        <Surface className="p-6 rounded-lg bg-kumo-elevated">
          <div className="mb-4">
            <Text variant="heading3">Considerations</Text>
          </div>
          <ul className="space-y-2 text-sm text-kumo-subtle">
            <li>
              • Workers are Durable Objects — each has isolated state and
              single-threaded execution
            </li>
            <li>
              • Use unique names for ephemeral workers, or stable names for
              long-lived workers
            </li>
            <li>• Consider error handling and partial failure scenarios</li>
            <li>
              • Monitor worker count to avoid spawning too many concurrent
              agents
            </li>
          </ul>
        </Surface>
      </div>
    </DemoWrapper>
  );
}
