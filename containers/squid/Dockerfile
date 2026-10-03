FROM alpine:3.24 AS squid-builder

# Keep the source version aligned with the runtime package below.
ARG SQUID_VERSION=7.6
RUN apk add --no-cache build-base autoconf automake libtool heimdal-dev \
    libcap-dev linux-headers openssl-dev perl-dev curl
WORKDIR /build
RUN curl -fsSL "https://github.com/squid-cache/squid/archive/refs/tags/SQUID_$(echo "$SQUID_VERSION" | tr . _).tar.gz" -o squid.tar.gz && \
    echo "f58060a8bb6299f4753af7f02aebe210317258fc79632b43de2f4ef2b5b832f3df9054e906d13f2e45af7e012f8c6254e456ef3513414d8239a2d7b4e2e7f368  squid.tar.gz" | sha512sum -c - && \
    tar -xzf squid.tar.gz --strip-components=1
COPY clienthello-eof.patch /build/clienthello-eof.patch
# Remove this downstream guard once the packaged Squid handles pre-ClientHello EOF.
RUN patch -p1 < clienthello-eof.patch && \
    autoreconf -fiv && \
    CFLAGS="-Os -fstack-clash-protection -Wformat -Werror=format-security -fno-plt" \
    CXXFLAGS="-O2 -fstack-clash-protection -Wformat -Werror=format-security -fno-plt -D_GLIBCXX_ASSERTIONS=1" \
    LDFLAGS="-Wl,--as-needed,-O1,--sort-common -Wl,-z,pack-relative-relocs" \
    ./configure \
      --prefix=/usr --datadir=/usr/share/squid --sysconfdir=/etc/squid \
      --libexecdir=/usr/lib/squid --localstatedir=/var --with-logdir=/var/log/squid \
      --disable-strict-error-checking --disable-arch-native \
      --enable-removal-policies=lru,heap --enable-storeio=aufs,ufs,diskd,rock \
      --enable-auth-basic --enable-auth-digest --enable-auth-negotiate \
      --disable-mit --enable-heimdal --enable-delay-pools \
      --enable-openssl --enable-ssl-crtd --enable-linux-netfilter \
      --enable-ident-lookups --enable-useragent-log --enable-cache-digests \
      --enable-referer-log --enable-async-io --enable-truncate --enable-arp-acl \
      --enable-htcp --enable-carp --enable-poll --enable-epoll \
      --enable-follow-x-forwarded-for --with-large-files \
      --with-default-user=squid --with-openssl && \
    make -j2 && \
    make DESTDIR=/install install-strip

FROM alpine:3.24
ARG SQUID_VERSION=7.6

# Install Squid and supporting tools needed by runtime health checks and diagnostics.
# Keep bash + shadow so the compose preflight can continue to drop privileges with:
#   su -s /bin/bash proxy -c ...
RUN set -eux; \
    apk add --no-cache \
      bash \
      bind-tools \
      curl \
      net-tools \
      netcat-openbsd \
      openssl \
      shadow \
      "squid~${SQUID_VERSION}"; \
    # Alpine base assigns GID 13 to the 'news' group (and UID 9 to the 'news' user).
    # AWF requires proxy user/group at UID/GID 13 for log-dir ownership compatibility.
    # Remove the 'news' account first so those IDs are free to assign to 'proxy'.
    userdel news 2>/dev/null || true; \
    groupdel news 2>/dev/null || true; \
    groupadd -r -g 13 proxy; \
    useradd -r -u 13 -g proxy -M -s /sbin/nologin proxy

# Preserve Alpine's runtime dependencies, helpers, and error pages.
COPY --from=squid-builder /install/usr/sbin/squid /usr/sbin/squid

# Create log directory and SSL database directory, ensure proxy user owns them
RUN mkdir -p /var/log/squid /var/spool/squid /var/run/squid && \
    chown -R proxy:proxy /var/log/squid /var/spool/squid /var/run/squid /etc/squid

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose Squid port (3128 for HTTP, 3129 for HTTPS with SSL Bump)
EXPOSE 3128
EXPOSE 3129

# Run as non-root proxy user for security hardening
# Permission setup is done at build time; mounted volumes must be pre-configured
# by the host (docker-manager.ts sets correct ownership before starting containers)
USER proxy

# Use entrypoint to start Squid (runs as proxy user)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
