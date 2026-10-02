# Playwright base image ships Node + Chromium, so there is no first-run browser
# download (design §5.1). Keep the tag in sync with the playwright dependency
# once the capture engine lands.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY harness/package.json harness/tsconfig.json harness/tsconfig.build.json harness/
COPY package-lock.json ./
RUN npm ci --workspace harness --include-workspace-root=false
COPY harness/src harness/src
RUN npm run build --workspace harness

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production \
    BOOKMARKS_HOST=0.0.0.0 \
    BOOKMARKS_PORT=8787
WORKDIR /app
COPY --from=build /app/harness/dist ./dist
RUN mkdir -p /app/data && chown pwuser:pwuser /app/data
USER pwuser
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "dist/server.js"]
