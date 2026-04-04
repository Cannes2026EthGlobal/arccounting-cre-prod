import { mutation } from './_generated/server'
import { v } from 'convex/values'

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000
const ONE_WEEK_MS  =  7 * 24 * 60 * 60 * 1000

// Valid checksummed addresses (Hardhat/Anvil dev accounts #1 and #2)
const ALICE_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const BOB_ADDR   = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'

/**
 * Inserts dummy paychecks + requests for simulation against ARC testnet.
 * Safe to call multiple times — clears existing seed data first.
 * Payroll contract holds ~3 USDC (native token), so amounts are kept small.
 *
 * Employees:
 *   alice  — monthly $2, started 3 months ago (earned $6, can borrow up to $8 total)
 *   bob    — weekly  $1, started 4 weeks ago  (earned $4, can borrow up to $5 total)
 *
 * Requests seeded:
 *   #1 alice  $0.50 — due now   → paid   (0+0.5 ≤ 8)
 *   #2 alice  $0.75 — due now   → paid   (0.5+0.75=1.25 ≤ 8)
 *   #3 alice  $7.00 — due now   → BLOCKED (1.25+7=8.25 > 8)
 *   #4 bob    $0.50 — due now   → paid   (0+0.5 ≤ 5)
 *   #5 bob    $0.50 — future    → not due yet
 */
export const seedDummyData = mutation({
  args: {},
  handler: async (ctx) => {
    // Clear existing seed data
    const existingPaychecks = await ctx.db.query('paychecks').take(100)
    for (const p of existingPaychecks) await ctx.db.delete(p._id)

    const existingRequests = await ctx.db.query('requests').take(100)
    for (const r of existingRequests) await ctx.db.delete(r._id)

    const now = Date.now()

    // --- Alice: monthly $2, started 3 months ago, payDate = 1st of month
    const aliceId = await ctx.db.insert('paychecks', {
      employeeId:       'alice',
      recipientAddress: ALICE_ADDR,
      amount:           2,
      interval:         'monthly',
      payDate:          1,
      startDate:        now - 3 * ONE_MONTH_MS,
      totalPaid:        0,
    })

    // --- Bob: weekly $1, started 4 weeks ago, payDate = Monday (1)
    const bobId = await ctx.db.insert('paychecks', {
      employeeId:       'bob',
      recipientAddress: BOB_ADDR,
      amount:           1,
      interval:         'weekly',
      payDate:          1,
      startDate:        now - 4 * ONE_WEEK_MS,
      totalPaid:        0,
    })

    // Alice requests
    await ctx.db.insert('requests', {
      employeeId:       'alice',
      amount:           0.5,
      recipientAddress: ALICE_ADDR,
      scheduledDate:    now - 60_000,
      status:           'pending',
    })
    await ctx.db.insert('requests', {
      employeeId:       'alice',
      amount:           0.75,
      recipientAddress: ALICE_ADDR,
      scheduledDate:    now - 30_000,
      status:           'pending',
    })
    await ctx.db.insert('requests', {
      employeeId:       'alice',
      amount:           7,
      recipientAddress: ALICE_ADDR,
      scheduledDate:    now - 10_000,   // due, but blocked by credit limit
      status:           'pending',
    })

    // Bob requests
    await ctx.db.insert('requests', {
      employeeId:       'bob',
      amount:           0.5,
      recipientAddress: BOB_ADDR,
      scheduledDate:    now - 60_000,
      status:           'pending',
    })
    await ctx.db.insert('requests', {
      employeeId:       'bob',
      amount:           0.5,
      recipientAddress: BOB_ADDR,
      scheduledDate:    now + ONE_WEEK_MS,  // future — not due
      status:           'pending',
    })

    return {
      message: 'Seed complete',
      paychecks: { alice: aliceId, bob: bobId },
      requestsInserted: 5,
    }
  },
})
