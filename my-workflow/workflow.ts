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
  schedule:          z.string(),
  convexUrl:         z.string(),
  chainSelectorName: z.string(),
  gasLimit:          z.string(),
})

export type Config = z.infer<typeof configSchema>

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

interface DuePayment {
  employeeId:             string
  walletAddress:          string
  amountCents:            number   // USDC cents, e.g. 100 = $1.00
  payrollContractAddress: string
  companyId:              string
  frequency:              string
  compensationLineId?:    string
  compensationSplitId?:   string
  description:            string
  type:                   'salary' | 'credit'
  employeePaymentId?:     string
}

interface ConvexQueryResponse<T> {
  status: string
  value: T
}

// ---------------------------------------------------------------------------
// FETCH DUE EMPLOYEES FROM CONVEX
// ---------------------------------------------------------------------------

const fetchDuePayments = (runtime: Runtime<Config>): DuePayment[] => {
  const http = new cre.capabilities.ConfidentialHTTPClient()

  const res = http.sendRequest(runtime, {
    request: {
      method: 'POST',
      url: `${runtime.config.convexUrl}/api/query`,
      multiHeaders: {
        'Content-Type': { values: ['application/json'] },
      },
      bodyString: JSON.stringify({ path: 'cre:getDueEmployees', args: {} }),
    },
  }).result()

  if (res.statusCode !== 200) {
    throw new Error(`Convex getDueEmployees failed: HTTP ${res.statusCode}`)
  }

  const text = new TextDecoder().decode(res.body)
  const data: ConvexQueryResponse<DuePayment[]> = JSON.parse(text)

  if (data.status !== 'success') {
    throw new Error(`Convex error: ${JSON.stringify(data)}`)
  }

  return data.value
}

// ---------------------------------------------------------------------------
// MARK EMPLOYEE AS PAID IN CONVEX
// ---------------------------------------------------------------------------

const markPaid = (
  runtime: Runtime<Config>,
  payment: DuePayment,
  txHash: string,
  paidAt: number,
): void => {
  const http = new cre.capabilities.ConfidentialHTTPClient()

  const args: Record<string, unknown> = {
    employeeId: payment.employeeId,
    type: payment.type,
    walletAddress: payment.walletAddress,
    txHash,
    amountCents: payment.amountCents,
    paidAt,
  }
  if (payment.compensationLineId) {
    args.compensationLineId = payment.compensationLineId
  }
  if (payment.compensationSplitId) {
    args.compensationSplitId = payment.compensationSplitId
  }
  if (payment.employeePaymentId) {
    args.employeePaymentId = payment.employeePaymentId
  }

  const res = http.sendRequest(runtime, {
    request: {
      method: 'POST',
      url: `${runtime.config.convexUrl}/api/mutation`,
      multiHeaders: {
        'Content-Type': { values: ['application/json'] },
      },
      bodyString: JSON.stringify({ path: 'cre:markPaid', args }),
    },
  }).result()

  if (res.statusCode !== 200) {
    runtime.log(
      `WARNING: markPaid failed for employeeId=${payment.employeeId} txHash=${txHash}. ` +
      `HTTP ${res.statusCode}. Payment may be retried next cycle.`,
    )
    return
  }

  const text = new TextDecoder().decode(res.body)
  const data = JSON.parse(text)
  if (data.status !== 'success') {
    runtime.log(
      `WARNING: markPaid non-success for employeeId=${payment.employeeId}: ${JSON.stringify(data)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// TRIGGER A SINGLE PAYMENT
// ---------------------------------------------------------------------------

const sendPayment = (
  runtime: Runtime<Config>,
  payment: DuePayment,
): string => {
  const { chainSelectorName, gasLimit } = runtime.config
  const { payrollContractAddress, walletAddress, amountCents, employeeId, companyId } = payment

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: true })
  if (!network) throw new Error(`Unknown network: ${chainSelectorName}`)

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

  // cents → USDC → wei (18 decimals)
  const amountWei = BigInt(Math.round((amountCents / 100) * 1e18))

  runtime.log(
    `Paying ${walletAddress} → $${(amountCents / 100).toFixed(2)} USDC (${amountWei} wei) ` +
    `[employeeId: ${employeeId}] [companyId: ${companyId}] [contract: ${payrollContractAddress}]`,
  )

  const encoded = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [walletAddress as `0x${string}`, amountWei],
  )

  const report = runtime.report(prepareReportRequest(encoded)).result()

  const result = evmClient.writeReport(runtime, {
    receiver: payrollContractAddress,
    report,
    gasConfig: { gasLimit: gasLimit.toString() },
  }).result()

  if (result.txStatus !== TxStatus.SUCCESS) {
    throw new Error(
      `Payment failed for ${walletAddress}: ${result.errorMessage ?? result.txStatus}`,
    )
  }

  const txHash = bytesToHex(result.txHash ?? new Uint8Array(32))
  runtime.log(`Paid $${(amountCents / 100).toFixed(2)} USDC to ${walletAddress} — txHash: ${txHash}`)
  return txHash
}

// ---------------------------------------------------------------------------
// CRON CALLBACK
// ---------------------------------------------------------------------------

export const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
  runtime.log('Payroll trigger fired — fetching due payments from Convex...')

  const payments = fetchDuePayments(runtime)
  runtime.log(`Found ${payments.length} due payment(s)`)

  if (payments.length === 0) {
    return 'No due payments today'
  }

  const results: string[] = []
  const failures: string[] = []

  for (const payment of payments) {
    try {
      const paidAt = Date.now()
      const txHash = sendPayment(runtime, payment)
      markPaid(runtime, payment, txHash, paidAt)
      results.push(`${payment.walletAddress}:$${(payment.amountCents / 100).toFixed(2)}:${txHash}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      runtime.log(`ERROR processing employeeId=${payment.employeeId} (${payment.description}): ${msg}`)
      failures.push(`${payment.employeeId}:${msg}`)
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
