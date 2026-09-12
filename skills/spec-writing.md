---
id: spec-writing
name: Spec Writing
description: "Write specifications that are precise enough to build against and to test against."
tags: [spec, requirements, acceptance-criteria, contracts]
taskClasses: [planning, design, architecture]
---

# Spec Writing

A specification is a promise about behaviour. It is the contract every later stage builds against, so it must be precise enough that two people reading it would build the same thing, and testable enough that a reviewer can tell whether it was met.

## Lead with the behaviour, not the shape

State what the system does from the outside first. Internal structure belongs in a design or an architecture note, not in the spec. If the first section is about classes or tables, you have started in the wrong place.

- Say: "When a run is submitted, it appears on the task board within one second."
- Not: "The store has a runs table and a subscription layer."

## Give every requirement an acceptance criterion

Each requirement gets at least one acceptance criterion in the form: given X, when Y, then Z. If you cannot phrase a requirement this way, it is either a wish or a design detail, not a requirement. Cut it or rewrite it.

## Cover the states nobody wants to talk about

Specify loading, empty, error, and partial-failure behaviour explicitly. These are the states users actually meet, and they are the states engineers silently guess at when the spec is silent.

## Separate requirements from preferences

Mark the difference between "must" (blocks acceptance) and "should" (nice to have). If everything is a must, the spec is a wishlist and nothing can be sequenced. If nothing is a must, the spec is not a contract.

## Define the vocabulary

Every noun that carries meaning (a "run", a "turn", a "seat") gets a one-line definition on first use. Two parties using the same word for different things is the single most common source of build-time disagreement.

## Anti-patterns

- Specifications that restate the brief in longer words without adding precision.
- Acceptance criteria that say "works correctly" or "is intuitive".
- Silent unstated assumptions: "assume the network is available" must be written, not implied.
- Mixing implementation ("use React context") into the behaviour contract.

## Say this / not that

- Say: "Given an empty workspace, when the user submits a brief, then it appears on the task board."
- Not: "The system should handle submissions."

- Say: "This is a must; this is a should."
- Not: "All of these are important."

## Checklist

- [ ] Every requirement is behaviour, phrased from the user's outside view.
- [ ] Every requirement has a given/when/then acceptance criterion.
- [ ] Loading, empty, error and partial states are covered.
- [ ] Must vs should is marked.
- [ ] Load-bearing nouns are defined.
