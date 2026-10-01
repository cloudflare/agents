import type { ToolSet } from "ai";
import { createTestingTools } from "../tools/testing/ai";

// The toolbox is meant to be returned from `getTools()` or passed to
// `streamText`, both of which take a ToolSet.
const tools: ToolSet = createTestingTools();
void tools;

createTestingTools({ bytes: () => fetch("https://example.com/bytes") });

void createTestingTools().sleep.execute?.(
  // @ts-expect-error sleep requires a duration
  {},
  { toolCallId: "call-1", messages: [], context: {} }
);
