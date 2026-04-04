import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  paychecks: defineTable({
    employeeId:       v.string(),
    recipientAddress: v.string(),
    amount:           v.number(),
    interval:         v.union(v.literal('monthly'), v.literal('weekly')),
    payDate:          v.number(),   // day-of-month (1–31) for monthly, day-of-week (0–6) for weekly
    startDate:        v.number(),   // ms timestamp — employment start, anchor for earned computation
    totalPaid:        v.number(),   // cumulative USDC paid ever; never resets
  }).index('by_employeeId', ['employeeId']),

  requests: defineTable({
    employeeId:       v.string(),
    amount:           v.number(),
    recipientAddress: v.string(),
    scheduledDate:    v.number(),   // ms timestamp — when the CRE should pay
    status:           v.union(
                        v.literal('pending'),
                        v.literal('paid'),
                        v.literal('rejected'),
                      ),
    txHash:           v.optional(v.string()),
  })
    .index('by_employeeId',               ['employeeId'])
    .index('by_status',                   ['status'])
    .index('by_status_and_scheduledDate', ['status', 'scheduledDate']),
})
