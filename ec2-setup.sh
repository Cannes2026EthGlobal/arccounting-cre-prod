#!/bin/bash
# One-time EC2 setup script (Amazon Linux 2 / Ubuntu).
# Run as: bash ec2-setup.sh
set -euo pipefail

# ── Node / Bun ────────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
fi

# ── CRE CLI ───────────────────────────────────────────────────────────────────
if ! command -v cre &>/dev/null; then
  echo "Installing cre CLI..."
  # Install via npm/bun global (adjust if Chainlink distributes differently)
  bun install -g @chainlink/cre-cli 2>/dev/null || \
  npm install -g @chainlink/cre-cli 2>/dev/null || \
  echo "WARNING: could not install cre via package manager — install manually"
fi

# ── Project deps ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/my-workflow"
echo "Installing workflow dependencies..."
bun install

echo ""
echo "Setup complete. Next steps:"
echo "  1. Set your private key:"
echo "       export CRE_ETH_PRIVATE_KEY=0x..."
echo "     or ensure PRIVATE_KEY= is in .env"
echo ""
echo "  2. Start the loop:"
echo "       cd $SCRIPT_DIR"
echo "       chmod +x run-loop.sh"
echo "       screen -S payroll ./run-loop.sh"
echo ""
echo "  To reattach:  screen -r payroll"
echo "  To detach:    Ctrl+A then D"
