import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { Doc } from './_generated/dataModel'

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Computes how much USDC an employee has earned up to `nowMs`.
 *
 * For monthly paychecks: counts completed calendar months since startDate.
 * A month is "complete" once the payDate day has been reached in that month.
 * For payDate > 28, months where the day doesn't exist (e.g. Feb 30) are
 * treated as if payDate falls on the last day of that month.
 *
 * For weekly paychecks: counts completed weeks since startDate.
 * A week is "complete" once the payDate day-of-week has been reached.
 */
function computeEarned(
  paycheck: Doc<'paychecks'>,
  nowMs: number,
): number {
  const start = new Date(paycheck.startDate)
  const now = new Date(nowMs)

  let completedPeriods: number

  if (paycheck.interval === 'monthly') {
    const startYear  = start.getUTCFullYear()
    const startMonth = start.getUTCMonth()   // 0–11
    const nowYear    = now.getUTCFullYear()
    const nowMonth   = now.getUTCMonth()

    completedPeriods = (nowYear - startYear) * 12 + (nowMonth - startMonth)

    // The pay date in the current month may not have arrived yet.
    // Clamp payDate to the actual last day of this month to handle short months.
    const lastDayOfCurrentMonth = new Date(
      Date.UTC(nowYear, nowMonth + 1, 0),
    ).getUTCDate()
    const effectivePayDate = Math.min(paycheck.payDate, lastDayOfCurrentMonth)
    if (now.getUTCDate() < effectivePayDate) {
      completedPeriods -= 1
    }
  } else {
    // weekly
    const msPerWeek = 7 * 24 * 60 * 60 * 1000
    const startDayOfWeek = start.getUTCDay()   // 0–6
    const nowDayOfWeek   = now.getUTCDay()

    // Total full weeks elapsed
    const totalMs = nowMs - paycheck.startDate
    completedPeriods = Math.floor(totalMs / msPerWeek)

    // Check whether payDate day-of-week has been reached in the current partial week
    // "Days into current week" relative to payDate anchor
    const daysIntoCurrentWeek =
      (nowDayOfWeek - startDayOfWeek + 7) % 7
    const daysUntilPayDate =
      (paycheck.payDate - startDayOfWeek + 7) % 7
    if (daysIntoCurrentWeek < daysUntilPayDate) {
      completedPeriods -= 1
    }
  }

  return Math.max(0, completedPeriods) * paycheck.amount
}

// ---------------------------------------------------------------------------
// QUERIES
// ---------------------------------------------------------------------------

/**
 * Returns all requests (any status). Used for inspection/debugging.
 */
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('requests').take(200)
  },
})

/**
 * Returns all pending requests whose scheduledDate has passed AND whose
 * amount does not cause the employee to exceed 1-interval advance limit.
 *
 * Credit limit: totalPaid + request.amount <= earned + paycheck.amount
 *
 * Bounded at 50 per call to stay within Convex transaction limits.
 * Larger backlogs drain over successive CRE cron cycles.
 */
export const getDueRequests = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()

    const pendingDue = await ctx.db
      .query('requests')
      .withIndex('by_status_and_scheduledDate', (q) =>
        q.eq('status', 'pending').lte('scheduledDate', now),
      )
      .take(50)

    const eligible: typeof pendingDue = []
    // Track amounts already queued for each employee in this batch so that
    // multiple requests for the same employee are checked cumulatively,
    // not independently against the same totalPaid snapshot.
    const queuedPerEmployee = new Map<string, number>()

    for (const request of pendingDue) {
      const paycheck = await ctx.db
        .query('paychecks')
        .withIndex('by_employeeId', (q) =>
          q.eq('employeeId', request.employeeId),
        )
        .unique()

      if (!paycheck) continue

      const alreadyQueued = queuedPerEmployee.get(request.employeeId) ?? 0
      const earned   = computeEarned(paycheck, now)
      const maxOwed  = earned + paycheck.amount
      if (paycheck.totalPaid + alreadyQueued + request.amount <= maxOwed) {
        eligible.push(request)
        queuedPerEmployee.set(request.employeeId, alreadyQueued + request.amount)
      }
    }

    return eligible
  },
})

// ---------------------------------------------------------------------------
// MUTATIONS
// ---------------------------------------------------------------------------

/**
 * Atomically marks a request as paid and increments the employee's
 * totalPaid counter.
 *
 * Guards:
 * - Request must still be "pending" (idempotency / concurrent-run safety).
 * - Credit limit is re-checked inside the transaction to prevent TOCTOU races.
 *
 * Called by the CRE workflow via POST /api/mutation after a successful
 * evmClient.writeReport(). If this call fails after an on-chain success,
 * the CRE logs a warning with the txHash; the request stays pending and
 * will be retried on the next cron cycle — the idempotency guard ensures
 * the on-chain payment cannot be duplicated.
 */
export const fulfillRequest = mutation({
  args: {
    requestId: v.id('requests'),
    txHash:    v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId)
    if (!request) {
      throw new Error(`Request ${args.requestId} not found`)
    }
    if (request.status !== 'pending') {
      throw new Error(
        `Request ${args.requestId} is already ${request.status} — skipping`,
      )
    }

    const paycheck = await ctx.db
      .query('paychecks')
      .withIndex('by_employeeId', (q) =>
        q.eq('employeeId', request.employeeId),
      )
      .unique()

    if (!paycheck) {
      throw new Error(
        `No paycheck found for employee ${request.employeeId}`,
      )
    }

    // Re-check credit limit inside the transaction (TOCTOU guard)
    const now     = Date.now()
    const earned  = computeEarned(paycheck, now)
    const maxOwed = earned + paycheck.amount
    if (paycheck.totalPaid + request.amount > maxOwed) {
      throw new Error(
        `Credit limit exceeded for employee ${request.employeeId}: ` +
        `totalPaid=${paycheck.totalPaid} + request=${request.amount} > earned=${earned} + interval=${paycheck.amount}`,
      )
    }

    await ctx.db.patch(args.requestId, {
      status: 'paid',
      txHash: args.txHash,
    })

    await ctx.db.patch(paycheck._id, {
      totalPaid: paycheck.totalPaid + request.amount,
    })
  },
})
