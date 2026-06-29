FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf \
    bash \
    binutils \
    build-essential \
    ca-certificates \
    cmake \
    coreutils \
    curl \
    gh \
    git \
    gnupg \
    gosu \
    jq \
    libc6-dev \
    libcap2-bin \
    libicu-dev \
    libssl-dev \
    make \
    pkg-config \
    wget \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
