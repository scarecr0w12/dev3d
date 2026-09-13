/**
 * Shared display vocabulary for the console.
 *
 * These tables existed as two or three copies and had already drifted, which is
 * the failure mode that makes duplication worth removing rather than merely
 * tidying:
 *
 *  - `POSTURE_HINT` was defined twice with **different wording for the same
 *    setting** — "the cheapest model that can do the job" in the status popout and
 *    "the cheapest model that satisfies the turn" in Telemetry. An operator
 *    reading both was told two different things about one control.
 *  - `KIND_HINT` for approvals differed on exactly one entry (`risk`: "the
 *    employee flagged its own action as risky" versus "flagged its own action as
 *    risky").
 *  - `statusTone` existed three times and **the transcript's copy had no
 *    `cancelled` case**, so a cancelled run fell through to `default`. That
 *    happened to be right by luck; the next status added would not be.
 *  - `TIERS` was written out twice instead of importing `MODEL_TIER_ORDER`, which
 *    is the canonical order and lives in `@dev3d/core` precisely so it can be the
 *    single source.
 *
 * One module means one answer. Where the copies disagreed, the more complete
 * wording won and the fact that it is now shared is the thing that stops them
 * drifting apart again.
 */

import {
  MODEL_TIER_ORDER,
  type AgentPlanStepStatus,
  type ModelSpec,
  type ModelTier,
  type ProviderStatus,
  type RouteDecision,
  type RoutingPosture,
} from '@dev3d/core';

/**
 * The tone vocabulary, declared here rather than imported from `console/ui`.
 *
 * `ui.tsx` is the only other definition, and importing it would drag a component
 * module into a file of plain tables — which also makes this module unimportable
 * by the verification harness, since that compiles without JSX. Declaring the four
 * strings costs nothing and keeps this file free of components.
 */
export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'accent';

/**
 * The tier ladder, in order.
 *
 * Re-exported rather than re-declared: `MODEL_TIER_ORDER` is the canonical order
 * and the router ranks on it, so a second copy in the console is a copy that can
 * be wrong.
 */
export const TIERS: readonly ModelTier[] = MODEL_TIER_ORDER;

/** How each routing posture is described to the operator. */
export const POSTURE_HINT: Record<RoutingPosture, string> = {
  cheap: 'always take the cheapest model that can do the job',
  balanced: 'honour each role\u2019s policy, escalate only when the work is hard',
  quality: 'bias every turn one tier up',
};

/**
 * The tone a run or stage status is shown in.
 *
 * `cancelled` and `queued` are both deliberately neutral: the first is an
 * operator's own decision and not a fault, and the second is simply not started.
 * `awaiting-approval` is a warning because it stops the office until a human acts.
 */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'running':
      return 'info';
    case 'done':
      return 'ok';
    case 'awaiting-approval':
    case 'paused':
      return 'warn';
    case 'failed':
      return 'danger';
    case 'cancelled':
    case 'queued':
    case 'pending':
    case 'skipped':
    default:
      return 'neutral';
  }
}

/**
 * Where a model's quality number came from, named rather than left to a colour.
 *
 * The state frame carries `quality.sources` and not `quality.opinions`, because
 * the opinion array is 87 kB of a 455-model catalog and this label is the only
 * thing the console ever derived from it. The fallback to `opinions` is for the
 * full catalog served by `GET /api/models` — a caller that has the detail should
 * get the same label out of it rather than a different one, which is exactly the
 * kind of drift this module exists to prevent.
 */
export function modelProvenance(model: ModelSpec): string {
  const quality = model.quality;
  if (quality === undefined) return 'unrated';
  const sources =
    quality.sources ?? [...new Set((quality.opinions ?? []).map((opinion) => opinion.source))];
  if (sources.length === 0) return 'unrated';
  return sources.join(' + ');
}

export interface ProviderSourceCopy {
  label: string;
  tone: Tone;
  hint: string;
}

/**
 * How a provider's model list was obtained, and how alarming that is.
 *
 * The distinction this exists for: a **local** runtime that is not running is the
 * ordinary state of an install — Ollama is off, LM Studio is closed — while a
 * *remote* provider that cannot be reached is a fault worth investigating. The
 * registry has always reported `local` and the state frame used to drop it, so both
 * rendered as a red "unreachable" and the operator was sent to look at nothing.
 *
 * It lives here rather than in the settings JSX for the usual reason: a rule about
 * how something reads belongs where a test can read it back.
 */
export function providerSourceCopy(provider: Pick<ProviderStatus, 'modelSource' | 'local' | 'modelSourceDetail'>): ProviderSourceCopy {
  switch (provider.modelSource) {
    case 'discovered':
      return {
        label: 'listed',
        tone: 'ok',
        hint: provider.modelSourceDetail ?? 'Reported by the provider itself.',
      };
    case 'degraded':
      return provider.local
        ? {
            label: 'not running (local)',
            tone: 'warn',
            hint:
              provider.modelSourceDetail ??
              'A local runtime that is not started: the curated catalog is standing in until it is.',
          }
        : {
            label: 'unreachable',
            tone: 'danger',
            hint: provider.modelSourceDetail ?? 'The provider did not answer; the curated catalog is standing in.',
          };
    default:
      return {
        label: 'catalog',
        tone: 'neutral',
        hint: provider.modelSourceDetail ?? 'Never asked: the curated catalog is in use.',
      };
  }
}

export interface ServeCopy {
  /** True when a fallback answered, i.e. the model that ran is not the one chosen. */
  fellBack: boolean;
  /** The model that actually produced this turn. */
  modelId: string;
  /** Routes tried and failed first, in order. */
  attempted: string[];
  /** One line explaining the difference, or null when there is nothing to explain. */
  note: string | null;
}

/**
 * Which model actually answered this turn, as opposed to which one was chosen.
 *
 * `TurnRecord.servedBy` and `attemptedRoutes` are recorded by the engine with a doc
 * comment saying why — "the console should be able to say a turn ran on a fallback,
 * and anything learning from outcomes would otherwise credit the chosen model for
 * work a different one did" — and the console read neither. It showed
 * `route.modelId`, the model the *router picked*, which is simply the wrong name
 * whenever a provider failed and a fallback answered.
 *
 * The rule is here rather than in the transcript's JSX so a test can read it back:
 * a turn is a fallback when something else served it, which is not the same as
 * "a fallback list exists" — every turn carries one of those.
 */
export function routeServeCopy(turn: {
  route: Pick<RouteDecision, 'modelId' | 'providerId'>;
  servedBy?: { providerId: string; modelId: string } | undefined;
  attemptedRoutes?: string[] | undefined;
}): ServeCopy {
  const attempted = turn.attemptedRoutes ?? [];
  const served = turn.servedBy;
  const modelId = served?.modelId ?? turn.route.modelId;
  const fellBack = served !== undefined && served.modelId !== turn.route.modelId;
  if (!fellBack) return { fellBack: false, modelId, attempted, note: null };

  const tried = attempted.length > 0 ? ` after ${attempted.join(', ')} did not answer` : ' after the first choice did not answer';
  return {
    fellBack: true,
    modelId,
    attempted,
    note: `${turn.route.modelId} was chosen, but ${modelId} served it${tried}.`,
  };
}

/** The mark in front of one step of a run's working plan. */
export function planStepMark(status: AgentPlanStepStatus): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '▸';
    default:
      return '·';
  }
}

/** `2 of 5 done`, for the plan's summary line. */
export function planProgress(plan: readonly { status: AgentPlanStepStatus }[]): string {
  const done = plan.filter((step) => step.status === 'completed').length;
  return `${done} of ${plan.length} done`;
}
