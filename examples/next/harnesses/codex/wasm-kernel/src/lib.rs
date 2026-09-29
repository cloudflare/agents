//! A small Codex-derived transition kernel for Cloudflare Workers.
//!
//! This crate deliberately keeps only the pure part of a Codex turn: which
//! effect comes next and which tool calls are still pending. The host owns
//! networking, storage, the transcript, filesystem access, and time. Transcript
//! items live in the host's session store, so the checkpoint stays a few
//! hundred bytes no matter how long the conversation is.
//! The Responses request, stream-event, response-item, and tool shapes follow
//! openai/codex at commit 5e26f7621c1c470fe62350d61c9eb4d6c772a0da.
//!
//! Source references:
//! - codex-rs/codex-api/src/common.rs
//! - codex-rs/codex-api/src/sse/responses.rs
//! - codex-rs/protocol/src/models.rs
//! - codex-rs/tools/src/responses_api.rs
//! - codex-rs/tools/src/tool_spec.rs
//!
//! The upstream crates cannot currently target wasm32-unknown-unknown because
//! their shared dependency graph enables Tokio networking and reaches mio.
//! This crate is therefore an attributed extraction, not a dependency on those
//! crates. Apache-2.0 notices are retained beside the deployed example.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::slice;

const CHECKPOINT_VERSION: u32 = 3;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum KernelCommand {
    StartTurn {
        thread_id: String,
        turn_id: String,
        model: String,
    },
    ResolveEffect {
        checkpoint: Box<Checkpoint>,
        effect_id: String,
        result: EffectResult,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Checkpoint {
    version: u32,
    thread_id: String,
    turn_id: String,
    model: String,
    phase: Phase,
    model_round: u32,
    next_event_seq: u32,
    pending_calls: Vec<PendingToolCall>,
    final_output: String,
    response_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    WaitingForModel,
    WaitingForTool,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct PendingToolCall {
    call_id: String,
    name: String,
    arguments: Value,
    payload_kind: ToolPayloadKind,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ToolPayloadKind {
    Function,
    Custom,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum EffectResult {
    Model {
        frames: Vec<Value>,
    },
    Tool {
        output: Value,
        #[serde(default = "default_true")]
        success: bool,
    },
    Error {
        message: String,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
struct Transition {
    checkpoint: Checkpoint,
    events: Vec<KernelEvent>,
    action: Action,
}

#[derive(Debug, Serialize)]
struct KernelEvent {
    seq: u32,
    #[serde(flatten)]
    detail: EventDetail,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum EventDetail {
    TurnStarted {
        thread_id: String,
        turn_id: String,
    },
    ModelRequested {
        effect_id: String,
        round: u32,
    },
    ReasoningDelta {
        delta: String,
    },
    AssistantDelta {
        delta: String,
    },
    ToolStarted {
        effect_id: String,
        call_id: String,
        name: String,
        arguments: Value,
    },
    ToolCompleted {
        effect_id: String,
        call_id: String,
        name: String,
        output: Value,
        success: bool,
    },
    TurnCompleted {
        output: String,
        response_id: Option<String>,
    },
    TurnFailed {
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    Model {
        effect_id: String,
        request: Value,
    },
    Tool {
        effect_id: String,
        call_id: String,
        name: String,
        arguments: Value,
    },
    Completed {
        output: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Debug, Deserialize)]
struct ResponsesStreamEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    response: Option<Value>,
    #[serde(default)]
    item: Option<Value>,
    #[serde(default)]
    delta: Option<String>,
}

fn start_turn(thread_id: String, turn_id: String, model: String) -> Transition {
    let mut checkpoint = Checkpoint {
        version: CHECKPOINT_VERSION,
        thread_id,
        turn_id,
        model,
        phase: Phase::WaitingForModel,
        model_round: 0,
        next_event_seq: 0,
        pending_calls: Vec::new(),
        final_output: String::new(),
        response_id: None,
    };
    let mut events = Vec::new();
    let started_thread_id = checkpoint.thread_id.clone();
    let started_turn_id = checkpoint.turn_id.clone();
    emit(
        &mut checkpoint,
        &mut events,
        EventDetail::TurnStarted {
            thread_id: started_thread_id,
            turn_id: started_turn_id,
        },
    );
    let action = model_action(&mut checkpoint, &mut events);
    Transition {
        checkpoint,
        events,
        action,
    }
}

fn resolve_effect(
    mut checkpoint: Checkpoint,
    effect_id: String,
    result: EffectResult,
) -> Transition {
    if checkpoint.version != CHECKPOINT_VERSION {
        let version = checkpoint.version;
        return fail(
            checkpoint,
            format!("unsupported checkpoint version {version} (expected {CHECKPOINT_VERSION})"),
        );
    }

    match result {
        EffectResult::Error { message } => fail(checkpoint, message),
        EffectResult::Model { frames } => {
            let expected = model_effect_id(checkpoint.model_round);
            if !matches!(checkpoint.phase, Phase::WaitingForModel) || effect_id != expected {
                return fail(
                    checkpoint,
                    format!("model effect {effect_id} does not match expected {expected}"),
                );
            }
            resolve_model(checkpoint, frames)
        }
        EffectResult::Tool { output, success } => {
            let Some(call) = checkpoint.pending_calls.first().cloned() else {
                return fail(checkpoint, format!("unexpected tool effect {effect_id}"));
            };
            let expected = tool_effect_id(&call.call_id);
            if !matches!(checkpoint.phase, Phase::WaitingForTool) || effect_id != expected {
                return fail(
                    checkpoint,
                    format!("tool effect {effect_id} does not match expected {expected}"),
                );
            }
            // The host already appended the tool's output to the transcript;
            // the kernel only records that the call settled.
            checkpoint.pending_calls.remove(0);
            let mut events = Vec::new();
            emit(
                &mut checkpoint,
                &mut events,
                EventDetail::ToolCompleted {
                    effect_id,
                    call_id: call.call_id,
                    name: call.name,
                    output,
                    success,
                },
            );
            let action = if checkpoint.pending_calls.is_empty() {
                checkpoint.phase = Phase::WaitingForModel;
                checkpoint.model_round += 1;
                model_action(&mut checkpoint, &mut events)
            } else {
                tool_action(&mut checkpoint, &mut events)
                    .expect("pending tool batch has a next call")
            };
            Transition {
                checkpoint,
                events,
                action,
            }
        }
    }
}

fn resolve_model(mut checkpoint: Checkpoint, frames: Vec<Value>) -> Transition {
    let mut events = Vec::new();
    let mut completed = false;
    let mut end_turn = None;

    for raw in frames {
        let Ok(frame) = serde_json::from_value::<ResponsesStreamEvent>(raw) else {
            continue;
        };
        match frame.kind.as_str() {
            "response.output_text.delta" => {
                if let Some(delta) = frame.delta {
                    checkpoint.final_output.push_str(&delta);
                    emit(
                        &mut checkpoint,
                        &mut events,
                        EventDetail::AssistantDelta { delta },
                    );
                }
            }
            "response.reasoning_summary_text.delta" => {
                if let Some(delta) = frame.delta {
                    emit(
                        &mut checkpoint,
                        &mut events,
                        EventDetail::ReasoningDelta { delta },
                    );
                }
            }
            "response.output_item.done" => {
                if let Some(item) = frame.item {
                    handle_output_item(&mut checkpoint, item);
                }
            }
            "response.completed" => {
                completed = true;
                if let Some(response) = frame.response {
                    checkpoint.response_id = response
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    end_turn = response.get("end_turn").and_then(Value::as_bool);
                }
            }
            "response.failed" | "response.incomplete" => {
                let message = frame
                    .response
                    .as_ref()
                    .and_then(|value| value.pointer("/error/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("model response failed")
                    .to_string();
                return fail_with_events(checkpoint, events, message);
            }
            _ => {}
        }
    }

    if !checkpoint.pending_calls.is_empty() {
        let action = tool_action(&mut checkpoint, &mut events)
            .expect("non-empty pending tool batch has a first call");
        return Transition {
            checkpoint,
            events,
            action,
        };
    }

    if completed && end_turn.unwrap_or(true) {
        checkpoint.phase = Phase::Completed;
        let completed_output = checkpoint.final_output.clone();
        let completed_response_id = checkpoint.response_id.clone();
        emit(
            &mut checkpoint,
            &mut events,
            EventDetail::TurnCompleted {
                output: completed_output,
                response_id: completed_response_id,
            },
        );
        return Transition {
            action: Action::Completed {
                output: checkpoint.final_output.clone(),
            },
            checkpoint,
            events,
        };
    }

    fail_with_events(
        checkpoint,
        events,
        "model response ended without a tool call or terminal answer".to_string(),
    )
}

/// Register the tool calls a model response asked for. Message and reasoning
/// items are the host's to store; only calls change the kernel's state.
fn handle_output_item(checkpoint: &mut Checkpoint, item: Value) {
    let item_type = item.get("type").and_then(Value::as_str);
    match item_type {
        Some("function_call") => {
            let call_id = string_field(&item, "call_id");
            let name = string_field(&item, "name");
            let arguments = item
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or(Value::Null);
            checkpoint.pending_calls.push(PendingToolCall {
                call_id,
                name,
                arguments,
                payload_kind: ToolPayloadKind::Function,
            });
        }
        Some("custom_tool_call") => {
            let call_id = string_field(&item, "call_id");
            let name = string_field(&item, "name");
            let arguments = item
                .get("input")
                .and_then(Value::as_str)
                .map(|input| Value::String(input.to_string()))
                .unwrap_or(Value::Null);
            checkpoint.pending_calls.push(PendingToolCall {
                call_id,
                name,
                arguments,
                payload_kind: ToolPayloadKind::Custom,
            });
        }
        _ => {}
    }
}

fn tool_action(checkpoint: &mut Checkpoint, events: &mut Vec<KernelEvent>) -> Option<Action> {
    let call = checkpoint.pending_calls.first()?.clone();
    checkpoint.phase = Phase::WaitingForTool;
    let effect_id = tool_effect_id(&call.call_id);
    emit(
        checkpoint,
        events,
        EventDetail::ToolStarted {
            effect_id: effect_id.clone(),
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
        },
    );
    Some(Action::Tool {
        effect_id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
    })
}

fn model_action(checkpoint: &mut Checkpoint, events: &mut Vec<KernelEvent>) -> Action {
    let effect_id = model_effect_id(checkpoint.model_round);
    // `input` is the transcript, which the host assembles from its session
    // store under its own context budget when it performs the effect.
    let request = json!({
        "type": "response.create",
        "model": checkpoint.model,
        "instructions": "You are Codex. Inspect and modify the workspace using the supplied tools. Finish with a concise account of the result.",
        "input": null,
        "tools": workspace_tools(),
        "tool_choice": "auto",
        "parallel_tool_calls": true,
        "reasoning": { "summary": "auto" },
        "store": false,
        "stream": true,
        "include": ["reasoning.encrypted_content"],
        "client_metadata": {
            "thread_id": checkpoint.thread_id,
            "turn_id": checkpoint.turn_id
        }
    });
    emit(
        checkpoint,
        events,
        EventDetail::ModelRequested {
            effect_id: effect_id.clone(),
            round: checkpoint.model_round,
        },
    );
    Action::Model { effect_id, request }
}

fn workspace_tools() -> Vec<Value> {
    vec![
        function_tool(
            "workspace_write",
            "Write UTF-8 text to a durable workspace path.",
            BTreeMap::from([
                ("path", json!({ "type": "string" })),
                ("content", json!({ "type": "string" })),
            ]),
            vec!["path", "content"],
        ),
        function_tool(
            "workspace_read",
            "Read UTF-8 text from a durable workspace path. Large files are read in ranges: pass byte offset and max_bytes to page through them.",
            BTreeMap::from([
                ("path", json!({ "type": "string" })),
                ("offset", json!({ "type": "integer", "minimum": 0 })),
                ("max_bytes", json!({ "type": "integer", "minimum": 1 })),
            ]),
            vec!["path"],
        ),
    ]
}

fn function_tool(
    name: &str,
    description: &str,
    properties: BTreeMap<&str, Value>,
    required: Vec<&str>,
) -> Value {
    // This is the ResponsesApiTool shape from codex-tools. Codex keeps
    // function arguments as a JSON string on response items and parses them
    // only at the dispatch boundary; this kernel does the same above.
    json!({
        "type": "function",
        "name": name,
        "description": description,
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }
    })
}

fn emit(checkpoint: &mut Checkpoint, events: &mut Vec<KernelEvent>, detail: EventDetail) {
    let seq = checkpoint.next_event_seq;
    checkpoint.next_event_seq += 1;
    events.push(KernelEvent { seq, detail });
}

fn fail(checkpoint: Checkpoint, message: String) -> Transition {
    fail_with_events(checkpoint, Vec::new(), message)
}

fn fail_with_events(
    mut checkpoint: Checkpoint,
    mut events: Vec<KernelEvent>,
    message: String,
) -> Transition {
    checkpoint.phase = Phase::Failed;
    emit(
        &mut checkpoint,
        &mut events,
        EventDetail::TurnFailed {
            message: message.clone(),
        },
    );
    Transition {
        checkpoint,
        events,
        action: Action::Failed { message },
    }
}

fn model_effect_id(round: u32) -> String {
    format!("model:{round}")
}

fn tool_effect_id(call_id: &str) -> String {
    format!("tool:{call_id}")
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn transition_json(input: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice::<KernelCommand>(input)
        .map(|command| match command {
            KernelCommand::StartTurn {
                thread_id,
                turn_id,
                model,
            } => start_turn(thread_id, turn_id, model),
            KernelCommand::ResolveEffect {
                checkpoint,
                effect_id,
                result,
            } => resolve_effect(*checkpoint, effect_id, result),
        })
        .and_then(|transition| serde_json::to_vec(&transition));

    match result {
        Ok(output) => output,
        Err(error) => serde_json::to_vec(&json!({
            "checkpoint": null,
            "events": [],
            "action": {
                "type": "failed",
                "message": format!("invalid kernel command: {error}")
            }
        }))
        .expect("static error response serializes"),
    }
}

/// Allocate a zeroed input buffer for the JavaScript host.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let boxed = vec![0_u8; len].into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

/// Release a buffer previously returned by `alloc` or `transition`.
///
/// # Safety
///
/// `ptr` and `len` must name one live allocation returned by this module, and
/// the caller must release that allocation exactly once.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let slice = slice::from_raw_parts_mut(ptr, len);
    drop(Box::from_raw(slice));
}

/// Advance the pure Codex state machine and return `(ptr << 32) | len`.
///
/// # Safety
///
/// `ptr` and `len` must name a readable allocation produced by `alloc` and
/// containing one UTF-8 JSON `KernelCommand` for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn transition(ptr: *const u8, len: usize) -> u64 {
    let input = slice::from_raw_parts(ptr, len);
    let output = transition_json(input).into_boxed_slice();
    let output_len = output.len();
    let output_ptr = Box::into_raw(output) as *mut u8 as usize;
    ((output_ptr as u64) << 32) | output_len as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(value: Value) -> Transition {
        let command = serde_json::from_value(value).expect("valid command");
        match command {
            KernelCommand::StartTurn {
                thread_id,
                turn_id,
                model,
            } => start_turn(thread_id, turn_id, model),
            KernelCommand::ResolveEffect {
                checkpoint,
                effect_id,
                result,
            } => resolve_effect(*checkpoint, effect_id, result),
        }
    }

    #[test]
    fn preserves_codex_function_call_and_output_shapes() {
        let started = command(json!({
            "type": "start_turn",
            "thread_id": "thread-1",
            "turn_id": "turn-1",
            "model": "codex"
        }));
        assert!(matches!(started.action, Action::Model { .. }));

        let called = command(json!({
            "type": "resolve_effect",
            "checkpoint": started.checkpoint,
            "effect_id": "model:0",
            "result": {
                "type": "model",
                "frames": [{
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "workspace_write",
                        "arguments": "{\"path\":\"/a.txt\",\"content\":\"A\"}"
                    }
                }, {
                    "type": "response.completed",
                    "response": { "id": "resp-1", "end_turn": false }
                }]
            }
        }));
        assert!(matches!(called.action, Action::Tool { .. }));
        assert_eq!(called.checkpoint.pending_calls.len(), 1);

        let resumed = command(json!({
            "type": "resolve_effect",
            "checkpoint": called.checkpoint,
            "effect_id": "tool:call-1",
            "result": { "type": "tool", "output": { "written": true }, "success": true }
        }));
        assert!(matches!(resumed.action, Action::Model { .. }));
        assert!(resumed.checkpoint.pending_calls.is_empty());
        assert_eq!(resumed.checkpoint.model_round, 1);
    }

    #[test]
    fn settles_every_call_in_one_model_tool_batch_before_continuing() {
        let started = command(json!({
            "type": "start_turn",
            "thread_id": "thread-batch",
            "turn_id": "turn-batch",
            "model": "codex"
        }));
        let frames = (1..=4)
            .map(|index| {
                json!({
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": format!("call-{index}"),
                        "name": "workspace_write",
                        "arguments": format!(
                            "{{\"path\":\"/{index}.txt\",\"content\":\"{index}\"}}"
                        )
                    }
                })
            })
            .chain(std::iter::once(json!({
                "type": "response.completed",
                "response": { "id": "resp-batch", "end_turn": false }
            })))
            .collect::<Vec<_>>();
        let mut transition = command(json!({
            "type": "resolve_effect",
            "checkpoint": started.checkpoint,
            "effect_id": "model:0",
            "result": { "type": "model", "frames": frames }
        }));

        assert_eq!(transition.checkpoint.pending_calls.len(), 4);
        for index in 1..=4 {
            let expected_id = format!("call-{index}");
            match &transition.action {
                Action::Tool { call_id, .. } => assert_eq!(call_id, &expected_id),
                _ => panic!("expected tool action {index}"),
            }
            transition = command(json!({
                "type": "resolve_effect",
                "checkpoint": transition.checkpoint,
                "effect_id": format!("tool:{expected_id}"),
                "result": {
                    "type": "tool",
                    "output": { "path": format!("/{index}.txt"), "bytes": 1 },
                    "success": true
                }
            }));
        }

        assert!(matches!(transition.action, Action::Model { .. }));
        assert!(transition.checkpoint.pending_calls.is_empty());
        assert_eq!(transition.checkpoint.model_round, 1);
    }
}
