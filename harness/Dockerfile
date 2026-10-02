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
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    BOOKMARKS_HOST=0.0.0.0 \
    BOOKMARKS_PORT=8787 \
    BOOKMARKS_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/harness/dist ./dist
COPY harness/package.json ./package.json
RUN mkdir -p /app/data && chown pwuser:pwuser /app/data
USER pwuser
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
