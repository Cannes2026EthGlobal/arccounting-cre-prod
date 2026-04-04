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

interface Request {
  _id: string
  employeeId: string
  amount: number             // float64 USDC
  recipientAddress: string   // payment destination
  scheduledDate: number      // ms timestamp
  status: 'pending' | 'paid' | 'rejected'
  txHash?: string
}

interface ConvexQueryResponse<T> {
  status: string
  value: T
}

// ---------------------------------------------------------------------------
// FETCH DUE REQUESTS FROM CONVEX
// ---------------------------------------------------------------------------

const fetchDueRequests = (runtime: Runtime<Config>): Request[] => {
  const httpCapability = new cre.capabilities.ConfidentialHTTPClient()

  const res = httpCapability.sendRequest(runtime, {
    request: {
      method: 'POST',
      url: `${runtime.config.convexUrl}/api/query`,
      multiHeaders: {
        'Content-Type': { values: ['application/json'] },
      },
      bodyString: JSON.stringify({ path: 'requests:getDueRequests', args: {} }),
    },
  }).result()

  if (res.statusCode !== 200) {
    throw new Error(`Convex getDueRequests failed: HTTP ${res.statusCode}`)
  }

  const text = new TextDecoder().decode(res.body)
  const data: ConvexQueryResponse<Request[]> = JSON.parse(text)

  if (data.status !== 'success') {
    throw new Error(`Convex error: ${JSON.stringify(data)}`)
  }

  return data.value
}

// ---------------------------------------------------------------------------
// MARK A REQUEST AS FULFILLED IN CONVEX
// ---------------------------------------------------------------------------

/**
 * Calls the Convex `requests:fulfillRequest` mutation to atomically mark
 * the request as paid and increment the employee's totalPaid counter.
 *
 * This is called AFTER a successful on-chain payment. If the mutation fails,
 * we log a warning but do NOT throw — the on-chain payment is irreversible
 * and the request will be retried on the next cron cycle (the mutation's
 * idempotency guard prevents double-payment).
 */
const fulfillRequest = (
  runtime: Runtime<Config>,
  requestId: string,
  txHash: string,
): void => {
  const httpCapability = new cre.capabilities.ConfidentialHTTPClient()

  const res = httpCapability.sendRequest(runtime, {
    request: {
      method: 'POST',
      url: `${runtime.config.convexUrl}/api/mutation`,
      multiHeaders: {
        'Content-Type': { values: ['application/json'] },
      },
      bodyString: JSON.stringify({
        path: 'requests:fulfillRequest',
        args: { requestId, txHash },
      }),
    },
  }).result()

  if (res.statusCode !== 200) {
    runtime.log(
      `WARNING: fulfillRequest mutation failed for requestId=${requestId} txHash=${txHash}. ` +
      `HTTP ${res.statusCode}. Request stays pending — will retry next cycle.`,
    )
    return
  }

  const text = new TextDecoder().decode(res.body)
  const data = JSON.parse(text)
  if (data.status !== 'success') {
    runtime.log(
      `WARNING: fulfillRequest returned non-success for requestId=${requestId}: ` +
      `${JSON.stringify(data)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// TRIGGER A SINGLE PAYMENT
// ---------------------------------------------------------------------------

const sendPayment = (
  runtime: Runtime<Config>,
  request: Request,
): string => {
  const { payrollContractAddress, chainSelectorName, gasLimit } = runtime.config

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: true })
  if (!network) throw new Error(`Unknown network: ${chainSelectorName}`)

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

  // Amount is in USDC (float), convert to wei (18 decimals)
  const amountWei = BigInt(Math.round(request.amount * 1e18))

  runtime.log(
    `Paying ${request.recipientAddress} → ${request.amount} USDC (${amountWei} wei) ` +
    `[requestId: ${request._id}]`,
  )

  const encoded = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [request.recipientAddress as `0x${string}`, amountWei],
  )

  const report = runtime.report(prepareReportRequest(encoded)).result()

  const result = evmClient.writeReport(runtime, {
    receiver: payrollContractAddress,
    report,
    gasConfig: { gasLimit: gasLimit.toString() },
  }).result()

  if (result.txStatus !== TxStatus.SUCCESS) {
    throw new Error(
      `Payment failed for ${request.recipientAddress}: ` +
      `${result.errorMessage ?? result.txStatus}`,
    )
  }

  const txHash = bytesToHex(result.txHash ?? new Uint8Array(32))
  runtime.log(
    `Paid ${request.amount} USDC to ${request.recipientAddress} — txHash: ${txHash}`,
  )
  return txHash
}

// ---------------------------------------------------------------------------
// CRON CALLBACK
// ---------------------------------------------------------------------------

export const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log('Payroll trigger fired — fetching due requests from Convex...')

  const requests = fetchDueRequests(runtime)
  runtime.log(`Found ${requests.length} due request(s)`)

  if (requests.length === 0) {
    return 'No due requests to process'
  }

  const results: string[] = []
  const failures: string[] = []

  for (const request of requests) {
    try {
      const txHash = sendPayment(runtime, request)
      fulfillRequest(runtime, request._id, txHash)
      results.push(`${request.recipientAddress}:${request.amount}USDC:${txHash}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      runtime.log(`ERROR processing requestId=${request._id}: ${msg}`)
      failures.push(`${request._id}:${msg}`)
    }
  }

  const summary = `Processed ${results.length} payment(s): ${results.join(', ')}`
  if (failures.length > 0) {
    return `${summary} | ${failures.length} failure(s): ${failures.join(', ')}`
  }
  return summary
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
