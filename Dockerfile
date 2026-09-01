# OpenFloor — one image, three roles.
#
# The same container serves the API, the auction floor, or a bidder console,
# selected at deploy time by env vars. That keeps the three Cloud Run services
# byte-identical, so a difference in behaviour between origins can only come
# from configuration, never from drift between builds.
#
# Frontend API/origin values are baked at build time (Vite inlines
# import.meta.env), so they arrive as build args.

FROM node:22-slim AS build
WORKDIR /app

ARG VITE_API_BASE=""
ARG VITE_FLOOR_ORIGIN=""
ARG VITE_BIDDER_ORIGINS=""
ARG VITE_ROOM="main"

COPY package.json package-lock.json ./
COPY packages/shared/package.json   packages/shared/
COPY packages/engine/package.json   packages/engine/
COPY packages/server/package.json   packages/server/
COPY packages/floor/package.json    packages/floor/
COPY packages/bidder/package.json   packages/bidder/
# The worker package is Cloudflare-only and not part of this image.
#
# Neither --omit=optional nor --ignore-scripts here: esbuild ships its compiled
# binary as a PLATFORM-SPECIFIC OPTIONAL dependency installed by a lifecycle
# script. The lockfile was generated on Windows, so the linux-x64 binary must be
# resolved during this build — omitting optionals fails with
# "The package @esbuild/linux-x64 could not be found".
RUN npm ci --no-audit --no-fund

COPY . .

ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_FLOOR_ORIGIN=$VITE_FLOOR_ORIGIN \
    VITE_BIDDER_ORIGINS=$VITE_BIDDER_ORIGINS \
    VITE_ROOM=$VITE_ROOM

RUN npm run build -w @openfloor/server \
 && npm run build -w @openfloor/floor \
 && npm run build -w @openfloor/bidder

# ── Runtime ──────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `ws` is the only runtime dependency; everything else is bundled by esbuild.
#
# A minimal manifest is written here rather than copying the server's own: that
# one declares workspace deps (@openfloor/engine, @openfloor/shared) which do
# not exist on the public registry, so npm would try to fetch them and 404.
# Those packages are already inlined into the bundle.
RUN printf '{"name":"openfloor","private":true,"type":"module","dependencies":{"ws":"^8.18.0"}}\n' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/packages/server/dist/server.js ./server.js
COPY --from=build /app/packages/floor/dist            ./static/floor
COPY --from=build /app/packages/bidder/dist           ./static/bidder

# Cloud Run injects PORT; default matches its convention.
ENV PORT=8080
EXPOSE 8080

# Run unprivileged.
USER node

CMD ["node", "server.js"]
