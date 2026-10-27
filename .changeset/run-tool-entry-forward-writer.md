---
'@mastra/core': patch
---

Forward the step `writer` to tools run as workflow steps. Tools wrapped with `createStep(tool)` (and declarative `tool` entries) previously received no `writer` in their execution context, so `context.writer.write()` / `context.writer.custom()` calls inside the tool were silently dropped instead of streaming to the workflow and agent stream.
