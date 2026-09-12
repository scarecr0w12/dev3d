---
id: code-review
name: Code Review
description: "Critique code for correctness, clarity and operability, with specific, actionable findings."
tags: [review, critique, correctness, readability]
taskClasses: [review]
---

# Code Review

A review is not a gate to wave code through; it is the last place a defect can be caught cheaply. Review for correctness, clarity and operability, in that order. A finding without a suggested fix is a complaint, not a review.

## Read for the failure modes

Ask of every branch: what happens when this throws, when the input is empty, when the network is slow, when it runs twice? Trace the failure path, because the happy path was already tested by the author. Most defects live on the paths nobody exercised.

## Distinguish blocking from non-blocking

Mark every finding as blocking (must fix before merge) or non-blocking (suggested, at the author's discretion). A review that treats a naming nit with the same weight as a data-loss bug forces the author to triage for you. Separate them clearly.

## Be specific, not editorial

Name the exact line, the exact failure, and the concrete change. "This is confusing" is editorial; "this null check happens after the dereference, so it crashes before it can guard" is a finding.

## Review the tests as hard as the code

A test that always passes proves nothing. Check that the test would actually fail if the behaviour regressed, that it covers the failure path, and that it is not just asserting the implementation detail rather than the contract.

## Anti-patterns

- Approving because the diff is small without reading the failure paths.
- A list of style nits with no correctness findings and no priority.
- "LGTM" with no evidence of what was checked.
- Flagging something without saying what to do instead.

## Say this / not that

- Say: "This null check runs after the dereference, so it crashes before it can guard."
- Not: "This code is confusing."

- Say: "Blocking: this test would pass even if the fix were reverted."
- Not: "Consider improving the test."

## Checklist

- [ ] I traced the failure and edge-case paths, not just the happy path.
- [ ] Each finding is blocking or non-blocking.
- [ ] Each finding names the line, the failure, and the fix.
- [ ] I checked whether the tests would actually catch a regression.
