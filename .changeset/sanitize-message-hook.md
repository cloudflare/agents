---
"@cloudflare/ai-chat": minor
---

feat: add `sanitizeMessageForPersistence` hook and built-in Anthropic tool payload truncation

- **New protected hook**: `sanitizeMessageForPersistence(message)` — override this method to apply custom transformations to messages before they are persisted to storage. Runs after built-in sanitization. Default is identity (returns message unchanged).
- **Anthropic provider-executed tool truncation**: Large string values in `input` and `output` of provider-executed tool parts (e.g. Anthropic `code_execution`, `text_editor`) are now automatically truncated. These server-side tool payloads can exceed 200KB and are dead weight once the model has consumed the result.

Closes #1118
