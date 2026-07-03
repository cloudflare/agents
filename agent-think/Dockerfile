# Sandbox container image for the think agent.
#
# Pulls the prebuilt wsd SEA binary out of the public GHCR image
# published by github.com/cloudflare/workspace, pinned in lockstep
# with the `@cloudflare/workspace` npm dependency (see package.json).
# wsd runs as PID 1 and serves the workspace RPC + FUSE mount.
#
# Layered on top: a Node.js + Bun toolchain (node, npm, bun, esbuild,
# wrangler) plus git / gh / curl so `exec` calls from the agent find
# them on PATH inside the FUSE-mounted /workspace. The image stays
# otherwise lean.

FROM ghcr.io/cloudflare/workspace-wsd-linux-x64:0.0.0-alpha.11 AS wsd

FROM debian:stable-slim

# Base toolchain + FUSE runtime.
#
# Everything here comes from Debian's own apt (HTTP transport + GPG-signed
# packages), so the build has NO HTTPS fetch that a TLS-inspecting proxy
# (Cloudflare WARP) would break. `gh` ships in Debian bookworm `main`, so
# there is no need to add GitHub's own HTTPS apt repo (which WARP *would*
# break) — we deliberately install the distro `gh` instead.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git bash unzip \
      fuse3 libfuse2t64 \
      build-essential \
      gh jq \
 && rm -rf /var/lib/apt/lists/*

# Optional WARP / corporate-MITM CA bundle.
#
# When the host runs behind Cloudflare WARP (or any other decrypting
# TLS proxy), the certificates the public CA bundle trusts are
# replaced with WARP's own roots. `curl`, `npm install`, `bun install`,
# etc. inside the build then fail with "unable to get local issuer
# certificate" the first time they touch an external HTTPS endpoint.
#
# The fix is to drop the WARP root bundle at `ca/warp-ca.crt`
# (gitignored — host-specific) before the build. The `ca/` directory
# itself is committed with a `.keep` so the `COPY` below always has
# at least one source; when no real CA file is present, the conditional
# `update-ca-certificates` is a no-op and the build behaves identically.
#
# Hosts without WARP just don't drop the file and pay zero cost. Note the
# build context is the app dir, so the COPY source is `ca/`.
COPY ca/ /opt/agent-ca/
RUN if ls /opt/agent-ca/*.crt >/dev/null 2>&1; then \
      cp /opt/agent-ca/*.crt /usr/local/share/ca-certificates/ \
      && update-ca-certificates ; \
    fi \
 && rm -rf /opt/agent-ca

# wsd binary. Statically linked SEA, no external deps needed.
COPY --from=wsd /usr/local/bin/wsd /usr/local/bin/wsd

# Project-specific toolchain. The agent's `exec` tool finds these
# CLIs on PATH inside the FUSE-mounted /workspace.
#
# TLS trust under Cloudflare WARP (or any decrypting corporate proxy):
# when the host CA bundle has been merged with WARP's root via the
# COPY + `update-ca-certificates` step above, every TLS client inside
# the container needs to find the bundle. Each ecosystem has its own
# env var:
#
#   - SSL_CERT_FILE       — OpenSSL fallback. Curl, git, native libs,
#                          and most language runtimes honour this.
#   - NODE_EXTRA_CA_CERTS — Node's TLS stack. Appends to its bundled
#                          CA list (not a replacement).
#   - REQUESTS_CA_BUNDLE  — Python's `requests`. Harmless when Python
#                          isn't installed; cheap insurance for any
#                          future Python add-ons or `pip` calls a
#                          user invokes via `exec`.
#
# Setting all three before the Node/Bun install means the global
# `npm install -g esbuild wrangler` and Bun bootstrap below also run
# through the trusted bundle — npm shells out to curl for some downloads
# and Node directly for others, so both env vars matter at install time,
# not just at agent runtime. See ca/ for the file the host-side WARP
# bundle drops into.
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Node.js 24 (Active LTS), Bun, TypeScript / Cloudflare Worker toolchain.
# Debian's `nodejs` package version moves with the base image; install the
# official binary tarball so shells inside the workspace consistently see
# Node 24. 24.x ships `node:sqlite` without the --experimental-sqlite
# flag (still RC, but importable as-is) and is the current Active LTS
# that the Cloudflare Workers runtime aligns against.
RUN NODE_VERSION=24.16.0 && \
    curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt \
      https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
      | tar -xJ -C /usr/local --strip-components=1 && \
    node --version && npm --version && \
    npm install -g esbuild@0.25.0 wrangler@4 pnpm@10 && \
    BUN_VERSION=1.2.23 && \
    curl -fsSL --cacert /etc/ssl/certs/ca-certificates.crt https://bun.sh/install \
      | bash -s "bun-v${BUN_VERSION}" && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    ln -s /root/.bun/bin/bunx /usr/local/bin/bunx && \
    bun --version && bunx --version

# wsd configuration. PORT and MOUNT_POINT are the defaults the
# CloudflareContainerBackend expects. FUSE_MOUNT=auto probes
# /dev/fuse at startup: real FUSE under Cloudflare Containers,
# userspace shim when /dev/fuse isn't passed through (wrangler dev
# on macOS, CI without CAP_SYS_ADMIN). Same image works in both.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
