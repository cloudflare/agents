---
schema: gardener.task/v1
id: docs-helper
name: Documentation helper
description: Locates relevant documentation and suggests a concrete documentation plan.
trigger:
  event: github.issue.opened
  labels-all:
    - gardener-docs
tools:
  - repository.list_files
  - repository.read_file
effects:
  - issue.comment.create
network:
  default: deny
  allow: []
  deny: []
limits:
  runtime-seconds: 300
  max-turns: 16
  max-tool-calls: 12
  input-tokens: 60000
  output-tokens: 16000
---
Inspect the issue and the repository's documentation structure.

Propose one concise issue comment containing:

1. The documentation files most likely involved.
2. Related guidance already present in the repository.
3. Missing information needed from the issue author.
4. A concrete documentation update plan.

Do not claim that documentation was changed or that a persistent effect already occurred.
Then finish.
