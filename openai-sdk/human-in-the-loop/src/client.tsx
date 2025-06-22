import type { Agent, RunResult } from "@openai/agents";
import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentState, MyAgent } from "./server";

/**
sample state 1:
{
  "$schemaVersion": "1.0",
  "currentTurn": 1,
  "currentAgent": {
    "name": "Assistant"
  },
  "originalInput": "where is france",
  "modelResponses": [
    {
      "usage": {
        "requests": 1,
        "inputTokens": 51,
        "outputTokens": 107,
        "totalTokens": 158
      },
      "output": [
        {
          "providerData": {},
          "id": "msg_68573cd7d080819c8241a6753d9a53980220b12faec280b4",
          "type": "message",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
            }
          ]
        }
      ],
      "responseId": "resp_68573cd77924819ca973e88a2e4691dc0220b12faec280b4",
      "providerData": {
        "id": "resp_68573cd77924819ca973e88a2e4691dc0220b12faec280b4",
        "object": "response",
        "created_at": 1750547671,
        "status": "completed",
        "background": false,
        "error": null,
        "incomplete_details": null,
        "instructions": "You are a helpful assistant",
        "max_output_tokens": null,
        "model": "gpt-4.1-2025-04-14",
        "output": [
          {
            "id": "msg_68573cd7d080819c8241a6753d9a53980220b12faec280b4",
            "type": "message",
            "status": "completed",
            "content": [
              {
                "type": "output_text",
                "annotations": [],
                "text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
              }
            ],
            "role": "assistant"
          }
        ],
        "parallel_tool_calls": true,
        "previous_response_id": null,
        "reasoning": {
          "effort": null,
          "summary": null
        },
        "service_tier": "default",
        "store": true,
        "temperature": 1,
        "text": {
          "format": {
            "type": "text"
          }
        },
        "tool_choice": "auto",
        "tools": [
          {
            "type": "function",
            "description": "Get the weather for a given city",
            "name": "get_weather",
            "parameters": {
              "type": "object",
              "properties": {
                "location": {
                  "type": "string"
                }
              },
              "required": [
                "location"
              ],
              "additionalProperties": false
            },
            "strict": true
          }
        ],
        "top_p": 1,
        "truncation": "disabled",
        "usage": {
          "input_tokens": 51,
          "input_tokens_details": {
            "cached_tokens": 0
          },
          "output_tokens": 107,
          "output_tokens_details": {
            "reasoning_tokens": 0
          },
          "total_tokens": 158
        },
        "user": null,
        "metadata": {},
        "output_text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
      }
    }
  ],
  "context": {
    "usage": {
      "requests": 1,
      "inputTokens": 51,
      "outputTokens": 107,
      "totalTokens": 158
    },
    "approvals": {},
    "context": {}
  },
  "toolUseTracker": {
    "Assistant": []
  },
  "maxTurns": 10,
  "currentAgentSpan": {
    "object": "trace.span",
    "id": "span_cf821f0c365e4ccb8296ecbc",
    "trace_id": "trace_17fae26789344d328f3ae46f860bacce",
    "parent_id": null,
    "started_at": "2025-06-21T23:14:31.234Z",
    "ended_at": "2025-06-21T23:14:32.677Z",
    "error": null,
    "span_data": {
      "type": "agent",
      "name": "Assistant",
      "handoffs": [],
      "output_type": "text",
      "tools": [
        "get_weather"
      ]
    }
  },
  "noActiveAgentRun": false,
  "inputGuardrailResults": [],
  "outputGuardrailResults": [],
  "currentStep": {
    "type": "next_step_final_output",
    "output": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
  },
  "lastModelResponse": {
    "usage": {
      "requests": 1,
      "inputTokens": 51,
      "outputTokens": 107,
      "totalTokens": 158
    },
    "output": [
      {
        "providerData": {},
        "id": "msg_68573cd7d080819c8241a6753d9a53980220b12faec280b4",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [
          {
            "type": "output_text",
            "text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
          }
        ]
      }
    ],
    "responseId": "resp_68573cd77924819ca973e88a2e4691dc0220b12faec280b4",
    "providerData": {
      "id": "resp_68573cd77924819ca973e88a2e4691dc0220b12faec280b4",
      "object": "response",
      "created_at": 1750547671,
      "status": "completed",
      "background": false,
      "error": null,
      "incomplete_details": null,
      "instructions": "You are a helpful assistant",
      "max_output_tokens": null,
      "model": "gpt-4.1-2025-04-14",
      "output": [
        {
          "id": "msg_68573cd7d080819c8241a6753d9a53980220b12faec280b4",
          "type": "message",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "annotations": [],
              "text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
            }
          ],
          "role": "assistant"
        }
      ],
      "parallel_tool_calls": true,
      "previous_response_id": null,
      "reasoning": {
        "effort": null,
        "summary": null
      },
      "service_tier": "default",
      "store": true,
      "temperature": 1,
      "text": {
        "format": {
          "type": "text"
        }
      },
      "tool_choice": "auto",
      "tools": [
        {
          "type": "function",
          "description": "Get the weather for a given city",
          "name": "get_weather",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string"
              }
            },
            "required": [
              "location"
            ],
            "additionalProperties": false
          },
          "strict": true
        }
      ],
      "top_p": 1,
      "truncation": "disabled",
      "usage": {
        "input_tokens": 51,
        "input_tokens_details": {
          "cached_tokens": 0
        },
        "output_tokens": 107,
        "output_tokens_details": {
          "reasoning_tokens": 0
        },
        "total_tokens": 158
      },
      "user": null,
      "metadata": {},
      "output_text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
    }
  },
  "generatedItems": [
    {
      "type": "message_output_item",
      "rawItem": {
        "providerData": {},
        "id": "msg_68573cd7d080819c8241a6753d9a53980220b12faec280b4",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [
          {
            "type": "output_text",
            "text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
          }
        ]
      },
      "agent": {
        "name": "Assistant"
      }
    }
  ],
  "lastProcessedResponse": {
    "newItems": [
      {
        "type": "message_output_item",
        "rawItem": {
          "providerData": {},
          "id": "msg_68573cd7d080819c8241a6753d9a53980220b12faec280b4",
          "type": "message",
          "role": "assistant",
          "status": "completed",
          "content": [
            {
              "type": "output_text",
              "text": "France is a country located in Western Europe. It is bordered by several countries:\n\n- To the northeast: Belgium, Luxembourg, and Germany  \n- To the east: Switzerland and Italy  \n- To the south: Spain, Andorra, and Monaco  \n\nIt also has coastlines along the Atlantic Ocean to the west, the English Channel to the north, and the Mediterranean Sea to the south. Its capital city is Paris. France is well-known for its cultural heritage, cuisine, fashion, and historical landmarks like the Eiffel Tower."
            }
          ]
        },
        "agent": {
          "name": "Assistant"
        }
      }
    ],
    "toolsUsed": [],
    "handoffs": [],
    "functions": [],
    "computerActions": [],
    "mcpApprovalRequests": []
  },
  "trace": {
    "object": "trace",
    "id": "trace_17fae26789344d328f3ae46f860bacce",
    "workflow_name": "Agent workflow",
    "group_id": null,
    "metadata": {}
  }
}

sample state 2:


{
  "$schemaVersion": "1.0",
  "currentTurn": 1,
  "currentAgent": {
    "name": "Assistant"
  },
  "originalInput": "weather in San Francisco",
  "modelResponses": [
    {
      "usage": {
        "requests": 1,
        "inputTokens": 52,
        "outputTokens": 16,
        "totalTokens": 68
      },
      "output": [
        {
          "providerData": {
            "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
            "type": "function_call"
          },
          "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
          "type": "function_call",
          "callId": "call_2dScYOCiwrF9PheHBKfvP9DL",
          "name": "get_weather",
          "status": "completed",
          "arguments": "{\"location\":\"San Francisco\"}"
        }
      ],
      "responseId": "resp_685743e08ae4819282f8791820b8e1ca0621af930265a5b9",
      "providerData": {
        "id": "resp_685743e08ae4819282f8791820b8e1ca0621af930265a5b9",
        "object": "response",
        "created_at": 1750549472,
        "status": "completed",
        "background": false,
        "error": null,
        "incomplete_details": null,
        "instructions": "You are a helpful assistant",
        "max_output_tokens": null,
        "model": "gpt-4.1-2025-04-14",
        "output": [
          {
            "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
            "type": "function_call",
            "status": "completed",
            "arguments": "{\"location\":\"San Francisco\"}",
            "call_id": "call_2dScYOCiwrF9PheHBKfvP9DL",
            "name": "get_weather"
          }
        ],
        "parallel_tool_calls": true,
        "previous_response_id": null,
        "reasoning": {
          "effort": null,
          "summary": null
        },
        "service_tier": "default",
        "store": true,
        "temperature": 1,
        "text": {
          "format": {
            "type": "text"
          }
        },
        "tool_choice": "auto",
        "tools": [
          {
            "type": "function",
            "description": "Get_weather for a given city",
            "name": "get_weather",
            "parameters": {
              "type": "object",
              "properties": {
                "location": {
                  "type": "string"
                }
              },
              "required": [
                "location"
              ],
              "additionalProperties": false
            },
            "strict": true
          }
        ],
        "top_p": 1,
        "truncation": "disabled",
        "usage": {
          "input_tokens": 52,
          "input_tokens_details": {
            "cached_tokens": 0
          },
          "output_tokens": 16,
          "output_tokens_details": {
            "reasoning_tokens": 0
          },
          "total_tokens": 68
        },
        "user": null,
        "metadata": {},
        "output_text": ""
      }
    }
  ],
  "context": {
    "usage": {
      "requests": 1,
      "inputTokens": 52,
      "outputTokens": 16,
      "totalTokens": 68
    },
    "approvals": {},
    "context": {}
  },
  "toolUseTracker": {
    "Assistant": [
      "get_weather"
    ]
  },
  "maxTurns": 10,
  "currentAgentSpan": {
    "object": "trace.span",
    "id": "span_2fda42fcd98d40378071a285",
    "trace_id": "trace_f0f6ba2709dc4a749bdd8a03e4f01215",
    "parent_id": null,
    "started_at": "2025-06-21T23:44:31.900Z",
    "ended_at": null,
    "error": null,
    "span_data": {
      "type": "agent",
      "name": "Assistant",
      "handoffs": [],
      "output_type": "text",
      "tools": [
        "get_weather"
      ]
    }
  },
  "noActiveAgentRun": false,
  "inputGuardrailResults": [],
  "outputGuardrailResults": [],
  "currentStep": {
    "type": "next_step_interruption",
    "data": {
      "interruptions": [
        {
          "type": "tool_approval_item",
          "rawItem": {
            "type": "function_call",
            "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
            "callId": "call_2dScYOCiwrF9PheHBKfvP9DL",
            "name": "get_weather",
            "status": "completed",
            "arguments": "{\"location\":\"San Francisco\"}",
            "providerData": {
              "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
              "type": "function_call"
            }
          },
          "agent": {
            "name": "Assistant"
          }
        }
      ]
    }
  },
  "lastModelResponse": {
    "usage": {
      "requests": 1,
      "inputTokens": 52,
      "outputTokens": 16,
      "totalTokens": 68
    },
    "output": [
      {
        "providerData": {
          "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
          "type": "function_call",
          "type": "function_call"
        },
        "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
        "type": "function_call",
        "callId": "call_2dScYOCiwrF9PheHBKfvP9DL",
        "name": "get_weather",
        "status": "completed",
        "arguments": "{\"location\":\"San Francisco\"}"
      }
    ],
    "responseId": "resp_685743e08ae4819282f8791820b8e1ca0621af930265a5b9",
    "providerData": {
      "id": "resp_685743e08ae4819282f8791820b8e1ca0621af930265a5b9",
      "object": "response",
      "created_at": 1750549472,
      "status": "completed",
      "background": false,
      "error": null,
      "incomplete_details": null,
      "instructions": "You are a helpful assistant",
      "max_output_tokens": null,
      "model": "gpt-4.1-2025-04-14",
      "output": [
        {
          "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
          "type": "function_call",
          "status": "completed",
          "arguments": "{\"location\":\"San Francisco\"}",
          "call_id": "call_2dScYOCiwrF9PheHBKfvP9DL",
          "name": "get_weather"
        }
      ],
      "parallel_tool_calls": true,
      "previous_response_id": null,
      "reasoning": {
        "effort": null,
        "summary": null
      },
      "service_tier": "default",
      "store": true,
      "temperature": 1,
      "text": {
        "format": {
          "type": "text"
        }
      },
      "tool_choice": "auto",
      "tools": [
        {
          "type": "function",
          "description": "Get the weather for a given city",
          "name": "get_weather",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string"
              }
            },
            "required": [
              "location"
            ],
            "additionalProperties": false
          },
          "strict": true
        }
      ],
      "top_p": 1,
      "truncation": "disabled",
      "usage": {
        "input_tokens": 52,
        "input_tokens_details": {
          "cached_tokens": 0
        },
        "output_tokens": 16,
        "output_tokens_details": {
          "reasoning_tokens": 0
        },
        "total_tokens": 68
      },
      "user": null,
      "metadata": {},
      "output_text": ""
    }
  },
  "generatedItems": [
    {
      "type": "tool_call_item",
      "rawItem": {
        "providerData": {
          "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
          "type": "function_call"
        },
        "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
        "type": "function_call",
        "callId": "call_2dScYOCiwrF9PheHBKfvP9DL",
        "name": "get_weather",
        "status": "completed",
        "arguments": "{\"location\":\"San Francisco\"}"
      },
      "agent": {
        "name": "Assistant"
      }
    },
    {
      "type": "tool_approval_item",
      "rawItem": {
        "providerData": {
          "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
          "type": "function_call"
        },
        "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
        "type": "function_call",
        "callId": "call_2dScYOCiwrF9PheHBKfvP9DL",
        "name": "get_weather",
        "status": "completed",
        "arguments": "{\"location\":\"San Francisco\"}"
      },
      "agent": {
        "name": "Assistant"
      }
    }
  ],
  "lastProcessedResponse": {
    "newItems": [
      {
        "type": "tool_call_item",
        "rawItem": {
          "providerData": {
            "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
            "type": "function_call"
          },
          "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
          "name": "get_weather",
          "status": "completed",
          "arguments": "{\"location\":\"San Francisco\"}"
        },
        "agent": {
          "name": "Assistant"
        }
      }
    ],
    "toolsUsed": [
      "get_weather"
    ],
    "handoffs": [],
    "functions": [
      {
        "toolCall": {
          "type": "function_call",
          "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
          "callId": "call_2dScYOCiwrF9PheHBKfvP9DL",
          "name": "get_weather",
          "status": "completed",
          "arguments": "{\"location\":\"San Francisco\"}",
          "providerData": {
            "id": "fc_685743e107c0819289327bd1d1e68efb0621af930265a5b9",
            "type": "function_call"
          }
        },
        "tool": {
          "type": "function",
          "name": "get_weather",
          "description": "Get the weather for a given city",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string"
              }
            },
            "required": [
              "location"
            ],
            "additionalProperties": false,
            "$schema": "http://json-schema.org/draft-07/schema#"
          },
          "strict": true
        }
      }
    ],
    "computerActions": [],
    "mcpApprovalRequests": []
  },
  "trace": {
    "object": "trace",
    "id": "trace_f0f6ba2709dc4a749bdd8a03e4f01215",
    "workflow_name": "Agent workflow",
    "group_id": null,
    "metadata": {}
  }
}
*/

