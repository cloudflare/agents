# The agent's workspace container: computerd (the Computer workspace daemon)
# on a slim Debian image with Node.js, npm, and git, so the agent can install
# packages and run a dev server.
#
# computerd mounts the workspace at /workspace over FUSE and listens on :8080,
# so the agent's dev servers use any other port.
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.1 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git procps \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# FUSE_MOUNT=auto uses real FUSE on Cloudflare Containers and a userspace
# shim under local dev, where /dev/fuse isn't available.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
