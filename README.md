# Chaotix Deployment

This app has a Vite React client and an Express API that calls ggwave binaries. Below are options to deploy.

## Environment Variables

- `PORT`: API port (default 5055)
- `GGWAVE_BIN_DIR`: Directory containing `ggwave-to-file`, `ggwave-from-file`, `ggwave-cli`
- `SERVE_CLIENT`: Set to `true` to have the API serve the built client from `app/client/dist`
- Client build-time:
  - `VITE_API_BASE`: Absolute base for API, e.g. `https://yourdomain.com`
  - `VITE_WS_BASE`: Absolute base for WS, e.g. `wss://yourdomain.com`

## Local Production Build

1. Build client
   - `cd app/client && npm ci && npm run build`
2. Start server
   - `cd ../server && npm ci`
   - Ensure `GGWAVE_BIN_DIR` is set and binaries exist
   - `SERVE_CLIENT=true NODE_ENV=production PORT=5055 node src/index.js`

## Docker

Use the provided multi-stage Dockerfile and compose to build ggwave, client, and server.

```bash
docker compose up --build
```

The service will be available on `http://localhost:5055`.

# CHAOTIX_VoCrypt

## Build-time Client Config

When building the client, you can set:

```bash
# Example for custom domain
(cd app/client && VITE_API_BASE=https://your.domain VITE_WS_BASE=wss://your.domain npm run build)
```

If unset, the client uses same-origin URLs.

## Quick Start (Docker)

```bash
docker compose up --build -d
# open http://localhost:5055
```

## Quick Start (Bare Metal)

```bash
# 1) Build ggwave
cmake -S ggwave -B ggwave/build -DCMAKE_BUILD_TYPE=Release -DGGWAVE_BUILD_EXAMPLES=ON
cmake --build ggwave/build -j

# 2) Build client
(cd app/client && npm ci && npm run build)

# 3) Start server
(cd app/server && npm ci)
SERVE_CLIENT=true GGWAVE_BIN_DIR=$(pwd)/../../ggwave/build/bin PORT=5055 NODE_ENV=production node src/index.js
```
