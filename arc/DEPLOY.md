# Payroll Contract — Deployment Instructions

## Overview

`Payroll.sol` is a CRE-triggered payroll contract on Arc testnet. The CRE workflow fetches paychecks from Convex, encodes `(address recipient, uint256 amount)`, and submits a signed report through the `KeystoneForwarder`, which calls `onReport()` → `_processReport()` on this contract.

## Prerequisites

- **Foundry** installed (`forge`, `cast`)
- **Private key** with Arc testnet USDC (native gas token) — set as `PRIVATE_KEY` in `.env`
- **Arc testnet USDC faucet**: https://faucet.circle.com (select Arc testnet)

## Network Details

| Parameter | Value |
|-----------|-------|
| Chain name | `arc-testnet` |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Native token | USDC (18 decimals) |
| KeystoneForwarder | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| Block explorer | https://testnet.arcscan.app |

## Source Files

All source is under `arc/src/`:

```
arc/src/
├── Payroll.sol           ← main contract
├── ReceiverTemplate.sol  ← abstract base (forwarder auth + onReport routing)
├── IReceiver.sol
└── IERC165.sol
```

No external dependencies (OpenZeppelin is inlined in `ReceiverTemplate.sol`).

## Step 1 — Run Tests

```bash
cd arc
forge test -v
```

All 18 tests should pass before deploying.

## Step 2 — Deploy

From the `arc/` directory:

```bash
source ../.env   # loads PRIVATE_KEY

cast send \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY \
  --create $(forge build --silent && cat out/Payroll.sol/Payroll.json | python3 -c "import sys,json; b=json.load(sys.stdin)['bytecode']['object']; print(b + '000000000000000000000000' + '6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1'.lower())")
```

Or using the two-step approach (recommended — easier to capture the address):

```bash
# 1. Build
cd arc
forge build

# 2. Get constructor-encoded bytecode
BYTECODE=$(cat out/Payroll.sol/Payroll.json | python3 -c "import sys,json; print(json.load(sys.stdin)['bytecode']['object'])")
CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(address)" 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1 | sed 's/0x//')

# 3. Deploy
cast send \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY \
  --create ${BYTECODE}${CONSTRUCTOR_ARGS}
```

The output will include the deployed contract address — save it.

## Step 3 — Verify on Arcscan

```bash
cd arc

forge verify-contract \
  <DEPLOYED_ADDRESS> \
  src/Payroll.sol:Payroll \
  --constructor-args $(cast abi-encode "constructor(address)" 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1) \
  --rpc-url https://rpc.testnet.arc.network \
  --chain 5042002 \
  --verifier blockscout \
  --verifier-url "https://testnet.arcscan.app/api/"
```

## Step 4 — Fund the Contract

The contract must hold native USDC to pay out. Deposit some:

```bash
cast send \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY \
  --value 5000000000000000000 \   # 5 USDC (18 decimals)
  <DEPLOYED_ADDRESS> \
  "deposit()"
```

Check balance:

```bash
cast call \
  --rpc-url https://rpc.testnet.arc.network \
  <DEPLOYED_ADDRESS> \
  "contractBalance()(uint256)"
```

## Step 5 — Wire Up the CRE Workflow

Update `my-workflow/config.staging.json` with the new address:

```json
{
  "schedule": "*/30 * * * * *",
  "payrollContractAddress": "<DEPLOYED_ADDRESS>",
  "convexUrl": "https://reliable-cow-820.eu-west-1.convex.cloud",
  "chainSelectorName": "arc-testnet",
  "gasLimit": "500000"
}
```

Then simulate to confirm the full flow works:

```bash
cd ..   # back to demo-eth-price-feed/

CRE_ETH_PRIVATE_KEY=$PRIVATE_KEY \
  cre workflow simulate my-workflow --target staging-settings --broadcast
```

Expected output:
```
[USER LOG] Payroll trigger fired — fetching paychecks from Convex...
[USER LOG] Found N paycheck(s)
[USER LOG] Paying 0x... → X USDC (... wei)
[USER LOG] Paid X USDC to 0x... — 0x<txhash>
✓ Workflow Simulation Result: "Processed N payment(s): ..."
```

## Security Notes

- **Only the KeystoneForwarder** (`0x6E9EE680...`) can call `onReport()` — enforced by `ReceiverTemplate`.
- Optionally lock down further by calling `setExpectedAuthor(address)` and `setExpectedWorkflowName(string)` with the workflow owner's address and workflow name after deployment (owner-only).
- The reentrancy guard (`_locked`) prevents re-entrant calls via malicious recipient contracts.

## Already-Deployed Instance

| Field | Value |
|-------|-------|
| Address | `0xb2C0CBFc616199509AA0a890782c81772Bf632E1` |
| Explorer | https://testnet.arcscan.app/address/0xb2C0CBFc616199509AA0a890782c81772Bf632E1 |
| Deployed by | `0xba232D9C9A551a60ff20F9f6AA3BBb21FE55F909` |
| Forwarder | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| Status | Verified |
