---
id: system-design
name: System Design
description: "Design the technical shape of the system: boundaries, interfaces, and the failure modes you refuse to accept."
tags: [architecture, boundaries, interfaces, operability]
taskClasses: [architecture]
---

# System Design

System design owns the technical shape of the product: where the boundaries are, what crosses them, and which failure modes the system is allowed to have. The deliverable is not a diagram; it is a set of decisions with reasons, plus the trade-offs you rejected.

## Name the interfaces before the implementation

The interface is the contract, and the contract is what lets two owners build in parallel. For each boundary, write the exact shape of what crosses it: the message, the fields, the failure semantics. If you cannot write the interface, the boundary is not ready.

## Decide what the system refuses to tolerate

Every system has failure modes. Design is choosing which ones you engineer against and which ones you accept. State them explicitly: "we tolerate duplicate submissions (idempotent intake) but not lost outcomes (outcome is persisted before the run is marked done)."

## Prefer the simplest thing that can be operated

A design you cannot operate, debug, or roll back is a liability even if it is elegant. Prefer boring, observable, reversible choices. The best architecture is often the one with the fewest moving parts that still meets the contract.

## Draw the data flow, not just the boxes

Static structure (components, tables) tells you what exists; data flow tells you what happens. Trace one request end to end and note where state lives, where it is duplicated, and where it can diverge. Divergence points are where bugs are born.

## Anti-patterns

- A diagram with boxes and arrows but no stated interfaces.
- Choosing a complex pattern (event sourcing, microservices) because it is fashionable, not because the contract needs it.
- Ignoring the failure modes until the post-mortem.
- Designing for a scale the product will never reach.

## Say this / not that

- Say: "The boundary passes a run-id and an outcome; on failure the caller retries."
- Not: "The services talk to each other."

- Say: "We tolerate duplicate intake but not lost outcomes."
- Not: "We handle edge cases."

## Checklist

- [ ] Every boundary has an explicit interface with failure semantics.
- [ ] Accepted vs rejected failure modes are written down.
- [ ] The data flow of one request is traced end to end.
- [ ] Each decision records the trade-off it rejected.
