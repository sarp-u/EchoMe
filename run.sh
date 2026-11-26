#!/usr/bin/env bash
# EchoMe launcher
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8760}"
HOST="${HOST:-127.0.0.1}"

# Prefer the existing Chatterbox environment when available.
VENV="${CHATTERBOX_VENV:-}"
if [ -z "$VENV" ]; then
  if [ -x "$PWD/.venv/bin/python" ]; then
    VENV="$PWD/.venv"
  elif [ -x "$HOME/chatterbox_tr/venv/bin/python" ]; then
    VENV="$HOME/chatterbox_tr/venv"
  else
    VENV="$PWD/.venv"
  fi
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "→ Python sanal ortamı oluşturuluyor: $VENV"
  PY="$(command -v python3.11 || command -v python3.12 || command -v python3)"
  "$PY" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --upgrade pip
  "$VENV/bin/python" -m pip install -r requirements.txt
fi

if ! "$VENV/bin/python" -c "import chatterbox, fastapi, uvicorn" >/dev/null 2>&1; then
  echo "→ Eksik bağımlılıklar kuruluyor…"
  "$VENV/bin/python" -m pip install -r requirements.txt
fi

echo ""
echo "  EchoMe"
echo "  → http://127.0.0.1:${PORT}"
echo "  (Durdurmak için Ctrl+C)"
echo ""

if [ "${NO_OPEN:-0}" != "1" ]; then
  (
    for _ in $(seq 1 90); do
      if curl -fsS "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
        open "http://127.0.0.1:${PORT}" >/dev/null 2>&1 || true
        break
      fi
      sleep 1
    done
  ) &
fi

exec "$VENV/bin/python" -m uvicorn server:app --host "$HOST" --port "$PORT"
