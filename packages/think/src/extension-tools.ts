/**
 * The tools a set of harness extensions offers, outside the harness: what
 * the class Think merges into a turn from the same extension functions the
 * harness-backed Think loads. Only their tool transforms apply; the class
 * runs its own prompt and hooks.
 *
 * @internal Not exported from any entry point.
 */
import type { ToolSet } from "ai";
import type { ThinkExtension } from "./harness/extensions/workspace";

type ToolTransform = (
  draft: { set(name: string, tool: ToolSet[string]): void },
  build: { readonly session: string }
) => void | Promise<void>;

/** Run each extension's tool transforms, in order, over one tool set. */
export async function extensionTools(
  extensions: readonly ThinkExtension[]
): Promise<ToolSet> {
  const transforms: ToolTransform[] = [];
  for (const extension of extensions) {
    await extension({
      name: "class",
      tools: {
        transform: (change: unknown) =>
          transforms.push(change as unknown as ToolTransform)
      },
      prompt: { transform: () => {} },
      on: () => {}
    } as unknown as Parameters<ThinkExtension>[0]);
  }
  const tools: ToolSet = {};
  const draft = {
    set: (name: string, tool: ToolSet[string]) => {
      tools[name] = tool;
    }
  };
  for (const transform of transforms) await transform(draft, { session: "" });
  return tools;
}
