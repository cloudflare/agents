# The Sandbox SDK base image must match the installed @cloudflare/sandbox
# version. Pinned to 0.12.1: the 0.12.2 image failed to publish to Docker Hub.
# See https://github.com/cloudflare/sandbox-sdk/issues/792
FROM docker.io/cloudflare/sandbox:0.12.1

# Install the Claude Code CLI so each sub-agent can drive a turn from inside its
# container.
RUN npm install -g @anthropic-ai/claude-code

# Documents the port the sandbox control server listens on.
EXPOSE 8080
