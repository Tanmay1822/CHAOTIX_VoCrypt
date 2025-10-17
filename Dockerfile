# Multi-stage build: ggwave binaries, client build, final runtime

# 1) Build ggwave binaries
FROM ubuntu:22.04 AS ggwave-builder
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential cmake git pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /src/ggwave
COPY ggwave/ ./
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGGWAVE_BUILD_EXAMPLES=ON -DGGWAVE_SUPPORT_SDL2=OFF && \
    cmake --build build --target ggwave-to-file ggwave-from-file -j

# 2) Build client
FROM node:20-bullseye AS client-builder
WORKDIR /app
COPY app/client/package.json app/client/package-lock.json ./client/
RUN cd client && npm ci
COPY app/client/ ./client/
RUN cd client && npm run build

# 3) Install server deps
FROM node:20-bullseye AS server-deps
WORKDIR /srv
COPY app/server/package.json app/server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# 4) Final runtime image
FROM node:20-bullseye
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /srv

# ggwave binaries
COPY --from=ggwave-builder /src/ggwave/build/bin/ /opt/ggwave/bin/

# server
COPY --from=server-deps /srv/server/node_modules ./server/node_modules
COPY app/server/ ./server/

# client build (served statically by the server when SERVE_CLIENT=true)
COPY --from=client-builder /app/client/dist ./client/dist

ENV GGWAVE_BIN_DIR=/opt/ggwave/bin \
    SERVE_CLIENT=true \
    PORT=5055

EXPOSE 5055
CMD ["node", "server/src/index.js"]


