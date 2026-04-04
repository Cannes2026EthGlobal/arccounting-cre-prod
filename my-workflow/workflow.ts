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

interface DueEmployee {
  _id:                    string
  walletAddress:          string
  amountCents:            number   // USDC cents, e.g. 100 = $1.00
  payrollContractAddress: string
  companyId:              string
  frequency:              string
}

interface ConvexQueryResponse<T> {
  status: string
  value: T
}

// ---------------------------------------------------------------------------
// FETCH DUE EMPLOYEES FROM CONVEX
// ---------------------------------------------------------------------------

const fetchDueEmployees = (runtime: Runtime<Config>): DueEmployee[] => {
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
  const data: ConvexQueryResponse<DueEmployee[]> = JSON.parse(text)

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
  employeeId: string,
  txHash: string,
  amountCents: number,
  paidAt: number,
): void => {
  const http = new cre.capabilities.ConfidentialHTTPClient()

  const res = http.sendRequest(runtime, {
    request: {
      method: 'POST',
      url: `${runtime.config.convexUrl}/api/mutation`,
      multiHeaders: {
        'Content-Type': { values: ['application/json'] },
      },
      bodyString: JSON.stringify({
        path: 'cre:markPaid',
        args: { employeeId, txHash, amountCents, paidAt },
      }),
    },
  }).result()

  if (res.statusCode !== 200) {
    runtime.log(
      `WARNING: markPaid failed for employeeId=${employeeId} txHash=${txHash}. ` +
      `HTTP ${res.statusCode}. nextPaymentDate not advanced — employee may be retried next cycle.`,
    )
    return
  }

  const text = new TextDecoder().decode(res.body)
  const data = JSON.parse(text)
  if (data.status !== 'success') {
    runtime.log(
      `WARNING: markPaid non-success for employeeId=${employeeId}: ${JSON.stringify(data)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// TRIGGER A SINGLE PAYMENT
// ---------------------------------------------------------------------------

const sendPayment = (
  runtime: Runtime<Config>,
  employee: DueEmployee,
): string => {
  const { chainSelectorName, gasLimit } = runtime.config
  const { payrollContractAddress, walletAddress, amountCents, _id, companyId } = employee

  const network = getNetwork({ chainFamily: 'evm', chainSelectorName, isTestnet: true })
  if (!network) throw new Error(`Unknown network: ${chainSelectorName}`)

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

  // cents → USDC → wei (18 decimals)
  const amountWei = BigInt(Math.round((amountCents / 100) * 1e18))

  runtime.log(
    `Paying ${walletAddress} → $${(amountCents / 100).toFixed(2)} USDC (${amountWei} wei) ` +
    `[employeeId: ${_id}] [companyId: ${companyId}] [contract: ${payrollContractAddress}]`,
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
  runtime.log('Payroll trigger fired — fetching due employees from Convex...')

  const employees = fetchDueEmployees(runtime)
  runtime.log(`Found ${employees.length} due employee(s)`)

  if (employees.length === 0) {
    return 'No due employees to pay today'
  }

  const results: string[] = []
  const failures: string[] = []

  for (const employee of employees) {
    try {
      const paidAt = Date.now()
      const txHash = sendPayment(runtime, employee)
      markPaid(runtime, employee._id, txHash, employee.amountCents, paidAt)
      results.push(`${employee.walletAddress}:$${(employee.amountCents / 100).toFixed(2)}:${txHash}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      runtime.log(`ERROR processing employeeId=${employee._id}: ${msg}`)
      failures.push(`${employee._id}:${msg}`)
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
