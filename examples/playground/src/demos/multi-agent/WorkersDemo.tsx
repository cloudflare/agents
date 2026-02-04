import { DemoWrapper } from "../../layout";

export function WorkersDemo() {
  return (
    <DemoWrapper
      title="Workers Pattern"
      description="Fan-out parallel processing with a manager agent delegating to multiple worker agents."
    >
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Diagram */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Architecture</h3>
          <div className="flex flex-col items-center">
            {/* Manager */}
            <div className="bg-black dark:bg-white text-white dark:text-black px-6 py-3 rounded-lg font-medium">
              ManagerAgent
            </div>

            {/* Lines */}
            <div className="flex items-center gap-8 my-4">
              <div className="w-px h-8 bg-neutral-300 dark:bg-neutral-600" />
              <div className="w-px h-8 bg-neutral-300 dark:bg-neutral-600" />
              <div className="w-px h-8 bg-neutral-300 dark:bg-neutral-600" />
            </div>

            {/* Fork */}
            <div className="w-64 h-px bg-neutral-300 dark:bg-neutral-600" />

            {/* More lines */}
            <div className="flex items-center gap-8 my-4">
              <div className="w-px h-8 bg-neutral-300 dark:bg-neutral-600" />
              <div className="w-px h-8 bg-neutral-300 dark:bg-neutral-600" />
              <div className="w-px h-8 bg-neutral-300 dark:bg-neutral-600" />
            </div>

            {/* Workers */}
            <div className="flex gap-4">
              <div className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 rounded border border-neutral-200 dark:border-neutral-700">
                Worker 1
              </div>
              <div className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 rounded border border-neutral-200 dark:border-neutral-700">
                Worker 2
              </div>
              <div className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 rounded border border-neutral-200 dark:border-neutral-700">
                Worker N
              </div>
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">How It Works</h3>
          <div className="space-y-4 text-neutral-600 dark:text-neutral-300">
            <p>
              The Workers pattern uses a central <strong>ManagerAgent</strong>{" "}
              that distributes tasks across multiple{" "}
              <strong>WorkerAgent</strong> instances for parallel processing.
            </p>
            <ol className="list-decimal list-inside space-y-2">
              <li>Manager receives a batch of work items</li>
              <li>
                Manager spawns N worker agents using{" "}
                <code className="text-xs bg-neutral-200 dark:bg-neutral-700 px-1 rounded">
                  getAgentByName()
                </code>
              </li>
              <li>Each worker processes its assigned items concurrently</li>
              <li>Manager aggregates results from all workers</li>
            </ol>
          </div>
        </div>

        {/* Code Example */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Example Code</h3>
          <pre className="bg-neutral-50 dark:bg-neutral-900 p-4 rounded overflow-x-auto text-sm">
            {`// manager-agent.ts
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
          </pre>
        </div>

        {/* Use Cases */}
        <div className="card p-6">
          <h3 className="font-semibold mb-4">Use Cases</h3>
          <ul className="space-y-3 text-neutral-600 dark:text-neutral-300">
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>Batch Processing</strong> — Process large datasets by
                splitting work across workers
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>Parallel API Calls</strong> — Fan out requests to
                external APIs without blocking
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>Map-Reduce</strong> — Distribute computation and
                aggregate results
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-neutral-400">•</span>
              <div>
                <strong>Image Processing</strong> — Process multiple images
                concurrently
              </div>
            </li>
          </ul>
        </div>

        {/* Considerations */}
        <div className="card p-6 bg-neutral-50 dark:bg-neutral-800">
          <h3 className="font-semibold mb-4">Considerations</h3>
          <ul className="space-y-2 text-sm text-neutral-600 dark:text-neutral-300">
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
        </div>
      </div>
    </DemoWrapper>
  );
}
