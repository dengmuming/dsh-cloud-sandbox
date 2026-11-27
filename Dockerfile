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
      python3-pip \
      python3-venv \
      ripgrep \
      sed \
      tar \
      unzip \
    && rm -rf /var/lib/apt/lists/*

# Preinstall common PDF, Office, and data libraries into immutable system site-packages
# so offline sandboxes (networkMode=none, ReadonlyRootfs=true) run document Skills out of the box.
RUN pip3 install --no-cache-dir --break-system-packages \
      pymupdf \
      pdfplumber \
      pypdf \
      openpyxl \
      python-docx \
      python-pptx \
      pillow \
      pandas \
      pyyaml

# Allow runtime `pip3 install <pkg>` (when networkMode is explicitly enabled) to install into
# writable `/tmp/.local` under ReadonlyRootfs=true without extra flags.
ENV PYTHONUSERBASE=/tmp/.local \
    PIP_USER=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH="/tmp/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Dedicated non-root user matching default security.user ("1000:1000").
RUN groupadd --gid 1000 sandbox \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash sandbox

USER 1000:1000
WORKDIR /tmp

CMD ["sleep", "infinity"]
