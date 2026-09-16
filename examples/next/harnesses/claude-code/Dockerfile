# The harness daemon image.
#
# The build context is `examples/next/harnesses`, not this directory: the
# daemon imports the shared wire contracts and the typed Claude Code layer
# with relative type-only imports, so the build stage reproduces the repo
# layout under `/build` and those paths resolve literally.
#
# Two stages. The build stage has the toolchain and produces one bundle; the
# runtime stage has Node, the tools the agent is expected to reach for, and
# the Agent SDK, which stays outside the bundle because it ships the Claude
# Code CLI binary alongside its JavaScript.

# ── build ────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /build/claude-code/container

# The daemon's own dependency graph first, so a source-only change reuses
# the install layer.
COPY claude-code/container/package.json claude-code/container/package-lock.json ./
RUN npm ci

# The three source trees the daemon compiles against, in their repo-relative
# positions.
COPY shared/src/protocol.ts /build/shared/src/protocol.ts
COPY shared/src/types.ts /build/shared/src/types.ts
COPY claude-code/src/claude-code-types.ts /build/claude-code/src/claude-code-types.ts
COPY claude-code/container/harnessd.tsconfig.json ./harnessd.tsconfig.json
COPY claude-code/container/src ./src

RUN npm run build && npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────
FROM node:24-slim
# git and ripgrep are what the agent's own tools shell out to; curl and the
# CA bundle are what everything else needs to reach the API.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Non-root on purpose. `permissionMode: "default"` plus an allow list plus
# the PreToolUse gate needs no root escape hatch, and the modes that would
# have needed one are refused by the engine.
RUN useradd --create-home --uid 10001 --shell /bin/bash agent \
  && mkdir -p /workspace /var/lib/harnessd \
  && chown -R agent:agent /workspace /var/lib/harnessd

# The bundle is self-contained apart from the Agent SDK, which must be a real
# package at runtime: it resolves its own CLI binary from its package root.
COPY --from=build --chown=agent:agent /build/claude-code/container/dist /app/dist
COPY --from=build --chown=agent:agent /build/claude-code/container/node_modules /app/node_modules
COPY --from=build --chown=agent:agent /build/claude-code/container/package.json /app/package.json

ENV DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production \
    CF_HARNESS_PORT=8787
EXPOSE 8787
USER agent
WORKDIR /workspace
CMD ["node", "/app/dist/main.mjs"]
