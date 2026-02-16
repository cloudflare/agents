FROM docker.io/cloudflare/sandbox:0.7.4

# Add opencode install location to PATH before installation
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
  && bash /tmp/install-opencode.sh \
  && rm /tmp/install-opencode.sh \
  && opencode --version

# Create default workspace
RUN mkdir -p /home/user/project

# Start in the project directory
WORKDIR /home/user/project

# Expose OpenCode server port
EXPOSE 4096
