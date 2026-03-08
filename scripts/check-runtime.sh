#!/usr/bin/env bash
set -euo pipefail

required_node_major="${REQUIRED_NODE_MAJOR:-20}"
current_node_major="$(node -p "Number(process.versions.node.split('.')[0])")"

if [[ -z "${current_node_major}" ]] || (( current_node_major < required_node_major )); then
  echo "Node.js >=${required_node_major} is required. Current: $(node -v 2>/dev/null || echo 'not installed')"
  exit 1
fi

for cmd in npm curl grep sed; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}"
    exit 1
  fi
done

if [[ "${CHECK_LLM_KEYS:-0}" == "1" ]]; then
  if [[ -z "${OPENAI_API_KEY:-}" && -z "${OPENROUTER_KEY:-}" && -z "${OPENROUTER_API_KEY:-}" && -z "${VERCEL_AI_GATEWAY_API_KEY:-}" && -z "${VERCEL_AI_GATEWAY_KEY:-}" ]]; then
    echo "CHECK_LLM_KEYS=1 but no provider key found (OPENAI_API_KEY / OPENROUTER_KEY / OPENROUTER_API_KEY / VERCEL_AI_GATEWAY_API_KEY / VERCEL_AI_GATEWAY_KEY)."
    exit 1
  fi
fi

echo "runtime check passed: node=$(node -v), npm=$(npm -v)"
