FROM cloudflare/sandbox:0.0.0-pr-567-27c1561-opencode

# Install custom CA certificates if provided by the host.
# The prepare-build script copies SSL_CERT_FILE → .build/ca-certificates.crt
COPY .build/ca-certificates.cr[t] /usr/local/share/ca-certificates/custom-ca.crt
RUN if [ -f /usr/local/share/ca-certificates/custom-ca.crt ]; then \
      update-ca-certificates; \
    fi

# Create a non-root user for the workspace and OpenCode session.
# The sandbox client (bun server on port 3000) stays as root for
# backup/restore permissions. OpenCode runs as the opencode user
# via the user config passed to createOpencode().
RUN useradd -m -s /bin/bash -d /home/opencode opencode \
 && mkdir -p /workspace /var/backups \
 && chown opencode:opencode /workspace /var/backups

WORKDIR /workspace

# Expose OpenCode server port
EXPOSE 4096

# Expose ports for web services (8000-8005)
EXPOSE 8000-8005
