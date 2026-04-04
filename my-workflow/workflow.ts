import {
  bytesToHex,
  type CronPayload,
  cre,
  getNetwork,
  prepareReportRequest,
  type Runtime,
  TxStatus,
} from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// CONFIG SCHEMA
// ---------------------------------------------------------------------------

export const configSchema = z.object({
  // Cron expression — how often to run. "*/30 * * * * *" = every 30 seconds.
  schedule: z.string(),

  // Address of the deployed Payroll contract on ARC testnet
  payrollContractAddress: z.string(),

  // Recipient address to receive the payment
  recipientAddress: z.string(),

  // Payment amount in wei (USDC on ARC has 18 decimals, so 1e18 = 1 USDC)
  amount: z.string(),

  // Chain selector name — "arc-testnet"
  chainSelectorName: z.string(),

  // Gas limit for the on-chain write transaction
  gasLimit: z.string(),
})

export type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------------------
// TRIGGER PAYMENT
// ---------------------------------------------------------------------------
// Encodes (recipient, amount) and submits to Payroll via the CRE Forwarder.
//
//   CRE workflow
//       └── evmClient.writeReport()
//               ▼
//       KeystoneForwarder (verifies DON signatures)
//               ▼
//       Payroll._processReport()  →  recipient.call{value: amount}("")

const triggerPayment = (runtime: Runtime<Config>): string => {
  const { payrollContractAddress, recipientAddress, amount, chainSelectorName, gasLimit } = runtime.config

  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName,
    isTestnet: true,
  })
  if (!network) throw new Error(`Unknown network: ${chainSelectorName}`)

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

  const amountBigInt = BigInt(amount)

  runtime.log(`Paying ${recipientAddress} → ${amountBigInt} wei (${Number(amountBigInt) / 1e18} USDC)`)

  // ABI-encode (address recipient, uint256 amount) — matches Payroll._processReport decode
  const encoded = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [recipientAddress as `0x${string}`, amountBigInt],
  )

  const report = runtime.report(prepareReportRequest(encoded)).result()

  const result = evmClient.writeReport(runtime, {
    receiver: payrollContractAddress,
    report,
    gasConfig: { gasLimit: gasLimit.toString() },
  }).result()

  if (result.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Payment failed: ${result.errorMessage ?? result.txStatus}`)
  }

  const txHash = bytesToHex(result.txHash ?? new Uint8Array(32))
  runtime.log(`Payment sent! txHash: ${txHash}`)

  return `Paid ${Number(amountBigInt) / 1e18} USDC to ${recipientAddress} — ${txHash}`
}

// ---------------------------------------------------------------------------
// CRON CALLBACK
// ---------------------------------------------------------------------------

export const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log('Payroll trigger fired')
  return triggerPayment(runtime)
}

// ---------------------------------------------------------------------------
// WORKFLOW INIT
// ---------------------------------------------------------------------------

export function initWorkflow(config: Config) {
  const cronCapability = new cre.capabilities.CronCapability()
  return [
    cre.handler(
      cronCapability.trigger({ schedule: config.schedule }),
      onCronTrigger,
    ),
  ]
}
