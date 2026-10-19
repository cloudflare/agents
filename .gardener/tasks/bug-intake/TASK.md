---
schema: gardener.task/v1
id: bug-intake
name: Bug intake
description: Inspects repository conventions and helps issue authors provide actionable bug reports.
trigger:
  event: github.issue.opened
  labels-all:
    - gardener-bug
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
Inspect the issue and the repository's relevant conventions.

Propose one concise issue comment containing:

1. The likely affected area.
2. Missing reproduction information.
3. Relevant test locations.
4. A concrete next step for the author or maintainer.

Do not claim that code was changed or that a persistent effect already occurred.
Then finish.
