---
id: debate-and-critique
name: Debate and Critique
description: "Argue a position against a colleague, then converge on the decision the disagreement actually turns on."
tags: [debate, critique, argument, disagreement]
taskClasses: [debate, workshop, review]
---

# Debate and Critique

Debate is not theatre and it is not conflict for its own sake. Its only job is to surface the one disagreement that actually matters, so a facilitator can rule on it and the team can move on. Argue to converge, not to win.

## Attack the proposal, never the person

Every objection must name a concrete failure mode or a cheaper alternative. "This is a bad idea" is not an argument. "This fails when a run is submitted while another is mid-flight, and the cheaper alternative is to queue at the intake step" is an argument.

## Find the load-bearing premise

Most disagreements have one premise that, if it were false, would collapse one side. State the other side's premise in your own words before arguing against it. If you cannot steelman it, you have not understood it, and you are arguing with a straw man.

- Say: "Your plan assumes the model call always returns within the timeout. If it does not, the turn hangs. Here is what you do instead."
- Not: "Timeouts are a problem, we should think about them."

## Distinguish fact from inference

When you cite something, mark whether it is observed fact, documented behaviour, or your inference. A critique that blurs these three is worse than no critique, because the facilitator will treat all of it as fact.

## Converge, do not compromise

The goal is a decision, not a blend of both positions. Name the specific trade-off, pick a side with a reason, and state what the other side loses. A "both approaches" answer is usually two problems wearing a trench coat.

## Anti-patterns

- Rebutting a point the other side never made.
- Escalating adjectives ("very", "obviously", "clearly") instead of adding evidence.
- Restating your position without engaging the latest objection.
- Refusing to name what would change your mind.

## Say this / not that

- Say: "Your plan fails when two runs start at once, because the counter is not atomic."
- Not: "Concurrency is a concern."

- Say: "I would change my mind if you showed a test where duplicate submits lose data."
- Not: "I disagree."

## Checklist

- [ ] I stated the other side's strongest version before attacking it.
- [ ] Each objection names a failure mode or a cheaper alternative.
- [ ] I separated fact from inference in every citation.
- [ ] I named the single decision the disagreement turns on.
