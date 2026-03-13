/**
 * Shared query engine for jq-style filtering
 *
 * Provides parser and evaluator for jq-style queries that can be used
 * with any data format (JSON, YAML, XML, etc.).
 */

export * from "./evaluator";
export * from "./parser";
