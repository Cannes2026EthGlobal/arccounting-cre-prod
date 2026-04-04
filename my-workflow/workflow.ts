/**
 * =============================================================================
 * ETH PRICE FEED — CRE Workflow (TypeScript)
 * =============================================================================
 *
 * WHAT THIS DOES (plain English):
 *   Every 30 seconds, this workflow:
 *     1. Fires a cron trigger
 *     2. Sends an HTTP request to CoinGecko to get the ETH/USD price
 *     3. Multiple DON nodes each independently fetch that price
 *     4. The nodes agree on a single price via median consensus
 *     5. The agreed price is ABI-encoded and signed into a "report"
 *     6. That report is submitted to the Forwarder contract on Sepolia
 *     7. The Forwarder verifies the DON signatures, then calls PriceConsumer.onReport()
 *     8. PriceConsumer stores the price on-chain — anyone can read it
 *
 * HOW IT CONNECTS TO BLOCKCHAIN:
 *
 *   Your workflow (WASM on DON nodes)
 *       │
 *       │  runtime.report() → creates a signed blob of data
 *       │
 *       ▼
 *   evmClient.writeReport() → sends it to:
 *       │
 *       ▼
 *   KeystoneForwarder (Chainlink contract)
 *       │  Checks: did enough DON nodes sign this? (BFT quorum)
 *       │  If yes → forwards to your contract
 *       ▼
 *   PriceConsumer.onReport(metadata, report)
 *       │  Decodes the ABI-encoded price from `report`
 *       └─ Stores it: s_ethPrice = decoded price
 *
 * =============================================================================
 */

import {
  bytesToHex,
  type CronPayload,
  cre,
  getNetwork,
  type HTTPSendRequester,
  median,
  ConsensusAggregationByFields,
  prepareReportRequest,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// CONFIG SCHEMA
// ---------------------------------------------------------------------------
// This defines the shape of config.staging.json.
// CRE validates the JSON file against this schema at startup.

export const configSchema = z.object({
  // Cron expression — how often to run. "*/30 * * * * *" = every 30 seconds.
  schedule: z.string(),

  // CoinGecko API URL to fetch ETH price
  apiUrl: z.string(),

  // The address of YOUR deployed PriceConsumer contract on Sepolia
  consumerAddress: z.string(),

  // Chain selector name — tells the SDK which chain to use
  chainSelectorName: z.string(),

  // Gas limit for the on-chain write transaction
  gasLimit: z.string(),
})

export type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------------------
// STEP 1: FETCH ETH PRICE FROM COINGECKO
// ---------------------------------------------------------------------------
// This function runs on EACH DON node independently.
// Because multiple nodes each call CoinGecko and might get slightly different
// prices (due to timing), we use median consensus to agree on a single value.

interface CoinGeckoResponse {
  ethereum: {
    usd: number
  }
}

interface PriceData {
  priceUsd: number  // The raw float price, e.g. 3241.57
}

const fetchEthPrice = (sendRequester: HTTPSendRequester, config: Config): PriceData => {
  // sendRequester.sendRequest() makes an HTTP GET.
  // In simulation: one node makes the call.
  // In production: EVERY node makes this call independently.
  const response = sendRequester.sendRequest({
    method: 'GET',
    url: config.apiUrl,
  }).result()

  if (response.statusCode !== 200) {
    throw new Error(`CoinGecko API failed: HTTP ${response.statusCode}`)
  }

  const body = Buffer.from(response.body).toString('utf-8')
  const data: CoinGeckoResponse = JSON.parse(body)

  return { priceUsd: data.ethereum.usd }
}

// ---------------------------------------------------------------------------
// STEP 2: WRITE THE PRICE ON-CHAIN
// ---------------------------------------------------------------------------
// After consensus, all nodes have agreed on a single price.
// Now we:
//   a) ABI-encode it as uint256 (Solidity compatible, scaled to 8 decimals)
//   b) Call runtime.report() to create a DON-signed report
//   c) Call evmClient.writeReport() to submit it to the Forwarder → your contract

const writePriceOnChain = (runtime: Runtime<Config>, priceUsd: number): void => {
  const { consumerAddress, chainSelectorName, gasLimit } = runtime.config

  // --- Find the chain ---
  // getNetwork() maps a human-readable chain name to a numeric chainSelector
  // that Chainlink's contracts understand.
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName,
    isTestnet: true,
  })
  if (!network) throw new Error(`Unknown network: ${chainSelectorName}`)

  // --- Create an EVM client for Sepolia ---
  // The chainSelector is a uint64 that uniquely identifies the chain
  // across the entire Chainlink ecosystem.
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

  // --- Scale the price to 8 decimal places ---
  // Solidity can't handle floats. We store 3241.57 as 324157000000 (uint256).
  // The consumer contract knows to divide by 1e8 to get the real price.
  const priceBigInt = BigInt(Math.round(priceUsd * 1e8))

  runtime.log(`ETH/USD price: $${priceUsd} → stored as ${priceBigInt} (8 decimals)`)

  // --- ABI-encode the price as uint256 ---
  // This creates a bytes blob that Solidity's abi.decode(report, (uint256)) can read.
  const encoded = encodeAbiParameters(parseAbiParameters('uint256'), [priceBigInt])

  // --- Generate a signed report ---
  // runtime.report() is a CRE SDK call that:
  //   1. Takes your encoded data
  //   2. Has all DON nodes sign it with their private keys
  //   3. Returns a report object with the data + signatures
  //
  // This is the "proof" that the data came from the DON, not a random caller.
  const report = runtime.report(prepareReportRequest(encoded)).result()

  // --- Submit the report to the Forwarder → PriceConsumer ---
  // evmClient.writeReport() sends a transaction to the KeystoneForwarder contract.
  // The Forwarder:
  //   1. Verifies all the DON node signatures on the report
  //   2. Checks that enough nodes signed (BFT quorum: 2f+1 out of 3f+1)
  //   3. Calls PriceConsumer.onReport(metadata, report)
  //
  // Your PriceConsumer then decodes the price and stores it.
  const result = evmClient.writeReport(runtime, {
    receiver: consumerAddress,
    report,
    gasConfig: { gasLimit: gasLimit.toString() },
  }).result()

  if (result.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`On-chain write failed: ${result.errorMessage ?? result.txStatus}`)
  }

  runtime.log(`Price written on-chain! txHash: ${bytesToHex(result.txHash ?? new Uint8Array(32))}`)
}

