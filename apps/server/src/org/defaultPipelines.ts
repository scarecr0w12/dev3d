/**
 * The pipelines an office can run.
 *
 * A pipeline is the shape of the conversation the user's brief travels through:
 * understand it, plan it, research it, argue about it, decide, design it, build
 * it, review it, verify it, report it. Stages are declarative so the org chart
 * editor can build new ones without touching the engine.
 *
 * The engine reads `roleIds[0]` as the stage owner (the facilitator, the
 * producer, or the reviewer-in-chief) and the rest as the other side of the
 * table. `mode` decides how the turns are scheduled.
 */

import type { Pipeline, StageSpec } from '@dev3d/core';

/** The full product pipeline: a brief becomes shipped, verified work. */
export const PRODUCT_BUILD: Pipeline = {
  id: 'product-build',
  name: 'Product build',
  description:
    'Take an ambiguous product brief all the way to reviewed, tested work: plan, research, debate the approach, decide, design, build in parallel, review, verify, then report.',
  stages: [
    {
      kind: 'intake',
      name: 'Understand the brief',
      roleIds: ['ceo'],
      mode: 'single',
      produces:
        'A concrete objective: what is being built, for whom, the explicit constraints, and a definition of done. Plus a short list of tags classifying the work.',
      instruction:
        'Do not solve anything yet. Restate the request precisely, name what is ambiguous, and list the assumptions you are making. If the brief is already precise, say so briefly. End with a line "TAGS: tag1, tag2" using tags from: ui, api, data, infra, docs, refactor, research, design, performance, security.',
    },
    {
      kind: 'plan',
      name: 'Plan the workstreams',
      roleIds: ['ceo'],
      mode: 'single',
      produces:
        'A plan listing each workstream, its owner role id, what it must produce, and which stages to run or skip.',
      instruction:
        'Decide the shape of the work. Assign owners by role id from the org chart. Explicitly name any optional stage you are skipping and why. Prefer fewer, larger workstreams over many tiny ones.',
    },
    {
      kind: 'research',
      name: 'Research prior art',
      roleIds: ['researcher'],
      mode: 'single',
      optional: true,
      produces: 'An evidence brief with sources and explicit confidence levels.',
      instruction:
        'Find prior art, current best practice, and known failure modes. Cite sources with URLs. Mark every claim as [verified], [reported], or [inferred]. If you cannot reach the network, say so and answer from what you know, clearly marked.',
    },
    {
      kind: 'debate',
      name: 'Debate the approach',
      roleIds: ['design-lead', 'frontend-lead', 'backend-lead', 'cto'],
      mode: 'debate',
      rounds: 2,
      produces: 'A transcript of the argument plus the unresolved disagreements.',
      instruction:
        'Argue your position specifically. Name the concrete failure mode or user cost of the opposing approach. Concede a point explicitly when you are persuaded - do not restate your opening. Never agree just to be agreeable.',
    },
    {
      kind: 'workshop',
      name: 'Decide and specify',
      roleIds: ['ceo', 'design-lead', 'cto'],
      mode: 'debate',
      rounds: 1,
      produces: 'A decision record: what we are doing, what we rejected, and the design spec.',
      instruction:
        'Converge. Produce a decision record with: Decision, Alternatives rejected and why, Interfaces, Out of scope. Then write the design spec: the flows and the states, including empty, loading and error.',
    },
    {
      kind: 'architect',
      name: 'Technical plan',
      roleIds: ['cto'],
      mode: 'single',
      produces: 'Concrete file-level plan: paths to create or change, their interfaces, and how to verify.',
      instruction:
        'Produce a build plan a developer can execute without asking questions. List exact file paths, the exported signature of each, and the command that verifies it. Call out anything you are deferring.',
    },
    {
      kind: 'build',
      name: 'Build',
      roleIds: ['frontend-dev-1', 'frontend-dev-2', 'backend-dev-1', 'backend-dev-2'],
      mode: 'parallel',
      produces: 'Working files in the workspace, plus a note of what each employee changed and how they verified it.',
      instruction:
        'Implement your slice against the technical plan. Use the workspace tools: read before you write, then write real files. Do not invent APIs that the plan did not specify - if the plan is wrong, implement the smallest correct thing and say what you changed. Finish with what you wrote, the path of each file, and the exact command you ran to check it.',
    },
    {
      kind: 'review',
      name: 'Review',
      roleIds: ['backend-lead', 'frontend-lead', 'qa-lead'],
      mode: 'review-loop',
      maxIterations: 2,
      produces: 'Review verdicts with concrete, actionable objections or an explicit approval.',
      instruction:
        'Read the actual files that were produced. Object to specifics with file paths and line-level reasoning. Approve explicitly when it is genuinely good enough - do not manufacture objections.',
    },
    {
      kind: 'test',
      name: 'Verify',
      roleIds: ['qa-lead'],
      mode: 'single',
      produces: 'A test report: what was run, what passed, what failed, and what remains unverified.',
      instruction:
        'Derive tests from the objective, not from the implementation. Run what you can with run_shell. Report exact commands and exact output. Explicitly separate "verified" from "not verified".',
    },
    {
      kind: 'report',
      name: 'Report to the user',
      roleIds: ['ceo'],
      mode: 'single',
      produces: 'The final answer to the user.',
      instruction:
        'Write the answer the user actually needs: what was done, what was decided and why, what works, what is untested, and what you deliberately left out. Lead with the outcome. Do not pad. If something failed, say so plainly in the first paragraph.',
    },
  ],
};

