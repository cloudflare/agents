import { Surface, Text, Button } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";

export function ToolsDemo() {
  return (
    <DemoWrapper
      title="Client-Side Tools"
      description="Tools without an execute function require client confirmation before running."
    >
      <div className="max-w-3xl space-y-6">
        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">How Client-Side Tools Work</Text>
          </div>

          <div className="space-y-4 text-sm text-kumo-subtle">
            <p>
              In the AI SDK, tools can be defined with or without an{" "}
              <code className="bg-kumo-control px-1 rounded text-kumo-default">
                execute
              </code>{" "}
              function:
            </p>

            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>
                <strong className="text-kumo-default">Server-side tools</strong>{" "}
                have an{" "}
                <code className="bg-kumo-control px-1 rounded text-kumo-default">
                  execute
                </code>{" "}
                function and run automatically
              </li>
              <li>
                <strong className="text-kumo-default">Client-side tools</strong>{" "}
                omit{" "}
                <code className="bg-kumo-control px-1 rounded text-kumo-default">
                  execute
                </code>{" "}
                and require the client to:
                <ol className="list-decimal list-inside ml-4 mt-1 space-y-1">
                  <li>Display a confirmation UI to the user</li>
                  <li>Execute the action if confirmed</li>
                  <li>
                    Report the result back via{" "}
                    <code className="bg-kumo-control px-1 rounded text-kumo-default">
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
        </Surface>

        <Surface className="p-6 rounded-lg ring ring-kumo-line">
          <div className="mb-4">
            <Text variant="heading3">Example Flow</Text>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-kumo-contrast text-kumo-inverse flex items-center justify-center text-xs shrink-0">
                1
              </div>
              <div>
                <Text bold size="sm">
                  User: "Send an email to bob@example.com"
                </Text>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-kumo-fill flex items-center justify-center text-xs shrink-0 text-kumo-default">
                2
              </div>
              <div>
                <Text bold size="sm">
                  AI decides to call <code>sendEmail</code> tool
                </Text>
                <Text variant="secondary" size="xs">
                  Tool state: "call" (pending)
                </Text>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-kumo-fill flex items-center justify-center text-xs shrink-0 text-kumo-default">
                3
              </div>
              <div>
                <Text bold size="sm">
                  Client shows confirmation dialog
                </Text>
                <div className="mt-2 p-3 bg-kumo-elevated rounded border border-kumo-line">
                  <div className="mb-2">
                    <Text size="sm">Send email to bob@example.com?</Text>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="primary" size="xs">
                      Confirm
                    </Button>
                    <Button variant="secondary" size="xs">
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-kumo-fill flex items-center justify-center text-xs shrink-0 text-kumo-default">
                4
              </div>
              <div>
                <Text bold size="sm">
                  User confirms - Client executes & reports result
                </Text>
                <code className="text-xs bg-kumo-control px-2 py-1 rounded block mt-1 text-kumo-default">
                  addToolOutput(&#123; toolCallId, output: &#123; sent: true
                  &#125; &#125;)
                </code>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center text-xs shrink-0">
                5
              </div>
              <div>
                <Text bold size="sm">
                  AI continues with the result
                </Text>
                <Text variant="secondary" size="xs">
                  "Done! I've sent the email to bob@example.com"
                </Text>
              </div>
            </div>
          </div>
        </Surface>

        <Surface className="p-4 rounded-lg bg-kumo-elevated">
          <Text variant="secondary" size="sm">
            <strong className="text-kumo-default">Tip:</strong> Test this in the
            Chat demo by asking the AI to "send an email" or "delete a file".
            You'll see the tool call appear but the AI will wait for
            confirmation.
          </Text>
        </Surface>
      </div>
    </DemoWrapper>
  );
}
