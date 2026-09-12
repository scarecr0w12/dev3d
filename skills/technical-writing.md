---
id: technical-writing
name: Technical Writing
description: "Write clear, specific technical prose that a busy reader can act on without re-reading."
tags: [writing, documentation, clarity, reports]
taskClasses: [summarize, planning]
---

# Technical Writing

Technical writing exists to be acted on, not admired. A reader should be able to extract the decision, the reasoning and the next action without re-reading. Clarity is a feature; it is what you leave behind when the meeting ends.

## Put the conclusion first

Lead with the answer, the decision or the status, then the reasoning. A report that buries the outcome at the bottom forces every reader to reverse-engineer it. State what happened, what you decided, and what happens next in the first three lines.

## Write in the active voice and name the actor

"Who does what" must be explicit. "The run engine persists the outcome" beats "the outcome is persisted". Passive voice hides the actor, and hidden actors are where accountability and bugs go to hide.

## Cut adjectives and keep numbers

Replace "very", "robust", "fast" and "scalable" with measurements or concrete behaviour. "The query returns in under 200ms for 10k rows" is writing; "the query is fast" is marketing. If you cannot attach a number or a specific behaviour, delete the word.

## Define terms and be consistent

Use one word for one thing, throughout. If a "run" is sometimes a "task" and sometimes a "job", the reader cannot follow. Define load-bearing terms on first use and never rename them mid-document.

## Anti-patterns

- Burying the conclusion under a mountain of context.
- Passive voice that hides who is responsible.
- Hedging ("arguably", "potentially", "somewhat") where a claim is needed.
- A wall of prose where a list or a table would be clearer.

## Say this / not that

- Say: "The run engine persists the outcome before marking the run done."
- Not: "The outcome is persisted."

- Say: "The query returns in under 200ms for 10k rows."
- Not: "The query is fast."

## Checklist

- [ ] The conclusion or decision appears in the first three lines.
- [ ] Every sentence names its actor.
- [ ] Adjectives are replaced with numbers or removed.
- [ ] Terms are used consistently and defined on first use.
