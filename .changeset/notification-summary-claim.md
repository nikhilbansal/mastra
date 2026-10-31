---
'@mastra/core': patch
'@mastra/pg': patch
'@mastra/libsql': patch
'@mastra/mongodb': patch
---

Fixed a notification summary being posted twice when two dispatches run over the same due notifications at once, for example two instances whose schedulers fire the same tick, or one dispatch step that is delivered twice. Each dispatch now claims a notification's due summary before sending it, and only the dispatch that claims it summarizes it. The summary signal id is now derived from the notifications it summarizes, so a summary that is still sent twice is written as one message.

Notifications storage gains `claimNotificationSummary({ threadId, id, now })`, a conditional write that clears `summaryAt` only while the summary is due. The PostgreSQL, LibSQL and MongoDB adapters implement it natively. Other adapters fall back to a read then a write, which is not atomic.
