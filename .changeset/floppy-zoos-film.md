---
'@mastra/core': patch
---

Skills discovery no longer blocks agent turns: the skills processors serve the cached catalog and revalidate in the background, and refresh swaps the catalog atomically.
