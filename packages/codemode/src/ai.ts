import { generateObject, tool, type ToolSet } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { compile as compileJsonSchemaToTs } from "json-schema-to-typescript";
import {
  zodToTs,
  printNode as printNodeZodToTs,
  createTypeAlias
} from "zod-to-ts";
import { getAgentByName } from "agents";
import { env, WorkerEntrypoint } from "cloudflare:workers";

function toCamelCase(str: string) {
  return str
    .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

export class CodeModeProxy extends WorkerEntrypoint<
  Cloudflare.Env,
  {
    binding: string;
    name: string;
    callback: string;
  }
> {
  async callFunction(options: { functionName: string; args: unknown[] }) {
    const stub = (await getAgentByName(
      // @ts-expect-error
      env[this.ctx.props.binding] as DurableObjectNamespace<T>,
      this.ctx.props.name
    )) as DurableObjectStub;
    // @ts-expect-error
    return stub[this.ctx.props.callback](options.functionName, options.args);
  }
}

export async function experimental_codemode(options: {
  tools: ToolSet;
  prompt: string;
  globalOutbound: Fetcher;
  loader: WorkerLoader;
  proxy: Fetcher<CodeModeProxy>;
}): Promise<{
  prompt: string;
  tools: ToolSet;
}> {
  const generatedTypes = await generateTypes(options.tools);
  const prompt = `You are a helpful assistant. You have access to the "codemode" tool that can do different things: 
  
  ${getToolDescriptions(options.tools)} 
  
  If the user asks to do anything that be achieveable by the codemode tool, then simply pass over control to it by giving it a simple function description. Don't be too verbose.
  
  `;

  const codemodeTool = tool({
    description: "codemode: a tool that can generate code to achieve a goal",
    inputSchema: z.object({
      functionDescription: z.string()
    }),
    outputSchema: z.object({
      code: z.string(),
      result: z.any()
    }),
    execute: async ({ functionDescription }) => {
      try {
        const response = await generateObject({
          model: openai("gpt-4.1"),
          schema: z.object({
            code: z.string()
          }),
          prompt: `You are a code generating machine.

      In addition to regular javascript, you can also use the following functions:

      ${generatedTypes}      

      Respond only with the code, nothing else. Output javascript code.

      Generate an async function that achieves the goal. This async function doesn't accept any arguments.

      Here is user input: ${functionDescription}` // insert ts types for the tools here
        });

        // console.log("args", response.object.args);
        const evaluator = createEvaluator(response.object.code, {
          proxy: options.proxy,
          loader: options.loader
        });
        const result = await evaluator();
        return { code: response.object.code, result: result };
      } catch (error) {
        console.error("error", error);
        throw error;
        // return { code: "", result: error };
      }
    }
  });

  return { prompt, tools: { codemode: codemodeTool } };
}

function createEvaluator(
  code: string,
  options: {
    loader: WorkerLoader;
    proxy: Fetcher<CodeModeProxy>;
  }
) {
  return async () => {
    const worker = options.loader.get(`code-${Math.random()}`, () => {
      return {
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "foo.js",
        modules: {
          "foo.js": `
import { env, WorkerEntrypoint } from "cloudflare:workers";

export default class CodeModeWorker extends WorkerEntrypoint {
  async evaluate() {
    try {
      const { CodeModeProxy } = env;
      const codemode = new Proxy(
        {},
        {
          get: (target, prop) => {
            return (args) => {
              return CodeModeProxy.callFunction({
                functionName: prop,
                args: args,                
              });
            };
          }
        }
      );

      return await ${code}();
    } catch (err) {
      return {
        err: err.message,
        stack: err.stack
      };
    }
  }
}
            
        `
        },
        env: {
          // insert keys and bindings to tools/ts functions here
          CodeModeProxy: options.proxy
        },
        globalOutbound: null
      };
    });

    // @ts-expect-error TODO: fix this
    return await worker.getEntrypoint().evaluate();
  };
}

async function generateTypes(tools: ToolSet) {
  let availableTools = "";
  let availableTypes = "";

  for (const [toolName, tool] of Object.entries(tools)) {
    // @ts-expect-error TODO: fix this
    const inputJsonType = tool.inputSchema.jsonSchema
      ? await compileJsonSchemaToTs(
          // @ts-expect-error TODO: fix this
          tool.inputSchema.jsonSchema,
          `${toCamelCase(toolName)}Input`,
          {
            format: false,
            bannerComment: " "
          }
        )
      : printNodeZodToTs(
          createTypeAlias(
            zodToTs(
              // @ts-expect-error TODO: fix this
              tool.inputSchema,
              `${toCamelCase(toolName)}Input`
            ).node,
            `${toCamelCase(toolName)}Input`
          )
        );

    const outputJsonType =
      // @ts-expect-error TODO: fix this
      tool.outputSchema?.jsonSchema
        ? await compileJsonSchemaToTs(
            // @ts-expect-error TODO: fix this
            tool.outputSchema?.jsonSchema,
            `${toCamelCase(toolName)}Output`,
            {
              format: false,
              bannerComment: " "
            }
          )
        : tool.outputSchema
          ? printNodeZodToTs(
              createTypeAlias(
                zodToTs(
                  // @ts-expect-error TODO: fix this
                  tool.outputSchema,
                  `${toCamelCase(toolName)}Output`
                ).node,
                `${toCamelCase(toolName)}Output`
              )
            )
          : `interface ${toCamelCase(toolName)}Output { [key: string]: any }`;

    const InputType = inputJsonType
      .trim()
      .replace("export interface", "interface");

    const OutputType = outputJsonType
      .trim()
      .replace("export interface", "interface");

    availableTypes += `\n${InputType}`;
    availableTypes += `\n${OutputType}`;
    availableTools += `\n\t/*\n\t${tool.description?.trim()}\n\t*/`;
    availableTools += `\n\t${toolName}: (input: ${toCamelCase(toolName)}Input) => Promise<${toCamelCase(toolName)}Output>;`;
    availableTools += "\n";
  }

  availableTools = `\ndeclare const codemode: {${availableTools}}`;

  return `
${availableTypes}
${availableTools}
      `;
}

function getToolDescriptions(tools: ToolSet) {
  return Object.entries(tools)
    .map(([_toolName, tool]) => {
      return `\n- ${tool.description?.trim()}`;
    })
    .join("");
}
