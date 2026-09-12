---
id: frontend-implementation
name: Frontend Implementation
description: "Implement client work cleanly: predictable state, explicit loading and error paths, small diffs."
tags: [frontend, react, state, rendering, ui]
taskClasses: [coding]
---

# Frontend Implementation

Frontend code is judged by what the user sees when it fails, not when it works. Write components whose state is predictable, whose loading and error paths are explicit, and whose diffs are smaller than the problem you were handed.

## Decide where state lives before you write it

For each piece of state, name its owner and its lifetime: local to the component, lifted to a parent, or server state. State that has two owners will eventually disagree. Server state belongs in a query/cache layer, not hand-rolled into a component.

## Handle loading, empty, error and partial data

Every data fetch has four outcomes, and the UI must render all four. A component that only renders success is incomplete. Handle them explicitly and give each a distinct, honest treatment - never a silent blank screen.

## Make rendering pure and predictable

A component that renders different output for the same props is a source of bugs that only appear in production. Derive what you can, avoid effects for things that can be computed during render, and keep side effects at the edges.

## Keep diffs small and reviewable

Small diffs are easier to review, easier to revert, and easier to reason about. Refuse to bundle an unrelated cleanup into a feature change. If the diff is large, split it into logical commits.

## Anti-patterns

- Using `useEffect` to synchronise state that could be derived during render.
- A loading flag plus a data field that can be simultaneously "loading" and "loaded".
- Catching an error and swallowing it so the user sees a blank screen.
- Returning `null` for the empty state with no explanation.

## Say this / not that

- Say: "This state lives in the parent; the child receives it as a prop."
- Not: "I'll store it in a context."

- Say: "When the fetch fails, show the error and a retry button."
- Not: "Leave the screen blank on error."

## Checklist

- [ ] Every piece of state has one named owner and lifetime.
- [ ] Loading, empty, error and partial-data paths all render.
- [ ] Components are pure and predictable for fixed props.
- [ ] The diff is small, logical, and free of unrelated changes.
