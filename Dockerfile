# --- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Baileys decrypts with native crypto only, so no build toolchain is needed
# here — but it does need CA certs to reach WhatsApp and the Claude API.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The auth credentials and state live on the mounted volume.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
