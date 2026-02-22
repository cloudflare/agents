/**
 * Client-side tool execution for the getLocalTime tool.
 * Called via the onToolCall callback in useAgentChat when the LLM
 * invokes a tool without a server-side execute function.
 */
export async function executeGetLocalTime(input: {
  location: string;
}): Promise<string> {
  console.log(`Getting local time for ${input.location}`);
  // Simulate async operation (in real app: use browser Intl API)
  await new Promise((res) => setTimeout(res, 1000));
  return `The local time in ${input.location} is ${new Date().toLocaleTimeString()}.`;
}
