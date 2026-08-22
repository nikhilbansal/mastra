---
'@mastra/core': patch
---

Fixed thread signals so completed runs release their lease before subscribers receive terminal output, suspended runs remain resumable during aborts, and wake races do not strand messages.
