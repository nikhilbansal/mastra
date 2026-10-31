---
'@mastra/core': patch
---

Fixed workflow events being handled twice after a lazy worker start raced `mastra.startWorkers()`. When a background task dispatch started the execution workers while `startWorkers()` was also starting them, the orchestration worker subscribed two consumers to the workflow topic, and one of them stayed subscribed after `stopWorkers()`. Concurrent starts of the orchestration worker now share one start, and `startWorkers()` waits for an in-flight lazy start and skips workers that are already running.
