# HyperFrames render sandbox for the agent editor. The agent writes the
# composition HTML, so it renders here: fresh container, network off, read-only
# root, non-root user (same flags as src/video/graphics/render.ts).
#   docker build -t voxtale-hyperframes-sandbox:1 src/video/editor/agent/sandbox
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates fontconfig fonts-inter fonts-jetbrains-mono fonts-noto-color-emoji fonts-dejavu-core \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libfontconfig1 libfreetype6 \
      libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libxcomposite1 libxdamage1 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
      $(if [ "$(dpkg --print-architecture)" = arm64 ]; then echo chromium; fi) \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm init -y >/dev/null && npm install --no-audit --no-fund hyperframes@0.8.139 gsap@3.14.2
ENV PATH=/app/node_modules/.bin:$PATH HOME=/home/render
RUN useradd -m -u 10001 render && mkdir -p /app/fonts \
  && fc-list : file | cut -d: -f1 | grep -iE 'inter|jetbrains' | xargs -I{} cp {} /app/fonts/ \
  && chown -R render /app
USER render
# Fetch the render browser at build time; at run time there is no network.
# Linux arm64 has no Chrome Headless Shell, so use Debian's chromium there.
RUN hyperframes telemetry disable >/dev/null 2>&1; \
  if [ -x /usr/bin/chromium ]; then echo /usr/bin/chromium > /app/browser-path; \
  else hyperframes browser ensure && hyperframes browser path > /app/browser-path; fi
COPY --chown=render render.sh /app/render.sh
ENTRYPOINT ["sh", "/app/render.sh"]
