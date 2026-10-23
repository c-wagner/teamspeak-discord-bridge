#!/usr/bin/env bash
# Installs Node.js and Rust on a fresh Ubuntu/Debian machine and builds the bridge.
# Only needed if you do not use Docker.
set -euo pipefail
cd "$(dirname "$0")"

sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev cmake curl ca-certificates

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

echo "==> Building the TeamSpeak side (takes a few minutes the first time)"
(cd ts-side && cargo build --release --locked)

echo "==> Installing the Discord side"
(cd discord-side && npm ci --omit=dev)

if [ ! -f data/config.json ]; then
  cp data/config.example.json data/config.json
  echo "==> Created data/config.json, fill it in: nano data/config.json"
fi
echo "==> Done. Test run: cd discord-side && npm start"
