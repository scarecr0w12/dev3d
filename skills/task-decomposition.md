---
id: task-decomposition
name: Task Decomposition
description: "Break an ambiguous objective into a set of independent, verifiable workstreams."
tags: [planning, workstreams, dependencies, ownership]
taskClasses: [planning, intake, routing]
---

# Task Decomposition

You are decomposing one objective into workstreams. The quality of the whole run is set here: a vague decomposition produces parallel employees stepping on each other, and a missing dependency produces a silent integration failure at the end.

## First, name the definition of done

Before you split anything, write down what "done" means in terms the user can verify. A definition of done is a sentence about observable behaviour, not about effort. If you cannot write it, you do not understand the objective yet, and you should ask a clarifying question instead of decomposing.

- Say: "Done means the user can paste a brief and receive a spec with three acceptance criteria."
- Not: "Done means we did the planning."

## Split by what changes independently

A good workstream is one where the owner can make progress without blocking on another owner. Split along seams that already exist: frontend vs backend, research vs implementation, build vs verify. If two workstreams must constantly coordinate, they are one workstream that is too big.

## Cap parallel work

More parallel work is not automatically faster. Every parallel stream adds an integration step and a merge conflict risk. Decompose into the smallest number of streams that still allows the critical path to proceed, then note which stream is on the critical path.

## Write dependencies explicitly

For each workstream, list what it produces and what it consumes. "Produces the API contract; consumed by frontend" is a dependency edge you must record. A dependency you cannot name is a dependency that will be discovered mid-build as a blockage.

## Assign owners, not just workstreams

Each workstream needs exactly one owner. If a workstream has no owner, it will not happen. If it has two, they will each assume the other is doing it.

## Anti-patterns

- Decomposing by noun ("the database", "the UI") instead of by outcome ("persist and serve search", "render results and empty states").
- Producing a flat list with no dependencies, then calling it a plan.
- Deferring the hard decision (the interface, the contract) to a later stage and pretending the split is clean.
- Inventing parallel streams to look thorough when one sequential stream is actually faster.

## Say this / not that

- Say: "Stream A produces the API contract; Stream B consumes it, so A must land first."
- Not: "Some parts depend on other parts."

- Say: "This stream has one owner: the backend lead."
- Not: "Everyone is responsible for this."

## Checklist

- [ ] Definition of done is written and verifiable.
- [ ] Every workstream has a single named owner.
- [ ] Every cross-stream dependency is named as produces/consumes.
- [ ] The critical path is identified.
- [ ] Each workstream ends in a concrete artifact, not an activity.
