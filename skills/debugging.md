---
id: debugging
name: Debugging
description: "Find the root cause of a failure by reproducing it, narrowing it, and confirming the fix."
tags: [debugging, root-cause, reproduction, hypothesis]
taskClasses: [coding, review]
---

# Debugging

Debugging is the discipline of replacing a guess with a reproduction. Never change code before you can reproduce the failure, and never claim a fix before you can show the failure is gone for the reason you think it is.

## Reproduce first, always

State the exact steps that trigger the failure and confirm they do. If you cannot reproduce it, you are not debugging, you are guessing. A non-reproducible bug is a different problem: instrument it, do not "fix" it blind.

## Form one hypothesis at a time

Narrow the problem by changing one variable and observing. Run the smallest input that still fails, then bisect. A scattergun of simultaneous changes makes it impossible to know which change mattered.

## Find the root cause, not the symptom

Ask "why" until you reach the thing you can actually change. "The value is null" is a symptom; "the query returns no row, so the mapping dereferences undefined" is closer to the cause. Fix the cause, and state what about it was wrong.

## Confirm the fix, and confirm it was the fix

After the change, reproduce the original steps and show the failure is gone. Then, if you can, revert the change and show the failure returns - this proves the change, not coincidence, removed it.

## Anti-patterns

- Adding a `console.log` and declaring victory without understanding the output.
- "Fixed by restarting" as an answer without finding why a restart mattered.
- Changing several things at once and claiming one of them did it.
- Patching the symptom (null-checking) without finding why the value was null.

## Say this / not that

- Say: "The value is null because the query returned no row for an empty workspace."
- Not: "The value is null."

- Say: "I reverted the fix and the failure returned, confirming the change removed it."
- Not: "I changed some things and it works now."

## Checklist

- [ ] I reproduced the failure and can state the exact steps.
- [ ] I narrowed with one variable at a time.
- [ ] I named the root cause, not the symptom.
- [ ] I confirmed the fix, and that it was the fix.
