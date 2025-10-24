/** biome-ignore-all lint/correctness/useUniqueElementIds: it's fine */
import { useChat } from "@ai-sdk/react";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import TextareaAutosize from "react-textarea-autosize";
import FinetuneSelector from "./components/FinetuneSelector";
import Footer from "./components/Footer";
import Header from "./components/Header";
import { SparkleIcon } from "./components/Icons";
import { McpServers } from "./components/McpServers";
import ModelSelector from "./components/ModelSelector";
import { models } from "./models";
import ViewCodeModal from "./components/ViewCodeModal";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls
} from "ai";

const finetuneTemplates = {
  "cf-public-cnn-summarization": `You are given a news article below. Please summarize the article, including only its highlights.

### Article: 

### Summary:`,
  "cf-public-jigsaw-classification": `You are a helpful, precise, detailed, and concise artificial intelligence assistant. You are a very intelligent and sensitive, having a keen ability to discern whether or not a text message is toxic. You can also be trusted with following the instructions given to you precisely, without deviations.
In this task, you are asked to decide whether or not comment text is toxic.
Toxic content harbors negativity towards a person or a group, for instance:
  - stereotyping (especially using negative stereotypes)
  - disparaging a person's gender -- as in "male", "female", "men", "women"
  - derogatory language or slurs
  - racism -- as in discriminating toward people who are "black", "white"
  - cultural appropriation
  - mockery or ridicule
  - sexual objectification
  - homophobia -- bullying people who are "homosexual", "gay", "lesbian"
  - historical insensitivity
  - disrespecting religion -- as in "christian", "jewish", "muslim"
  - saying that certain groups are less worthy of respect
  - insensitivity to health conditions -- as in "psychiatric/mental illness"

Read the comment text provided and predict whether or not the comment text is toxic. If comment text is toxic according to the instructions, then the answer is "yes" (return "yes"); otherwise, the answer is "no" (return "no").
Output the answer only as a "yes" or a "no"; do not provide explanations.
Please, never return empty output; always return a "yes" or a "no" answer.
You will be evaluated based on the following criteria: - The generated answer is always "yes" or "no" (never the empty string, ""). - The generated answer is correct for the comment text presented to you.
### Comment Text: 
### Comment Text Is Toxic (Yes/No):`
};

export type Params = {
  model: keyof AiModels;
  max_tokens: number;
  stream: boolean;
  lora: string | null;
};

type CallableTool = Tool & {
  callTool: (args: Record<string, any>) => Promise<CallToolResult>;
};

