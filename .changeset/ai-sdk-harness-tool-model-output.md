---
"agents": patch
---

`AiSdkHarness` passes its tools to `convertToModelMessages`, so a tool's `toModelOutput` also shapes its results on later turns instead of the model getting the raw output as JSON.
