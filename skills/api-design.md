---
id: api-design
name: API Design
description: "Design APIs as explicit, versioned contracts with clear error and retry semantics."
tags: [api, contract, endpoints, errors, idempotency]
taskClasses: [architecture, coding]
---

# API Design

An API is a promise to every caller, present and future. Design it as a contract first and a set of endpoints second. A vague API becomes a vague implementation and a cascade of breaking changes.

## Define the contract before the endpoints

Write the request shape, the response shape, and the error shape before you write the route. Every field gets a type and a meaning. Ambiguity in the contract is a bug that will be discovered by the first caller who guesses differently from the implementer.

## Make errors machine-readable and actionable

Errors carry a stable code, a human message, and enough context to act on. A bare `500` teaches the caller nothing. A structured error with `code: "run_not_found"` lets the caller decide whether to retry, back off, or surface it to a human.

## Define idempotency and retry semantics

State explicitly whether an endpoint is idempotent and what happens on retry. "Safe to retry" is a property you must guarantee, not assume. Non-idempotent mutations need an idempotency key, and that key needs to be part of the contract.

## Version deliberately, and say what changes

Breaking changes get a new version or an explicit migration, never a silent shift in meaning. Document the compatibility window. A field that stops meaning what it used to mean is worse than a breaking change, because it fails quietly.

## Anti-patterns

- Naming things by their implementation ("getFromCache") instead of their intent ("resolveRun").
- Returning different shapes on success and error paths so callers cannot parse uniformly.
- Using strings where enums belong, then discovering "unknown" values at runtime.
- Adding a field without deciding whether it is required, optional, or deprecated.

## Say this / not that

- Say: "On a missing run, return 404 with code run_not_found."
- Not: "Return an error."

- Say: "This mutation is idempotent; safe to retry."
- Not: "Retries are fine."

## Checklist

- [ ] Request, response and error shapes are written before the route.
- [ ] Errors carry a stable code plus a human message.
- [ ] Idempotency and retry behaviour are stated for every mutation.
- [ ] Breaking changes are versioned or migrated explicitly.
