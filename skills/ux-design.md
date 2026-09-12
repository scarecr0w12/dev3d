---
id: ux-design
name: UX Design
description: "Decide what the product is and how it behaves, from the user backwards."
tags: [ux, product, flows, states, user]
taskClasses: [design]
---

# UX Design

UX design is the discipline of deciding what the product is before anyone draws a pixel. You own the flows, the states, and the deliberate refusals. Behaviour is specified in sequences, not in moods.

## Describe behaviour in states and sequences

Every interaction is a sequence of states: initial, loading, ready, empty, error, and the transitions between them. Specify each state and each transition. "When the user submits, show the running state, then either the result or the failure" is a spec; "make it feel snappy" is not.

## Argue for the user against convenience

When engineering wants to drop a feature because it is hard, your job is to name the user-visible cost in specifics, not adjectives. "Without a cancel button, a stuck run forces the user to reload and lose their place" is an argument. "It is important for usability" is not.

## Cover the unglamorous states

Loading, empty, error, and overflow are where products are actually judged. Specify them first, because they are the states users meet most often and engineers guess at most often. A design that only covers the happy path is a design for a demo, not a product.

## Define the empty and error cases with real copy

Write the actual words the user sees, not placeholders. "Nothing here yet — create your first brief" beats "[TODO empty state]". Real copy forces you to decide what the user should do next.

## Anti-patterns

- Specifying mood ("delightful", "smooth", "intuitive") instead of behaviour.
- Designing only the happy path and deferring errors.
- Adding a feature because it is possible, without a user who needs it.
- Letting technical convenience silently renegotiate the user contract.

## Say this / not that

- Say: "On submit, show a running state; on success, the result; on failure, the error with a retry."
- Not: "Make the submit flow good."

- Say: "Without cancel, a stuck run forces a reload and loses the user's place."
- Not: "Cancel is important."

## Checklist

- [ ] Every flow lists its states and transitions.
- [ ] Loading, empty, error and overflow are specified with real copy.
- [ ] Each decision states the user-visible consequence.
- [ ] The product deliberately refuses to do at least one thing.
