import { DemoWrapper } from "../../layout";

export function ToolsDemo() {
  return (
    <DemoWrapper
      title="Client-Side Tools"
      description="Tools without an execute function require client confirmation before running."
    >
      <div className="max-w-3xl space-y-6">
        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">
            How Client-Side Tools Work
          </h3>

          <div className="space-y-4 text-sm text-neutral-600 dark:text-neutral-400">
            <p>
              In the AI SDK, tools can be defined with or without an{" "}
              <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                execute
              </code>{" "}
              function:
            </p>

            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>
                <strong>Server-side tools</strong> have an{" "}
                <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                  execute
                </code>{" "}
                function and run automatically
              </li>
              <li>
                <strong>Client-side tools</strong> omit{" "}
                <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                  execute
                </code>{" "}
                and require the client to:
                <ol className="list-decimal list-inside ml-4 mt-1 space-y-1">
                  <li>Display a confirmation UI to the user</li>
                  <li>Execute the action if confirmed</li>
                  <li>
                    Report the result back via{" "}
                    <code className="bg-neutral-100 dark:bg-neutral-700 px-1 rounded">
                      addToolOutput()
                    </code>
                  </li>
                </ol>
              </li>
            </ul>

            <p>This pattern is useful for sensitive operations like:</p>

            <ul className="list-disc list-inside ml-4">
              <li>Sending emails or messages</li>
              <li>Deleting files or data</li>
              <li>Making purchases</li>
              <li>Executing code</li>
            </ul>
          </div>
        </div>

        <div className="card p-6">
          <h3 className="font-semibold text-lg mb-4">Example Flow</h3>

          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-black text-white flex items-center justify-center text-xs flex-shrink-0">
                1
              </div>
              <div>
                <p className="font-medium">
                  User: "Send an email to bob@example.com"
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center text-xs flex-shrink-0">
                2
              </div>
              <div>
                <p className="font-medium">
                  AI decides to call <code>sendEmail</code> tool
                </p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  Tool state: "call" (pending)
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center text-xs flex-shrink-0">
                3
              </div>
              <div>
                <p className="font-medium">Client shows confirmation dialog</p>
                <div className="mt-2 p-3 bg-neutral-50 dark:bg-neutral-800 rounded border dark:border-neutral-700">
                  <p className="text-sm mb-2">Send email to bob@example.com?</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-primary text-xs py-1"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary text-xs py-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-700 flex items-center justify-center text-xs flex-shrink-0">
                4
              </div>
              <div>
                <p className="font-medium">
                  User confirms → Client executes & reports result
                </p>
                <code className="text-xs bg-neutral-100 dark:bg-neutral-700 px-2 py-1 rounded block mt-1">
                  addToolOutput(&#123; toolCallId, output: &#123; sent: true
                  &#125; &#125;)
                </code>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-green-600 text-white flex items-center justify-center text-xs flex-shrink-0">
                5
              </div>
              <div>
                <p className="font-medium">AI continues with the result</p>
                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                  "Done! I've sent the email to bob@example.com"
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="card p-4 bg-neutral-50 dark:bg-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <strong>Tip:</strong> Test this in the Chat demo by asking the AI to
            "send an email" or "delete a file". You'll see the tool call appear
            but the AI will wait for confirmation.
          </p>
        </div>
      </div>
    </DemoWrapper>
  );
}
