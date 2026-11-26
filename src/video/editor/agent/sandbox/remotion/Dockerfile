# Remotion render sandbox for agent graphics (the default renderer). Same
# isolation as the HyperFrames image (../Dockerfile): fresh container, network
# off, read-only root, non-root user.
# Build with tools/build-remotion-sandbox.sh (bun run build:sandbox): it adds
# the repo's bundled fonts (Pixelify Sans) as the `fonts` build context.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fontconfig fonts-inter fonts-jetbrains-mono fonts-noto-color-emoji fonts-dejavu-core \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libfontconfig1 libfreetype6 \
      libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libxcomposite1 libxdamage1 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
      $(if [ "$(dpkg --print-architecture)" = arm64 ]; then echo chromium; fi) \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --no-audit --no-fund
ENV HOME=/home/render REMOTION_DISABLE_TELEMETRY=1
RUN useradd -m -u 10001 render && mkdir -p /app/fonts \
  && fc-list : file | cut -d: -f1 | grep -iE 'inter|jetbrains' | xargs -I{} cp {} /app/fonts/ \
  && chown -R render /app
# Fonts no Debian package has (Pixelify Sans, OFL), from apps/editor-mcp/fonts.
COPY --from=fonts --chown=render PixelifySans-Regular.ttf OFL-PixelifySans.txt /app/fonts/
USER render
# Fetch the render browser at build time; at run time there is no network.
# On Linux arm64 use Debian's chromium (same as the HyperFrames image).
RUN if [ -x /usr/bin/chromium ]; then echo /usr/bin/chromium > /app/browser-path; \
  else npx remotion browser ensure && echo '' > /app/browser-path; fi
COPY --chown=render entry.jsx render.mjs render.sh /app/
COPY --chown=render scenes /app/scenes
ENTRYPOINT ["sh", "/app/render.sh"]
