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
  schedule: z.string(),
  payrollContractAddress: z.string(),
  convexUrl: z.string(),
  chainSelectorName: z.string(),
  gasLimit: z.string(),
})

export type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------------------
// CONVEX TYPES
// ---------------------------------------------------------------------------

interface Paycheck {
  _id: string
  Amount: number      // float64, e.g. 1.5 = 1.5 USDC
  Recepient: string   // wallet address
}

interface ConvexResponse {
  status: string
  value: Paycheck[]
}

// ---------------------------------------------------------------------------
// FETCH PAYCHECKS FROM CONVEX
// ---------------------------------------------------------------------------

const fetchPaychecks = (runtime: Runtime<Config>): Paycheck[] => {
  const httpCapability = new cre.capabilities.ConfidentialHTTPClient()

  const res = httpCapability.sendRequest(runtime, {
    request: {
      method: 'POST',
      url: `${runtime.config.convexUrl}/api/query`,
      multiHeaders: {
        'Content-Type': { values: ['application/json'] },
      },
      bodyString: JSON.stringify({ path: 'paychecks:list', args: {} }),
    },
  }).result()

  if (res.statusCode !== 200) {
    throw new Error(`Convex query failed: HTTP ${res.statusCode}`)
  }

  const text = new TextDecoder().decode(res.body)
  const data: ConvexResponse = JSON.parse(text)

  if (data.status !== 'success') {
    throw new Error(`Convex error: ${JSON.stringify(data)}`)
  }

  return data.value
}

// ---------------------------------------------------------------------------
// TRIGGER A SINGLE PAYMENT
// ---------------------------------------------------------------------------

const sendPayment = (
  runtime: Runtime<Config>,
  paycheck: Paycheck,
): string => {
  const { payrollContractAddress, chainSelectorName, gasLimit } = runtime.config

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: true })
  if (!network) throw new Error(`Unknown network: ${chainSelectorName}`)

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

  // Amount is in USDC (float), convert to wei (18 decimals)
  const amountWei = BigInt(Math.round(paycheck.Amount * 1e18))

  runtime.log(`Paying ${paycheck.Recepient} → ${paycheck.Amount} USDC (${amountWei} wei)`)

  const encoded = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [paycheck.Recepient as `0x${string}`, amountWei],
  )

  const report = runtime.report(prepareReportRequest(encoded)).result()

  const result = evmClient.writeReport(runtime, {
    receiver: payrollContractAddress,
    report,
    gasConfig: { gasLimit: gasLimit.toString() },
  }).result()

  if (result.txStatus !== TxStatus.SUCCESS) {
    throw new Error(`Payment failed for ${paycheck.Recepient}: ${result.errorMessage ?? result.txStatus}`)
  }

  const txHash = bytesToHex(result.txHash ?? new Uint8Array(32))
  runtime.log(`Paid ${paycheck.Amount} USDC to ${paycheck.Recepient} — ${txHash}`)
  return txHash
}

// ---------------------------------------------------------------------------
// CRON CALLBACK
// ---------------------------------------------------------------------------

export const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log('Payroll trigger fired — fetching paychecks from Convex...')

  const paychecks = fetchPaychecks(runtime)
  runtime.log(`Found ${paychecks.length} paycheck(s)`)

  if (paychecks.length === 0) {
    return 'No paychecks to process'
  }

  const results: string[] = []
  for (const paycheck of paychecks) {
    const txHash = sendPayment(runtime, paycheck)
    results.push(`${paycheck.Recepient}:${paycheck.Amount}USDC:${txHash}`)
  }

  return `Processed ${results.length} payment(s): ${results.join(', ')}`
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