// ---------------------------------------------------------------------------
// STEP 3: THE MAIN CALLBACK — called when the cron trigger fires
// ---------------------------------------------------------------------------
// This is the function CRE calls every 30 seconds.

export const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  runtime.log('Cron triggered — fetching ETH price...')

  // --- Fetch price with consensus ---
  // HTTPClient.sendRequest() with a ConsensusAggregationByFields wrapper means:
  //   - Each node runs fetchEthPrice() independently
  //   - Results from all nodes are aggregated using `median` for each field
  //   - The final `priceData` is the consensus result — all nodes agree on this value
  //
  // WHY CONSENSUS?: If node 3 was hacked and returns $999999, it gets ignored
  // because it's an outlier. The median of all honest nodes' results wins.
  const httpCapability = new cre.capabilities.HTTPClient()

  const priceData = httpCapability
    .sendRequest(
      runtime,
      fetchEthPrice,
      ConsensusAggregationByFields<PriceData>({
        priceUsd: median,  // Use median across all node results for this field
      }),
    )(runtime.config)
    .result()

  runtime.log(`Consensus ETH price: $${priceData.priceUsd}`)

  // Write the consensus price on-chain
  writePriceOnChain(runtime, priceData.priceUsd)

  return `ETH/USD: $${priceData.priceUsd}`
}

// ---------------------------------------------------------------------------
// STEP 4: REGISTER THE HANDLER
// ---------------------------------------------------------------------------
// initWorkflow() tells CRE: "when the cron trigger fires, call onCronTrigger"
// This is the trigger → callback binding.

export function initWorkflow(config: Config) {
  const cronCapability = new cre.capabilities.CronCapability()

  return [
    cre.handler(
      // The trigger: fires on the schedule from config
      cronCapability.trigger({ schedule: config.schedule }),
      // The callback: our function above
      onCronTrigger,
    ),
  ]
}
