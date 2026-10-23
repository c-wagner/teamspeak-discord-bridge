# Stage 1: build the TeamSpeak side (Rust)
FROM rust:1-bookworm AS ts-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY ts-side/Cargo.toml ts-side/Cargo.lock ./
COPY ts-side/src ./src
RUN cargo build --release --locked

# Stage 2: runtime with Node.js
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/discord-side
COPY discord-side/package.json discord-side/package-lock.json ./
RUN npm ci --omit=dev
COPY discord-side/*.js ./
COPY --from=ts-build /src/target/release/ts-bridge /app/ts-bridge

ENV TS_BINARY=/app/ts-bridge
# config.json and identities/ live in the mounted /data folder
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js", "/data/config.json"]
