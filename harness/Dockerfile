# Playwright base image ships Node + Chromium, so there is no first-run browser
# download (design §5.1). Keep the tag equal to the exact playwright version in
# harness/package.json, or Playwright won't find the bundled browser.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY harness/package.json harness/tsconfig.json harness/tsconfig.build.json harness/
RUN npm ci --workspace harness --include-workspace-root=false
COPY harness/src harness/src
RUN npm run build --workspace harness \
 && npm prune --omit=dev --workspace harness --include-workspace-root=false

FROM mcr.microsoft.com/playwright:v1.63.0-noble
# "Download media" fetches videos with yt-dlp; ffmpeg merges their audio and
# video and converts covers, locally. yt-dlp is pinned and checked against its
# release's published SHA-256; bump all three together. Its traffic goes
# through the server's egress proxy (harness/src/egress-proxy.ts).
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256_AMD64=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG YTDLP_SHA256_ARM64=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) asset=yt-dlp_linux; sum="$YTDLP_SHA256_AMD64" ;; \
      arm64) asset=yt-dlp_linux_aarch64; sum="$YTDLP_SHA256_ARM64" ;; \
      *) echo "no yt-dlp build for this architecture" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}" \
 && echo "${sum}  /usr/local/bin/yt-dlp" | sha256sum -c - \
 && chmod 755 /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && (yt-dlp --list-impersonate-targets || true)
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    BOOKMARKS_HOST=0.0.0.0 \
    BOOKMARKS_PORT=8787 \
    BOOKMARKS_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/harness/dist ./dist
COPY harness/ui ./ui
COPY harness/vendor ./vendor
COPY harness/package.json ./package.json
RUN mkdir -p /app/data && chown pwuser:pwuser /app/data
USER pwuser
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
