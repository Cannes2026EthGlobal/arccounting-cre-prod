# Compensation Splits

Employee-controlled payout routing that lets employees split each compensation line across multiple wallet addresses.

## Overview

The company sets compensation lines (what an employee earns). The employee decides how to split each line across wallet addresses. If no splits are configured, 100% goes to the employee's primary `walletAddress` on the `employees` record.

Splits do NOT change compensation totals or Credit calculations.

## Database

### Table: `compensationSplits`

| Field | Type | Description |
|-------|------|-------------|
| `compensationLineId` | `Id<"compensationLines">` | The compensation line being split |
| `employeeId` | `Id<"employees">` | Denormalized for fast employee-scoped lookups |
| `walletAddress` | `string` | Destination wallet address |
| `amountCents` | `number` | Absolute amount in cents (NOT a percentage) |
| `label` | `string?` | Optional label, e.g., "Main", "Savings", "Spouse" |

**Indexes:**
- `by_compensationLineId` — find all splits for a specific compensation line
- `by_employeeId` — find all splits for an employee across all their lines

### Invariant

For any compensation line that has splits:

```
SUM(splits.amountCents) === compensationLine.amountCents
```

This is enforced by the `setSplits` mutation. A line with zero split rows means "pay everything to the employee's primary wallet."

### Fields added to `employeePayments`

| Field | Type | Description |
|-------|------|-------------|
| `compensationSplitId` | `Id<"compensationSplits">?` | Which split this payment corresponds to |
| `walletAddress` | `string?` | Destination address for this specific payment |

These are optional. Existing payments without them continue to work. When creating payments for a split line, each split produces its own `employeePayment` row with these fields populated.

## Data relationships

```
employees (1)
  └── compensationLines (N)
        └── compensationSplits (M)
              └── employeePayments.compensationSplitId (optional backref)
```

## Convex functions

### File: `convex/compensationSplits.ts`

**Queries:**

| Function | Args | Returns | Description |
|----------|------|---------|-------------|
| `listByCompensationLine` | `{ compensationLineId }` | `CompensationSplit[]` | All splits for one line |
| `listByEmployee` | `{ employeeId }` | `CompensationSplit[]` | All splits for one employee, across all lines |

**Mutations:**

| Function | Args | Description |
|----------|------|-------------|
| `setSplits` | `{ compensationLineId, splits: [{ walletAddress, amountCents, label? }] }` | Atomic replace: deletes all existing splits for the line, inserts new ones. Validates sum equals line total, each amount > 0, each address non-empty. Empty array clears all splits. |

## Cascade behavior

| Event | Effect on splits |
|-------|-----------------|
| Compensation line `amountCents` changes | All splits for that line are **deleted** (amounts no longer valid) |
| Compensation line is deleted | All splits for that line are **deleted** |
| Employee is removed | All splits for that employee are **deleted** |

## How to create payments from splits

When building payroll, for each active compensation line:

1. Query `compensationSplits.listByCompensationLine({ compensationLineId })`.
2. **If no splits exist:** create one `employeePayment` for the full `amountCents`, using the employee's primary `walletAddress`.
3. **If splits exist:** create one `employeePayment` per split row:
   - `amountCents` = split's `amountCents`
   - `walletAddress` = split's `walletAddress`
   - `compensationLineId` = the line ID
   - `compensationSplitId` = the split ID
   - `description` can include the split label, e.g., "March 2026 salary (Savings)"

All payments for a given line should share the same `batchId` so they can be tracked as a group.

## Example data

Elena Vasquez has a "Base Salary" line of $80/mo (8000 cents), split:

| label | walletAddress | amountCents |
|-------|--------------|-------------|
| Main | `0xba232D9C...` (primary) | 60 |
| Savings | `0x742d35Cc...` | 20 |

When payroll runs, this produces two `employeePayment` rows:
- $0.60 to `0xba232D9C...` (Main)
- $0.20 to `0x742d35Cc...` (Savings)

## Who controls what

| Actor | Can do |
|-------|--------|
| **Company admin** | Set compensation lines (name, amount, frequency). Changing an amount auto-clears splits. Can view splits read-only. |
| **Employee** | Configure splits via the employee portal. Choose wallet addresses and amounts per line. Reset to single wallet. |
