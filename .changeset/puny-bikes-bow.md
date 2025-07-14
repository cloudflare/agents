---
"agents": patch
---

fix: dequeue items in DB after each task is complete

Prevents a single failure from causing all items in the queue from being retried (including previously processed items that were successful).
