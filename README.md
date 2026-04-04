# ETH Price Feed — CRE Demo

## How to run

```bash
# 1. Install CRE CLI (Mac/Linux)
curl -sSL https://cre.chain.link/install.sh | sh

# 2. Install Bun (TypeScript runtime)
curl -fsSL https://bun.sh/install | bash

# 3. Install dependencies
cd my-workflow
bun install

# 4. Simulate locally (no wallet needed)
cre workflow simulate my-workflow --target staging-settings
```

## Project structure

```
demo-eth-price-feed/
├── project.yaml                  # RPC endpoints per target
├── contracts/
│   └── PriceConsumer.sol         # Your on-chain contract (deploy to Sepolia)
└── my-workflow/
    ├── main.ts                   # Entry point
    ├── workflow.ts               # All the logic (heavily commented)
    ├── workflow.yaml             # Workflow name + artifact paths
    └── config.staging.json       # Runtime config (API URL, chain, etc.)
```