const App = () => {
  const queryParams = new URLSearchParams(document.location.search);
  const selectedModel = queryParams.get("model");
  const selectedFinetune = queryParams.get("finetune");

  const defaultModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const [params, setParams] = useState<Params>(() => {
    // Try to get stored model from sessionStorage
    const storedModel = sessionStorage.getItem("selectedModel");

    return {
      lora: selectedFinetune || null,
      max_tokens: 512,
      model: (selectedModel || storedModel || defaultModel) as keyof AiModels,
      stream: true
    };
  });

  const [error, setError] = useState("");
  const [codeVisible, setCodeVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [systemMessage, setSystemMessage] = useState(
    "You are a helpful assistant"
  );
  const [mcpTools, setMcpTools] = useState<CallableTool[]>([]);
  const mcpToolsRef = useRef<CallableTool[]>([]);

  useEffect(() => {
    // we do this to make the latest mcpTools
    // available to the onToolCall callback
    // which otherwise has a stale closure
    mcpToolsRef.current = mcpTools;
  }, [mcpTools]);

  const [input, setInput] = useState("");
  function getBody() {
    return {
      lora: params.lora,
      max_tokens: params.max_tokens,
      model: params.model,
      stream: params.stream,
      system_message: systemMessage,
      tools: mcpToolsRef.current
    };
  }

  const handleSubmit = (e: any) => {
    e.preventDefault();
    sendMessage({ text: input }, { body: getBody() });
    setInput("");
  };

  const { messages, status, setMessages, sendMessage, addToolResult } = useChat(
    {
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,

      transport: new DefaultChatTransport({
        api: "/api/inference",
        credentials: "include"
      }),
      async onToolCall({ toolCall }) {
        try {
          const mcpTool = mcpToolsRef.current.find(
            (t) => t.name === toolCall.toolName
          );
          if (mcpTool) {
            const { input } = toolCall as { input: Record<string, any> };
            // convert any args from string to number if their schema says they should be
            const convertedArgs = Object.fromEntries(
              Object.entries(input).map(([key, value]) => {
                if (
                  (mcpTool.inputSchema.properties?.[key] as any)?.type ===
                    "number" &&
                  typeof value === "string"
                ) {
                  return [key, Number(value)];
                }
                return [key, value];
              })
            );
            const calledTool = await mcpTool.callTool(convertedArgs);
            if (Array.isArray(calledTool?.content)) {
              calledTool.content.forEach((c) => {
                if (c.type === "image") {
                  // Extract the base64 data and mime type
                  const { data, mimeType } = c;
                  const binaryData = atob(data);

                  // Create an array buffer from the binary data
                  const arrayBuffer = new Uint8Array(binaryData.length);
                  for (let i = 0; i < binaryData.length; i++) {
                    arrayBuffer[i] = binaryData.charCodeAt(i);
                  }

                  // Create a blob from the array buffer
                  const blob = new Blob([arrayBuffer], { type: mimeType });

                  // Create a URL for the blob
                  const blobUrl = URL.createObjectURL(blob);

                  // Return a description of the received data
                  addToolResult({
                    tool: toolCall.toolName,
                    toolCallId: toolCall.toolCallId,
                    output: `Received image: ${mimeType}, size: ${Math.round(data.length / 1024)}KB\n[${blobUrl}]`
                  });
                }
                addToolResult({
                  tool: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                  output: c.text
                });
              });
            } else {
              addToolResult({
                tool: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                output: `Sorry, something went wrong. Got this response: ${JSON.stringify(calledTool)}`
              });
            }
          }
        } catch (e) {
          console.log(e);
          throw e;
        }
      }
    }
  );

  const loading = status === "submitted";
  const streaming = status === "streaming";

  const messageElement = useRef<HTMLDivElement>(null);

  useHotkeys("meta+enter, ctrl+enter", (e) => handleSubmit(e), {
    enableOnFormTags: ["textarea"]
  });

  const activeModel = models.find((model) => model.name === params.model);

  return (
    <main className="w-full h-full bg-gray-50 md:px-6">
      <ViewCodeModal
        params={params}
        messages={messages}
        visible={codeVisible}
        handleHide={(e) => {
          e.stopPropagation();
          setCodeVisible(false);
        }}
      />

      <div className="h-full max-w-[1400px] mx-auto items-start md:pb-[168px]">
        <Header onSetCodeVisible={setCodeVisible} />

        <div className="flex h-full md:pb-8 items-start md:flex-row flex-col">
          <div className="md:w-1/3 w-full h-full md:overflow-auto bg-white md:rounded-md shadow-md md:block z-10">
            <div className="bg-ai h-[3px]" />
            <section className="rounded-lg bg-white p-4">
              <div className="flex align-middle">
                <span className="text-lg font-semibold">
                  Workers AI LLM Playground
                </span>
                <div className="ml-3 mt-1">
                  <svg
                    width="20"
                    height="19"
                    viewBox="0 0 20 19"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <title>Workers AI Logo</title>
                    <path
                      d="M12.5308 1.03827L12.6216 1.59529C13.1993 5.14062 16.1116 7.84036 19.6905 8.14824C16.1135 8.45595 13.2049 11.1586 12.6359 14.7035L12.5308 15.3581L12.4257 14.7035C11.8567 11.1586 8.94812 8.45595 5.37109 8.14824C8.94997 7.84036 11.8623 5.14062 12.44 1.59529L12.5308 1.03827Z"
                      fill="url(#paint0_linear_1012_8647)"
                    />
                    <path
                      d="M2.92921 0.712708L2.96222 0.915259C3.1723 2.20447 4.23133 3.1862 5.53274 3.29815C4.232 3.41005 3.17434 4.39284 2.96742 5.68188L2.92921 5.91992L2.891 5.68188C2.68409 4.39284 1.62642 3.41005 0.325684 3.29815C1.62709 3.1862 2.68612 2.20447 2.89621 0.915259L2.92921 0.712708Z"
                      fill="url(#paint1_linear_1012_8647)"
                    />
                    <path
                      d="M2.92897 12.4291L2.9661 12.6569C3.20245 14.1073 4.39385 15.2118 5.85794 15.3377C4.39461 15.4636 3.20474 16.5692 2.97196 18.0194L2.92897 18.2872L2.88598 18.0194C2.6532 16.5692 1.46333 15.4636 0 15.3377C1.46409 15.2118 2.65549 14.1073 2.89184 12.6569L2.92897 12.4291Z"
                      fill="url(#paint2_linear_1012_8647)"
                    />
                    <defs>
                      <linearGradient
                        id="paint0_linear_1012_8647"
                        x1="5.37109"
                        y1="9.74315"
                        x2="19.7084"
                        y2="5.85333"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#901475" />
                        <stop offset="0.505208" stopColor="#CE2F55" />
                        <stop offset="1" stopColor="#FF6633" />
                      </linearGradient>
                      <linearGradient
                        id="paint1_linear_1012_8647"
                        x1="0.325684"
                        y1="3.87812"
                        x2="5.53925"
                        y2="2.46364"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#901475" />
                        <stop offset="0.505208" stopColor="#CE2F55" />
                        <stop offset="1" stopColor="#FF6633" />
                      </linearGradient>
                      <linearGradient
                        id="paint2_linear_1012_8647"
                        x1="-5.51246e-08"
                        y1="15.9902"
                        x2="5.86526"
                        y2="14.3989"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop stopColor="#901475" />
                        <stop offset="0.505208" stopColor="#CE2F55" />
                        <stop offset="1" stopColor="#FF6633" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
                <button
                  type="button"
                  className="ml-auto rounded-md border border-gray-200 px-2 py-1 -mt-1 md:hidden"
                  onClick={() => setSettingsVisible(!settingsVisible)}
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 22 22"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <title>Settings</title>
                    <path
                      d="M11.0001 7.5625C10.3202 7.5625 9.65558 7.76411 9.09029 8.14182C8.52499 8.51954 8.0844 9.05641 7.82422 9.68453C7.56405 10.3126 7.49597 11.0038 7.62861 11.6706C7.76125 12.3374 8.08864 12.9499 8.56938 13.4307C9.05012 13.9114 9.66263 14.2388 10.3294 14.3714C10.9962 14.5041 11.6874 14.436 12.3155 14.1758C12.9437 13.9157 13.4805 13.4751 13.8582 12.9098C14.236 12.3445 14.4376 11.6799 14.4376 11C14.4376 10.0883 14.0754 9.21398 13.4307 8.56932C12.7861 7.92466 11.9117 7.5625 11.0001 7.5625ZM11.0001 13.0625C10.5921 13.0625 10.1934 12.9415 9.8542 12.7149C9.51502 12.4883 9.25066 12.1662 9.09456 11.7893C8.93845 11.4124 8.89761 10.9977 8.97719 10.5976C9.05677 10.1975 9.2532 9.83004 9.54165 9.54159C9.8301 9.25315 10.1976 9.05671 10.5977 8.97713C10.9978 8.89755 11.4125 8.93839 11.7893 9.0945C12.1662 9.2506 12.4883 9.51496 12.715 9.85414C12.9416 10.1933 13.0626 10.5921 13.0626 11C13.0626 11.547 12.8453 12.0716 12.4585 12.4584C12.0717 12.8452 11.5471 13.0625 11.0001 13.0625Z"
                      fill="#797979"
                    />
                    <path
                      d="M17.1532 11L19.7107 8.52844L17.4832 4.67156L14.1351 5.63062L13.2379 2.0625H8.76912L7.90631 5.63062L4.53756 4.67156L2.31006 8.53187L4.88131 11.0172L2.31006 13.5059L4.53756 17.3628L7.90631 16.4003L8.78287 19.9375H13.2516L14.1351 16.4106L17.5244 17.38L19.7554 13.5231L17.1532 11ZM16.8438 15.7472L13.8429 14.8844L12.9216 15.5203L12.1654 18.5625H9.85537L9.09912 15.5375L8.20881 14.8844L5.19068 15.7472L4.03568 13.75L6.28381 11.5775V10.4637L4.03568 8.28781L5.19068 6.28719L8.21225 7.15344L9.10256 6.44187L9.85537 3.4375H12.1654L12.9216 6.45563L13.8085 7.16719L16.8438 6.28719L17.9988 8.28781L15.7472 10.4637L15.7816 11.5741L18.0126 13.75L16.8438 15.7472Z"
                      fill="#797979"
                    />
                  </svg>
                </button>
              </div>

              <p className="text-gray-400 text-sm mt-1 mb-4">
                Explore different Text Generation models by drafting messages
                and fine-tuning your responses.
              </p>

              <div className="md:mb-4">
                {
                  <ModelSelector
                    models={models}
                    model={activeModel}
                    onModelSelection={(model) => {
                      const modelName = model ? model.name : defaultModel;
                      // Store selected model in sessionStorage
                      sessionStorage.setItem("selectedModel", modelName);
                      setParams({
                        ...params,
                        lora: null,
                        model: modelName
                      });
                    }}
                  />
                }
              </div>

              {activeModel?.finetunes && (
                <div className="md:mb-4">
                  <FinetuneSelector
                    models={[null, ...activeModel.finetunes]}
                    model={params.lora}
                    onSelection={(model) => {
                      setParams({
                        ...params,
                        lora: model ? model.name : null
                      });
                      setMessages([
                        {
                          parts: [
                            {
                              type: "text",
                              text:
                                finetuneTemplates[
                                  model?.name as keyof typeof finetuneTemplates
                                ] || ""
                            }
                          ],
                          id: "0",
                          role: "user"
                        }
                      ]);
                    }}
                  />
                </div>
              )}

              <div
                className={`mt-4 md:block ${settingsVisible ? "block" : "hidden"}`}
              >
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="font-semibold text-sm block mb-1">
                  System Message
                </label>
                <TextareaAutosize
                  className="w-full p-2 border border-gray-200 rounded-md resize-none hover:bg-gray-50"
                  minRows={4}
                  value={systemMessage}
                  onChange={(e) => setSystemMessage(e.target.value)}
                />
              </div>
              <div
                className={`mt-4 md:block ${settingsVisible ? "block" : "hidden"}`}
              >
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="font-semibold text-sm block mb-1">
                  Maximum Output Length (Tokens)
                </label>
                <div className="flex items-center p-2 border border-gray-200 rounded-md ">
                  <input
                    className="w-full appearance-none cursor-pointer bg-ai rounded-full h-2 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_#901475]"
                    type="range"
                    min={1}
                    max={2048}
                    value={params.max_tokens}
                    onChange={(e) =>
                      setParams({
                        ...params,
                        max_tokens: Number.parseInt(e.target.value, 10)
                      })
                    }
                  />
                  <span className="ml-3 text-md text-gray-800 w-12 text-right">
                    {params.max_tokens}
                  </span>
                </div>
              </div>

              <div className="mb-4 hidden">
                {/* biome-ignore lint/a11y/noLabelWithoutControl: eh */}
                <label className="text-gray-600 text-sm block mb-1">
                  Streaming
                </label>
                <div className="p-2 border border-gray-200 rounded-md">
                  <input
                    type="checkbox"
                    checked={params.stream}
                    onChange={(e) =>
                      setParams({ ...params, stream: e.target.checked })
                    }
                  />
                </div>
              </div>
            </section>

            {activeModel?.properties.find(
              (p) => p.property_id === "function_calling" && p.value === "true"
            ) ? (
              <>
                <div className="bg-ai h-px mx-2 mt-2 opacity-25" />
                <McpServers onToolsUpdate={setMcpTools} />
              </>
            ) : null}
          </div>

          <div
            ref={messageElement}
            className="md:w-2/3 w-full h-full md:ml-6 md:rounded-lg md:shadow-md bg-white relative overflow-auto flex flex-col"
          >
            <div className="bg-ai h-[3px] hidden md:block" />
            <ul className="pb-6 px-6 pt-6">
              {messages.map((message) => (
                <div key={message.id}>
                  {!message.parts.some((p) => p.type !== "text") ? null : (
                    <li className="mb-3 flex flex-col items-start border-b border-b-gray-100 w-full pb-3">
                      {message.parts.map((part, i) =>
                        part.type === "file" ? (
                          part.mediaType.startsWith("image/") ? (
                            <img
                              // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
                              key={i}
                              className="max-w-md mx-auto"
                              src={part.url}
                              // biome-ignore lint/a11y/noRedundantAlt: it's fine
                              alt="Image from tool call response"
                            />
                          ) : null
                        ) : part.type.startsWith("tool-") &&
                          /* let's assert this to tell typescript it's a tool call*/ "input" in
                            part ? (
                          // biome-ignore lint/suspicious/noArrayIndexKey: <expla nation>
                          <div key={i}>
                            <div className="w-full text-center italic text-xs text-gray-400 font-mono max-h-20 overflow-auto break-all px-2 whitespace-pre-line">
                              [tool] {part.type}({JSON.stringify(part.input)})
                              =&gt;&nbsp;
                              {part.state === "input-available" &&
                              status === "ready"
                                ? "awaiting confirmation..."
                                : part.state === "input-available"
                                  ? "pending..."
                                  : part.state === "output-available"
                                    ? (part.output as string)
                                    : null}
                            </div>
                            {part.state === "output-available" &&
                            (part.output as string).match(/\[blob:.*]/) ? (
                              <img
                                className="block max-w-md mx-auto mt-3"
                                src={
                                  (part.output as string).match(
                                    /\[(blob:.*)]/
                                  )![1]
                                }
                                // biome-ignore lint/a11y/noRedundantAlt: it's fine
                                alt="Image from tool call response"
                              />
                            ) : null}
                          </div>
                        ) : null
                      )}
                    </li>
                  )}
                  {message.parts.some((p) => p.type === "text") ? (
                    <li className="mb-3 flex items-start border-b border-b-gray-100 w-full py-2">
                      <div className="mr-3 w-[80px]">
                        <button
                          type="button"
                          className={`px-3 py-2 bg-orange-100 hover:bg-orange-200 rounded-lg text-sm capitalize cursor-pointer ${
                            (streaming || loading) && "pointer-events-none"
                          }`}
                        >
                          {message.role}
                        </button>
                      </div>
                      <div className="relative grow">
                        <TextareaAutosize
                          className={`rounded-md p-3 w-full resize-none mt-[-6px] hover:bg-gray-50 ${
                            (streaming || loading) && "pointer-events-none"
                          }`}
                          value={message.parts
                            .filter((p) => p.type === "text")
                            .map((p) => p.text)
                            .join("")}
                          disabled={true}
                          onChange={(e) => setInput(e.target.value)}
                        />
                      </div>
                    </li>
                  ) : null}
                </div>
              ))}

              {!loading ? null : (
                <li className="mb-3 flex items-start border-b border-b-gray-100 w-full py-2">
                  <div className="mr-3 w-[80px]">
                    <button
                      type="button"
                      className="px-3 py-2 bg-orange-100 hover:bg-orange-200 rounded-lg text-sm capitalize cursor-pointer pointer-events-none"
                    >
                      Assistant
                    </button>
                  </div>
                  <div className="relative grow">
                    <TextareaAutosize
                      className="rounded-md p-3 w-full resize-none mt-[-6px] hover:bg-gray-50 pointer-events-none"
                      value="..."
                      disabled={true}
                      onChange={(e) => setInput(e.target.value)}
                    />
                  </div>
                </li>
              )}

              {/*{messages.map((message, idx) =>*/}
              {/*  message.role === 'system' ? null : (*/}
              {loading || streaming ? null : (
                <li className="mb-3 flex items-start border-b border-b-gray-100 w-full py-2">
                  <div className="mr-3 w-[80px]">
                    <button
                      type="button"
                      className="px-3 py-2 bg-orange-100 hover:bg-orange-200 rounded-lg text-sm capitalize cursor-pointer"
                    >
                      User
                    </button>
                  </div>

                  <div className="relative grow">
                    <TextareaAutosize
                      className="rounded-md p-3 w-full resize-none mt-[-6px] hover:bg-gray-50"
                      placeholder="Enter a message..."
                      value={input}
                      disabled={loading || streaming}
                      onChange={(e) => setInput(e.target.value)}
                    />
                  </div>
                </li>
              )}
            </ul>

            <div className="sticky mt-auto bottom-0 left-0 right-0 bg-white flex items-center p-5 border-t border-t-gray-200">
              {error ? (
                <div className="text-sm text-red-600 md:block hidden">
                  {error}
                </div>
              ) : (
                <div className="text-sm text-gray-400 md:block hidden">
                  Send messages and generate a response (⌘/Ctrl + Enter)
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setMessages([]);
                }}
                className={`ml-auto mr-8 text-gray-500 hover:text-violet-900 ${
                  (streaming || loading) && "pointer-events-none opacity-50"
                }`}
              >
                Clear
              </button>
              <button
                type="button"
                disabled={loading || streaming}
                onClick={handleSubmit}
                className={`bg-ai-loop bg-size-[200%_100%] hover:animate-gradient-background ${
                  loading || streaming ? "animate-gradient-background" : ""
                } text-white rounded-md shadow-md py-2 px-6 flex items-center`}
              >
                Run
                <div className="ml-2 mt-[2px]">
                  <SparkleIcon />
                </div>
              </button>
            </div>
          </div>
        </div>

        <Footer />
      </div>
    </main>
  );
};

export default App;
