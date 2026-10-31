---
'@mastra/memory': patch
---

Observational memory no longer renders recent messages for extractor hooks unless an external `onExtracted` hook will receive them. Fixes https://github.com/mastra-ai/mastra/issues/29008.
