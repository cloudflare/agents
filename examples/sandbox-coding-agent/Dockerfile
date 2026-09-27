# The Sandbox SDK base image must match the installed @cloudflare/sandbox
# version (package.json pins 0.12.2).
FROM docker.io/cloudflare/sandbox:0.12.2

# Install the Claude Code CLI so each sub-agent can drive a turn from inside its
# container. Pinned so the `stream-json` event shape the runtime parses doesn't
# change under a rebuild; bump deliberately.
RUN npm install -g @anthropic-ai/claude-code@2.1.283

# Documents the port the sandbox control server listens on.
EXPOSE 8080
