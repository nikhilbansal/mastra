---
'@mastra/core': patch
---

Fixed stopping a durable run after a tool approval resume. Stopping the run left the thread marked active, so the next message joined the stopped run instead of starting a new one. Fixes https://github.com/mastra-ai/mastra/issues/29011.
