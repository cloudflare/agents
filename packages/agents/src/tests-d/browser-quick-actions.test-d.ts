import {
  runQuickAction,
  type QuickActionBinding
} from "../browser/quick-actions";

declare const browser: QuickActionBinding;

// `json` requires an extract input — `prompt` / `response_format` are valid.
runQuickAction(browser, "json", {
  url: "https://example.com",
  prompt: "extract titles",
  response_format: { type: "json_schema", schema: {} }
});

// `scrape` accepts `elements`.
runQuickAction(browser, "scrape", {
  url: "https://example.com",
  elements: [{ selector: "h1" }]
});

// `screenshot` accepts screenshot-specific options.
runQuickAction(browser, "screenshot", {
  url: "https://example.com",
  selector: "h1"
});

// A non-literal action falls back to accepting any QuickActionInput.
const action = "markdown" as
  | "markdown"
  | "content"
  | "links"
  | "snapshot"
  | "pdf";
runQuickAction(browser, action, { url: "https://example.com" });

// @ts-expect-error a page input still requires url or html
runQuickAction(browser, "markdown", {});
