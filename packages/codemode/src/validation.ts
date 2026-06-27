import type { JSONSchema7 } from "json-schema";
import type { ConnectorDescription, ToolAnnotations } from "./connectors";

export type CodemodeValidationIssue = {
  /** Human- and model-readable explanation of what is wrong. */
  message: string;
  /** Optional argument/source path, such as `body.ownerId`. */
  path?: string;
  /** Optional stable application-specific identifier. */
  code?: string;
  /** Optional concrete advice for correcting the generated program. */
  suggestion?: string;
};

/** An explicit result is required from every configured validation hook. */
export type CodemodeValidationResult =
  | { valid: true }
  | { valid: false; issues?: readonly CodemodeValidationIssue[] };

export type CodeValidationContext = {
  /** Source exactly as supplied by the model. */
  code: string;
  /** Source after Codemode fence stripping and function normalization. */
  normalizedCode: string;
  /** Methods, schemas, annotations, and instructions available to the code. */
  connectors: readonly ConnectorDescription[];
};

export type ToolCallValidationContext = {
  executionId: string;
  connector: string;
  method: string;
  args: unknown;
  inputSchema?: JSONSchema7;
  annotations?: ToolAnnotations;
};

export interface CodemodeValidator {
  /** Non-empty name used to attribute results and diagnostics. */
  name: string;
  validateCode?(
    context: CodeValidationContext
  ): CodemodeValidationResult | Promise<CodemodeValidationResult>;
  validateToolCall?(
    context: ToolCallValidationContext
  ): CodemodeValidationResult | Promise<CodemodeValidationResult>;
}

type AttributedIssue = CodemodeValidationIssue & { validator: string };

const MAX_ISSUES = 20;
const MAX_NAME_CHARS = 100;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_DETAIL_CHARS = 500;
const MAX_FORMATTED_CHARS = 20_000;

export function validateValidators(
  validators: readonly CodemodeValidator[] | undefined
): void {
  validatorNames(validators);
}

export function validatorNames(
  validators: readonly CodemodeValidator[] | undefined
): string[] {
  if (!validators) return [];
  const names = new Set<string>();
  for (const validator of validators) {
    const name = normalizedValidatorName(validator.name);
    if (!name) throw new Error("Codemode validator names must not be empty.");
    if (names.has(name)) {
      throw new Error(`Duplicate codemode validator name "${name}".`);
    }
    names.add(name);
  }
  return [...names];
}

/** Call validators that must still be present when a paused run resumes. */
export function toolCallValidatorNames(
  validators: readonly CodemodeValidator[] | undefined
): string[] {
  return validatorNames(
    validators?.filter((validator) => validator.validateToolCall !== undefined)
  );
}

export async function runCodeValidators(
  validators: readonly CodemodeValidator[] | undefined,
  context: CodeValidationContext
): Promise<string | undefined> {
  return runValidators(validators, "validateCode", context, "generated code");
}

export async function runToolCallValidators(
  validators: readonly CodemodeValidator[] | undefined,
  context: ToolCallValidationContext
): Promise<string | undefined> {
  return runValidators(
    validators,
    "validateToolCall",
    context,
    `${context.connector}.${context.method}`
  );
}

async function runValidators<
  K extends "validateCode" | "validateToolCall",
  C extends CodeValidationContext | ToolCallValidationContext
>(
  validators: readonly CodemodeValidator[] | undefined,
  hook: K,
  context: C,
  target: string
): Promise<string | undefined> {
  if (!validators?.length) return undefined;

  const issues: AttributedIssue[] = [];
  for (const validator of validators) {
    const validate = validator[hook] as
      | ((
          context: C
        ) => CodemodeValidationResult | Promise<CodemodeValidationResult>)
      | undefined;
    if (!validate) continue;

    const name = normalizedValidatorName(validator.name);
    try {
      const result: unknown = await validate(context);
      if (!isValidationResult(result)) {
        console.error(
          `codemode: validator "${name}" returned an invalid result`,
          result
        );
        addIssue(issues, {
          validator: name,
          message: `Validator "${name}" did not return an explicit valid or invalid result; the operation was not executed.`
        });
      } else if (!result.valid) {
        const returned = result.issues?.length
          ? result.issues
          : [{ message: "Validation failed without further details." }];
        for (const issue of returned) {
          if (issues.length >= MAX_ISSUES) break;
          addIssue(issues, normalizeIssue(name, issue));
        }
      }
    } catch (error) {
      console.error(`codemode: validator "${name}" threw`, error);
      addIssue(issues, {
        validator: name,
        message: `Validator "${name}" could not complete; the operation was not executed.`
      });
    }
  }

  if (!issues.length) return undefined;
  return formatIssues(target, issues);
}

function isValidationResult(value: unknown): value is CodemodeValidationResult {
  if (!value || typeof value !== "object" || !("valid" in value)) {
    return false;
  }
  const result = value as { valid?: unknown; issues?: unknown };
  if (result.valid === true) return true;
  if (result.valid !== false) return false;
  if (result.issues === undefined) return true;
  return Array.isArray(result.issues) && result.issues.every(isValidationIssue);
}

function isValidationIssue(value: unknown): value is CodemodeValidationIssue {
  return (
    !!value &&
    typeof value === "object" &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function addIssue(issues: AttributedIssue[], issue: AttributedIssue): void {
  if (issues.length < MAX_ISSUES) issues.push(issue);
}

function normalizeIssue(
  validator: string,
  issue: CodemodeValidationIssue
): AttributedIssue {
  return {
    validator,
    message: truncate(issue.message, MAX_MESSAGE_CHARS),
    ...(issue.path ? { path: truncate(issue.path, MAX_DETAIL_CHARS) } : {}),
    ...(issue.code ? { code: truncate(issue.code, MAX_DETAIL_CHARS) } : {}),
    ...(issue.suggestion
      ? { suggestion: truncate(issue.suggestion, MAX_MESSAGE_CHARS) }
      : {})
  };
}

function formatIssues(target: string, issues: AttributedIssue[]): string {
  const lines = [`Validation failed for ${target}:`];
  for (const issue of issues) {
    const code = issue.code ? ` (${issue.code})` : "";
    const path = issue.path ? ` ${issue.path}:` : ":";
    const suggestion = issue.suggestion ? ` ${issue.suggestion}` : "";
    lines.push(
      `- [${issue.validator}]${code}${path} ${issue.message}${suggestion}`
    );
  }
  return truncate(lines.join("\n"), MAX_FORMATTED_CHARS);
}

function normalizedValidatorName(name: string): string {
  return truncate(name.trim(), MAX_NAME_CHARS);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 14))}… [truncated]`;
}
