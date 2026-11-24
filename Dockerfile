# Default hardened Linux runtime image for dsh-cloud-sandbox.
# Build: docker build -t dsh-cloud-sandbox-runtime:latest .
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      coreutils \
      findutils \
      git \
      grep \
      jq \
      nodejs \
      npm \
      procps \
      python3 \
      python3-venv \
      ripgrep \
      sed \
      tar \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Dedicated non-root user matching default security.user ("1000:1000").
RUN groupadd --gid 1000 sandbox \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash sandbox

USER 1000:1000
WORKDIR /tmp

CMD ["sleep", "infinity"]
