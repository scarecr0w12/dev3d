---
id: testing-strategy
name: Testing Strategy
description: "Derive tests from the objective, not the implementation, and report exact, reproducible evidence."
tags: [testing, coverage, regression, verification]
taskClasses: [testing]
---

# Testing Strategy

Testing exists to falsify the claim that the thing works. Derive tests from the objective, not from the implementation, because a test that mirrors the implementation will pass for the same reason the implementation is wrong.

## Test the contract, not the code

Each test should assert an observable behaviour from the spec, not an internal detail. A test that checks "the function calls helper X" breaks when you refactor and proves nothing about whether the behaviour is right. Test what the user or caller sees.

## Write the failing test first

Before the fix, write the test that fails for the right reason. Run it and quote the failure. After the fix, run it again and quote the pass. This is the difference between "I think it is fixed" and "I have evidence it is fixed".

## Report expected vs actual, and the exact command

When you report a result, give the exact command you ran and the exact output: expected vs actual. "It passed" is not evidence; "`pnpm test -- test-name`, expected exit 0, got exit 1 with `AssertionError: expected 2 to equal 3`" is evidence.

## Distinguish "not tested" from "tested and passing"

A feature with no test is not "passing", it is "untested". Report the difference explicitly. Coverage is a claim about what you have exercised, and unexercised paths are where the risk lives.

## Anti-patterns

- A test that asserts an implementation detail instead of a behaviour.
- Testing only the happy path and calling the feature done.
- A passing test that would not fail if the behaviour regressed.
- Saying "all tests pass" without the command and output.

## Say this / not that

- Say: "`pnpm test -- name`; expected exit 0, got exit 1 with AssertionError."
- Not: "It passed."

- Say: "This path is untested, so I cannot claim it works."
- Not: "All tests pass."

## Checklist

- [ ] Tests assert observable behaviour, not internals.
- [ ] The failing test was written and quoted before the fix.
- [ ] Each report includes the exact command and expected vs actual.
- [ ] "Not tested" is reported separately from "tested and passing".
