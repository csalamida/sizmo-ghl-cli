#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/bin/sizmo.mjs" "$HOME/.local/bin/sizmo"
chmod +x "$DIR/bin/sizmo.mjs"
echo "linked: $HOME/.local/bin/sizmo → $DIR/bin/sizmo.mjs"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo 'WARN: add ~/.local/bin to PATH: echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.zshrc';; esac
