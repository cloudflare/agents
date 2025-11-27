# Pirate Shippie Sandbox Environment
# This container provides the execution environment for code review tasks

FROM docker.io/cloudflare/sandbox:0.5.4

# Install system dependencies for code review
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