/** A focused change to an existing codebase. */
export const CODE_CHANGE: Pipeline = {
  id: 'code-change',
  name: 'Code change',
  description:
    'A tighter pipeline for a concrete change: understand, plan, architect, build, review, verify, report.',
  stages: [
    {
      kind: 'intake',
      name: 'Understand the change',
      roleIds: ['ceo'],
      mode: 'single',
      produces: 'The objective, the constraints, and the definition of done.',
      instruction:
        'Restate the change precisely and name the acceptance criteria. End with a line "TAGS: ..." using tags from: ui, api, data, infra, docs, refactor, research, design, performance, security.',
    },
    {
      kind: 'plan',
      name: 'Plan',
      roleIds: ['cto'],
      mode: 'single',
      produces: 'Workstreams with owners and the files each will touch.',
      instruction:
        'Keep this tight. Name the files, the owners, and the order. Skip ceremony that does not reduce risk here.',
    },
    {
      kind: 'architect',
      name: 'Technical plan',
      roleIds: ['cto'],
      mode: 'single',
      produces: 'File-level plan with interfaces and a verification command.',
      instruction:
        'Give exact paths and signatures. Name the single command that proves the change works.',
    },
    {
      kind: 'build',
      name: 'Build',
      roleIds: ['backend-dev-1', 'frontend-dev-1'],
      mode: 'parallel',
      produces: 'The change, written to the workspace, with per-employee verification notes.',
      instruction:
        'Read the relevant files first, then make the smallest correct change. Report each file you touched and the command you ran to check it.',
    },
    {
      kind: 'review',
      name: 'Review',
      roleIds: ['backend-lead', 'qa-lead'],
      mode: 'review-loop',
      maxIterations: 2,
      produces: 'Review verdicts: objections with paths, or explicit approval.',
      instruction:
        'Read the diffs. Object only to real problems, with paths. Approve explicitly when good enough.',
    },
    {
      kind: 'test',
      name: 'Verify',
      roleIds: ['qa-lead'],
      mode: 'single',
      produces: 'Test report with exact commands and results.',
      instruction:
        'Run the verification command. Report exact output. Separate verified from unverified.',
    },
    {
      kind: 'report',
      name: 'Report',
      roleIds: ['ceo'],
      mode: 'single',
      produces: 'The final answer to the user.',
      instruction:
        'Lead with the outcome. State what changed, what was verified, and what was not. Be brief.',
    },
  ],
};

/** Ask the office a question rather than commissioning work. */
export const QUICK_ANSWER: Pipeline = {
  id: 'quick-answer',
  name: 'Quick answer',
  description:
    'A question, not a project: understand it, research it, answer it. Cheap, fast, no build stages.',
  stages: [
    {
      kind: 'intake',
      name: 'Understand the question',
      roleIds: ['ceo'],
      mode: 'single',
      produces: 'The real question behind the question, plus the constraints on a good answer.',
      instruction:
        'Work out what is actually being asked. Note anything the answer must not assume. End with a line "TAGS: ..." using tags from: ui, api, data, infra, docs, refactor, research, design, performance, security.',
    },
    {
      kind: 'research',
      name: 'Research',
      roleIds: ['researcher'],
      mode: 'single',
      produces: 'Evidence with sources and confidence levels.',
      instruction:
        'Gather evidence. Cite sources. Mark each claim [verified], [reported], or [inferred].',
    },
    {
      kind: 'report',
      name: 'Answer',
      roleIds: ['ceo'],
      mode: 'single',
      produces: 'The answer.',
      instruction:
        'Answer directly in the first sentence, then justify. Attribute your sources. Name what you are unsure about.',
    },
  ],
};

export function defaultPipelines(): Pipeline[] {
  return [PRODUCT_BUILD, CODE_CHANGE, QUICK_ANSWER];
}

export function findPipeline(pipelines: Pipeline[], id: string): Pipeline | undefined {
  return pipelines.find((p) => p.id === id);
}

/** The stages of a pipeline that actually run, given the brief's tags. */
export function resolveStages(pipeline: Pipeline, tags: string[]): StageSpec[] {
  return pipeline.stages.filter((stage) => {
    if (!stage.whenTags || stage.whenTags.length === 0) return true;
    return stage.whenTags.some((t) => tags.includes(t));
  });
}
