FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 \
    libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 fonts-inter fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
RUN node -e "require('@remotion/renderer').ensureBrowser().then(()=>console.log('browser ok'))"
COPY kit.tsx root.tsx render.mjs ./
RUN useradd -m -u 10001 render && chown -R render /app
USER render
ENV NODE_MODULES=/app/node_modules
ENTRYPOINT ["node", "/app/render.mjs"]
