---
id: release-engineering
name: Release Engineering
description: "Make it build, run and be diagnosable by someone who did not write it, and ship reversibly."
tags: [release, build, deploy, operability, ci]
taskClasses: [ops]
---

# Release Engineering

Release engineering makes the system build, run, and be diagnosable by someone who did not write it. A release is a reversible step, not a leap of faith. Boring reliability is the goal.

## Make the build reproducible

A build that works on your machine but not on a clean checkout is not a build, it is an accident. Pin the toolchain, document the exact commands, and verify the build from a clean state. The version-control history is part of the release artifact.

## Ship reversibly

Every deploy needs a rollback path that you have actually rehearsed, not one you believe exists. Deploy in a way that lets you return to the previous version in one step. If the rollback is theoretical, the release is a gamble.

## Make failures legible

Logs, health checks and error surfaces are part of the feature, not an afterthought. When it breaks, the person on call should be able to answer "what failed, where, and with what input" from the output alone. Structured logs beat prose.

## Automate the boring parts

Anything you do twice by hand should be a script: build, test, deploy, rollback. Hand-run steps drift, get skipped under pressure, and are impossible to reproduce after the fact. The script is the documentation.

## Anti-patterns

- "Works on my machine" as a release criterion.
- Deploying with no rehearsed rollback.
- A release with no record of what version, what commit, and what changed.
- Config that lives outside version control and is edited by hand in production.

## Say this / not that

- Say: "Rollback is one step: redeploy the previous tag; I rehearsed it."
- Not: "We can roll back if needed."

- Say: "The build is reproducible from a clean checkout with the pinned toolchain."
- Not: "It works on my machine."

## Checklist

- [ ] The build is reproducible from a clean checkout with a pinned toolchain.
- [ ] A rehearsed, one-step rollback exists.
- [ ] Failures are legible from logs and health checks alone.
- [ ] Build, test, deploy and rollback are scripted and versioned.
