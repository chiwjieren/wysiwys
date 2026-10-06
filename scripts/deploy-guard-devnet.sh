#!/usr/bin/env bash
# Builds and deploys (or upgrades) the guard program on devnet through the RPC in .env.
# Usage: scripts/deploy-guard-devnet.sh   (resume a failed deploy with BUFFER=<buffer address>)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
RPC="${HELIUS_DEVNET_RPC_URL:-https://api.devnet.solana.com}"
PROGRAM_KEYPAIR=keys/omnicounter_guard-program-keypair.json
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")

anchor build -p omnicounter_guard
solana program deploy target/deploy/omnicounter_guard.so \
  --program-id "$PROGRAM_KEYPAIR" \
  ${BUFFER:+--buffer "$BUFFER"} \
  -u "$RPC" \
  --with-compute-unit-price 100000 \
  --max-sign-attempts 50
solana program show "$PROGRAM_ID" -u "$RPC"
