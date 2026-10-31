---
'@mastra/memory': patch
---

Fixed observational memory cleanup blocking the event loop on long threads. Choosing which observed messages to remove now counts each message's tokens once and keeps a running total, instead of recounting the whole remaining transcript for every candidate and again during retention backoff. Fixes https://github.com/mastra-ai/mastra/issues/29007.
