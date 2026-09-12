---
id: backend-implementation
name: Backend Implementation
description: "Implement server work to the agreed contract, correct under concurrency, retries and partial failure."
tags: [backend, server, data, concurrency, transactions]
taskClasses: [coding]
---

# Backend Implementation

Backend code is judged by what it guarantees under concurrency, retries, and partial failure. Implement against the contract you were given, and do not quietly redefine it. The things that fail at 3am are the things you did not think about at 2pm.

## Implement the contract, do not reinterpret it

The API contract and data model were decided before you started. If they are wrong, surface the change as a contract amendment, not as a silent deviation in your code. A silent deviation is how the frontend and backend end up disagreeing about what a field means.

## Think about what happens twice

Every mutation must answer: what if this runs twice? Make it idempotent or make the non-idempotency explicit and guarded. Duplicate requests are not a rare edge case; they are the default behaviour of any network with retries.

## Make partial failure explicit

When an operation writes to two places, decide what happens when the second write fails. Use a transaction where you need atomicity, and an explicit, observable reconciliation where you cannot. "It probably works" is not a guarantee; write down the guarantee and honour it.

## Make failure legible

Log enough to reconstruct a failure after the fact: what was attempted, with what input, and what failed. Structured logs beat prose. The person debugging your code at 3am should not have to guess what happened.

## Anti-patterns

- Catching an error and returning a generic 500 with no context.
- Assuming single-threaded execution when the runtime is concurrent.
- A "transaction" that actually spans multiple independent writes.
- Silently changing a field's meaning instead of amending the contract.

## Say this / not that

- Say: "If the second write fails, the job is retried and the first write is idempotent."
- Not: "Partial failure is unlikely."

- Say: "Log the input, the attempt, and the error."
- Not: "Log the error."

## Checklist

- [ ] The implementation matches the contract without quiet deviations.
- [ ] Every mutation is idempotent or explicitly guarded against duplicates.
- [ ] Multi-write operations state their atomicity or reconciliation.
- [ ] Failures are logged with enough context to reconstruct them.
