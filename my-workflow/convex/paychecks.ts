import { query } from './_generated/server'
import { v } from 'convex/values'

/**
 * Returns up to 100 paychecks. Kept for backward compatibility with
 * any caller that previously used `paychecks:list`.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('paychecks').take(100)
  },
})

/**
 * Returns the single paycheck record for a given employeeId, or null.
 */
export const getByEmployeeId = query({
  args: { employeeId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('paychecks')
      .withIndex('by_employeeId', (q) => q.eq('employeeId', args.employeeId))
      .unique()
  },
})