// biome-ignore lint/suspicious/noExplicitAny: later
type AppState = RunResult<unknown, Agent<unknown, any>> | null;

// Types for the agent state structure
interface ToolApprovalItem {
  type: "tool_approval_item";
  rawItem: {
    type: "function_call";
    id: string;
    callId: string;
    name: string;
    status: string;
    arguments: string;
    providerData: {
      id: string;
      type: "function_call";
    };
  };
  agent: {
    name: string;
  };
}

// Modal component for tool approval
function ApprovalModal({
  interruption,
  onApprove,
  onReject,
}: {
  interruption: ToolApprovalItem;
  onApprove: () => void;
  onReject: () => void;
}) {
  const args = JSON.parse(interruption.rawItem.arguments);

  return (
    <div
      style={{
        alignItems: "center",
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        bottom: 0,
        display: "flex",
        justifyContent: "center",
        left: 0,
        position: "fixed",
        right: 0,
        top: 0,
        zIndex: 1000,
      }}
    >
      <div
        style={{
          backgroundColor: "white",
          borderRadius: "8px",
          boxShadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
          maxWidth: "500px",
          padding: "24px",
          width: "90%",
        }}
      >
        <h2 style={{ color: "#333", marginTop: 0 }}>Tool Approval Required</h2>

        <div style={{ marginBottom: "16px" }}>
          <strong>Tool:</strong> {interruption.rawItem.name}
        </div>

        <div style={{ marginBottom: "16px" }}>
          <strong>Arguments:</strong>
          <pre
            style={{
              backgroundColor: "#f5f5f5",
              borderRadius: "4px",
              fontSize: "14px",
              overflow: "auto",
              padding: "8px",
            }}
          >
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>

        <div style={{ marginBottom: "20px" }}>
          <strong>Agent:</strong> {interruption.agent.name}
        </div>

        <div
          style={{
            display: "flex",
            gap: "12px",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onReject}
            style={{
              backgroundColor: "white",
              border: "1px solid #dc3545",
              borderRadius: "4px",
              color: "#dc3545",
              cursor: "pointer",
              padding: "8px 16px",
            }}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={onApprove}
            style={{
              backgroundColor: "#28a745",
              border: "1px solid #28a745",
              borderRadius: "4px",
              color: "white",
              cursor: "pointer",
              padding: "8px 16px",
            }}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

// Component to display agent state
// biome-ignore lint/suspicious/noExplicitAny: later
function AgentStateDisplay({ state }: any) {
  const hasInterruption = state.currentStep?.type === "next_step_interruption";
  const firstInterruption = hasInterruption
    ? state.currentStep.data?.interruptions[0]
    : null;

  return (
    <div style={{ marginTop: "20px" }}>
      <h3>Agent State</h3>

      <div style={{ marginBottom: "16px" }}>
        <strong>Current Agent:</strong> {state.currentAgent?.name || "Unknown"}
      </div>

      <div style={{ marginBottom: "16px" }}>
        <strong>Original Input:</strong> {state.originalInput || "None"}
      </div>

      <div style={{ marginBottom: "16px" }}>
        <strong>Current Step:</strong> {state.currentStep?.type || "Unknown"}
      </div>

      {state.currentStep?.type === "next_step_final_output" &&
        state.currentStep.output && (
          <div style={{ marginBottom: "16px" }}>
            <strong>Output:</strong>
            <div
              style={{
                backgroundColor: "#f8f9fa",
                border: "1px solid #dee2e6",
                borderRadius: "4px",
                padding: "12px",
                whiteSpace: "pre-wrap",
              }}
            >
              {state.currentStep.output}
            </div>
          </div>
        )}

      {state.lastProcessedResponse?.toolsUsed?.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <strong>Tools Used:</strong>{" "}
          {state.lastProcessedResponse.toolsUsed.join(", ")}
        </div>
      )}

      {state.generatedItems?.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <strong>Generated Items:</strong>
          <div
            style={{
              backgroundColor: "#f8f9fa",
              border: "1px solid #dee2e6",
              borderRadius: "4px",
              maxHeight: "200px",
              overflow: "auto",
              padding: "12px",
            }}
          >
            <pre style={{ fontSize: "12px", margin: 0 }}>
              {JSON.stringify(state.generatedItems, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {hasInterruption && firstInterruption && (
        <div
          style={{
            backgroundColor: "#fff3cd",
            border: "1px solid #ffeaa7",
            borderRadius: "4px",
            marginBottom: "16px",
            padding: "12px",
          }}
        >
          <strong>⚠️ Tool Approval Required</strong>
          <div>Tool: {firstInterruption.rawItem.name}</div>
          <div>Arguments: {firstInterruption.rawItem.arguments}</div>
        </div>
      )}
    </div>
  );
}

function App() {
  const [state, setState] = useState<AppState>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [currentInterruption, setCurrentInterruption] =
    useState<ToolApprovalItem | null>(null);

  console.log("[Client] App component rendered, current state:", state);
  console.log("[Client] Current question:", question);

  const agent = useAgent<MyAgent, AgentState>({
    agent: "my-agent",
    name: "weather-chat",
    onStateUpdate({
      serialisedRunState,
    }: {
      serialisedRunState: string | null;
    }) {
      console.log("[Client] onStateUpdate called with serialisedRunState:");
      if (serialisedRunState) {
        const parsedState = JSON.parse(serialisedRunState) as AppState;
        console.log("[Client] Parsed state:", parsedState);
        setState(parsedState);

        // Check for interruptions - access the state property correctly
        // biome-ignore lint/suspicious/noExplicitAny: later
        const agentState = parsedState as any;
        if (agentState?.currentStep?.type === "next_step_interruption") {
          const interruption = agentState.currentStep.data?.interruptions[0];
          if (interruption) {
            console.log("[Client] Found interruption:", interruption);
            setCurrentInterruption(interruption);
            setShowApprovalModal(true);
          }
        }
      } else {
        console.log("[Client] No serialisedRunState provided, clearing state");
        setState(null);
        setShowApprovalModal(false);
        setCurrentInterruption(null);
      }
    },
  });

  const handleAsk = () => {
    if (question) {
      console.log("[Client] Sending question to agent:", question);
      agent.stub.ask(question);
    } else {
      console.log("[Client] Attempted to ask empty question");
    }
  };

  const handleQuestionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newQuestion = e.target.value;
    console.log("[Client] Question input changed:", newQuestion);
    setQuestion(newQuestion);
  };

  const handleApprove = () => {
    if (currentInterruption) {
      console.log(
        "[Client] Approving tool call:",
        currentInterruption.rawItem.callId
      );
      agent.stub.proceed(currentInterruption.rawItem.callId, true);
      setShowApprovalModal(false);
      setCurrentInterruption(null);
    }
  };

  const handleReject = () => {
    if (currentInterruption) {
      console.log(
        "[Client] Rejecting tool call:",
        currentInterruption.rawItem.callId
      );
      agent.stub.proceed(currentInterruption.rawItem.callId, false);
      setShowApprovalModal(false);
      setCurrentInterruption(null);
    }
  };

  // const handleCloseModal = () => {
  //   setShowApprovalModal(false);
  //   setCurrentInterruption(null);
  // };

  return (
    <div style={{ fontFamily: "Arial, sans-serif", padding: "20px" }}>
      <h1 style={{ color: "#333", marginBottom: "20px" }}>
        Weather Chat Agent
      </h1>

      <div style={{ marginBottom: "20px" }}>
        <input
          type="text"
          value={question || ""}
          onChange={handleQuestionChange}
          placeholder="Ask about the weather..."
          style={{
            border: "1px solid #ddd",
            borderRadius: "4px",
            fontSize: "16px",
            marginRight: "8px",
            padding: "8px 12px",
            width: "300px",
          }}
        />
        <button
          type="button"
          onClick={handleAsk}
          style={{
            backgroundColor: "#007bff",
            border: "none",
            borderRadius: "4px",
            color: "white",
            cursor: "pointer",
            fontSize: "16px",
            padding: "8px 16px",
          }}
        >
          Ask
        </button>
      </div>

      {/* biome-ignore lint/suspicious/noExplicitAny: later */}
      {state && <AgentStateDisplay state={state as any} />}

      {showApprovalModal && currentInterruption && (
        <ApprovalModal
          interruption={currentInterruption}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </div>
  );
}

console.log("[Client] Initializing React app");
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
