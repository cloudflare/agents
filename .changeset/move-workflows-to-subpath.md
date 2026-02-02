---
"agents": patch
---

Move workflow exports to `agents/workflows` subpath for better separation of concerns.

```typescript
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowStep, WorkflowInfo } from "agents/workflows";
```
