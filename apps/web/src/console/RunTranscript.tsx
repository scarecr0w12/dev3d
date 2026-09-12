/**
 * The hierarchical run view: brief -> stages -> turns -> tool calls.
 *
 * This is where the office's actual work is readable. Stage cards carry the
 * summary that the next stage received; each turn shows who did it, which model
 * the router chose and why, what it cost, what it called, and the text it
 * produced. `turn.delta` / `turn.reasoning` frames stream into the in-flight
 * turn from `ClientOfficeStore.streaming`, and the finished `TurnRecord.text` is
 * shown once the turn closes.
 *
 * Turn bodies are memoised so a streaming delta re-renders one turn, not the
 * whole transcript, and the scroll container follows the tail only while the
 * user is already at the bottom.
 */

import { memo, useCallback, useMemo, useState } from 'react';

import type { Artifact, Run, StageRun, ToolCallRecord, TurnRecord } from '@dev3d/core';

import { formatDuration, formatInt, formatTokens, formatUsd, tierClassName, truncate } from '../app/format';
import { useAutoScroll, useNow } from '../app/hooks';
import {
  useArtifacts,
  useOffice,
  useReasoning,
  useRunTurns,
  useSelectedRun,
  useStore,
  useStreaming,
} from '../app/StoreContext';
import { Markdown, plainPreview } from './markdown';
import { Badge, Bar, Empty, Panel, ToolStatusBadge } from './ui';

const NO_ARTIFACTS: Artifact[] = [];

function statusTone(status: string): 'neutral' | 'info' | 'ok' | 'warn' | 'danger' {
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
    default:
      return 'neutral';
  }
}

export function RunTranscript() {
  const store = useStore();
  const office = useOffice();
  const run = useSelectedRun();
  const runTurns = useRunTurns(run);
  const streaming = useStreaming();
  const reasoning = useReasoning();
  const artifacts = useArtifacts();
  const now = useNow(1000);

  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const runArtifacts = run ? artifacts[run.id] ?? NO_ARTIFACTS : NO_ARTIFACTS;

  const artifactsByStage = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const artifact of runArtifacts) {
      const key = artifact.stageId ?? '';
      const list = map.get(key);
      if (list) list.push(artifact);
      else map.set(key, [artifact]);
    }
    return map;
  }, [runArtifacts]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const employee of office?.employees ?? []) map.set(employee.id, employee.displayName);
    for (const role of office?.roles ?? []) if (!map.has(role.id)) map.set(role.id, role.displayName);
    return map;
  }, [office]);

  const liveSignature = useMemo(() => {
    let total = 0;
    for (const text of Object.values(streaming)) total += text.length;
    for (const text of Object.values(reasoning)) total += text.length;
    return total;
  }, [streaming, reasoning]);

  const autoScroll = useAutoScroll(liveSignature);
  const liveTurnCount = Object.keys(streaming).length;

  const toggle = useCallback((turnId: string, next: boolean) => {
    setOverrides((current) => ({ ...current, [turnId]: next }));
  }, []);

  const isExpanded = useCallback(
    (turn: TurnRecord, stage: StageRun): boolean => {
      const override = overrides[turn.id];
      if (override !== undefined) return override;
      return turn.status === 'running' || stage.status === 'running';
    },
    [overrides],
  );

  if (!office) {
    return (
      <Panel title="Transcript" subtitle="stages, turns and tool calls">
        <Empty title="No office state" hint="The transcript fills in as soon as the orchestrator connects." />
      </Panel>
    );
  }

  if (!run) {
    return (
      <Panel title="Transcript" subtitle="stages, turns and tool calls">
        <Empty
          title="No run selected"
          hint={office.runs.length === 0 ? 'Submit a brief to open a run.' : 'Pick a run from the list to read its transcript.'}
        />
      </Panel>
    );
  }

  const active = run.status === 'running' || run.status === 'queued' || run.status === 'awaiting-approval' || run.status === 'paused';
  const spendRatio = run.budget.limitUsd > 0 ? run.budget.spentUsd / run.budget.limitUsd : 0;

  return (
    <Panel
      title={
        <span className="inline-gap">
          Transcript
          <Badge tone={statusTone(run.status)}>{run.status}</Badge>
          {liveTurnCount > 0 && <Badge tone="info" title="turns currently streaming">live</Badge>}
        </span>
      }
      subtitle={
        <span className="inline-gap">
          <span className="mono">{run.id}</span>
          <span className="dim">·</span>
          <span>{office.pipelines.find((pipeline) => pipeline.id === run.pipelineId)?.name ?? run.pipelineId}</span>
          <span className="dim">·</span>
          <span className="mono">{formatDuration((active ? now : run.endedAt ?? run.updatedAt) - run.createdAt)}</span>
          <span className="dim">·</span>
          {/* The workspace the run was confined to. Taken from the run itself, not
              from the current list, so history stays honest if the project is
              renamed or forgotten. */}
          <span className="project-tag" title={`agents were confined to ${run.workspacePath}`}>
            <span
              className="dot"
              style={{
                background:
                  office.workspaces.find((workspace) => workspace.id === run.workspaceId)?.color ?? '#64748b',
              }}
              aria-hidden="true"
            />
            <span className="mono small">{run.workspacePath}</span>
          </span>
        </span>
      }
      actions={
        <>
          {active && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => store.send({ type: 'cancel', runId: run.id })}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              // While following the live tail, offer the thing a reader wants
              // once a run gets long: fold away everything that has finished.
              if (!autoScroll.pinned) {
                autoScroll.scrollToBottom();
                return;
              }
              const next: Record<string, boolean> = {};
              for (const turn of runTurns.ordered) {
                if (turn.status !== 'running') next[turn.id] = false;
              }
              setOverrides(next);
            }}
            title="Follow the newest output, or collapse every finished turn"
          >
            {autoScroll.pinned ? 'Collapse finished' : 'Jump to live'}
          </button>
        </>
      }
      flush
    >
      <div className="transcript" ref={autoScroll.ref}>
        <RunHeader run={run} now={now} nameById={nameById} spendRatio={spendRatio} />

        {run.stages.length === 0 && (
          <Empty title="No stages yet" hint="The engine has not created the first stage for this run." />
        )}

        {run.stages.map((stage, index) => {
          const turns = stage.turnIds
            .map((turnId) => runTurns.byId[turnId])
            .filter((turn): turn is TurnRecord => turn !== undefined);
          const stageArtifacts = artifactsByStage.get(stage.id) ?? NO_ARTIFACTS;
          return (
            <StageBlock
              key={stage.id}
              index={index}
              stage={stage}
              turns={turns}
              artifacts={stageArtifacts}
              nameById={nameById}
              isExpanded={isExpanded}
              onToggle={toggle}
              streaming={streaming}
              reasoning={reasoning}
              now={now}
            />
          );
        })}

        {runTurns.ordered.length > 0 && run.stages.length === 0 && (
          <div className="dim small">turns recorded but no stage index was received</div>
        )}
      </div>
    </Panel>
  );
}

// -------------------------------------------------------------- run header

function RunHeader({
  run,
  now,
  nameById,
  spendRatio,
}: {
  run: Run;
  now: number;
  nameById: Map<string, string>;
  spendRatio: number;
}) {
  return (
    <div className="run-header">
      <div className="field-label">Brief</div>
      <div className="run-brief-full">{run.brief}</div>

      <div className="run-header-row">
        <span className="mono small dim">submitted by {run.submittedBy ? nameById.get(run.submittedBy) ?? run.submittedBy : 'the user'}</span>
        <span className="mono small dim">created {new Date(run.createdAt).toLocaleString()}</span>
        {run.tags.length > 0 && (
          <span className="chips">
            {run.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </span>
        )}
        <span className="run-row-spacer" />
        <span className="mono small">
          {formatUsd(run.budget.spentUsd)} / {formatUsd(run.budget.limitUsd)}
        </span>
      </div>
      <Bar value={run.budget.spentUsd} max={run.budget.limitUsd} tone={spendRatio >= 0.9 ? 'danger' : spendRatio >= 0.7 ? 'warn' : 'accent'} />

      {run.objective !== null && run.objective.trim().length > 0 && (
        <details className="run-objective" open>
          <summary>Objective</summary>
          <Markdown text={run.objective} idPrefix="objective" />
        </details>
      )}

      {run.outcome !== null && run.outcome.trim().length > 0 && (
        <details className="run-outcome" open>
          <summary>Outcome</summary>
          <Markdown text={run.outcome} idPrefix="outcome" />
        </details>
      )}

      {run.error !== null && run.error !== undefined && (
        <div className="alert alert-danger" role="alert">
          <span className="strong">Run error</span>
          <span className="mono small">{run.error}</span>
        </div>
      )}

      {run.endedAt === null && run.status !== 'running' && (
        <div className="dim small">last update {formatDuration(Math.max(0, now - run.updatedAt))} ago</div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- stage block

interface StageBlockProps {
  index: number;
  stage: StageRun;
  turns: TurnRecord[];
  artifacts: Artifact[];
  nameById: Map<string, string>;
  isExpanded: (turn: TurnRecord, stage: StageRun) => boolean;
  onToggle: (turnId: string, next: boolean) => void;
  streaming: Record<string, string>;
  reasoning: Record<string, string>;
  now: number;
}

function StageBlock({
  index,
  stage,
  turns,
  artifacts,
  nameById,
  isExpanded,
  onToggle,
  streaming,
  reasoning,
  now,
}: StageBlockProps) {
  const [open, setOpen] = useState<boolean>(true);
  const participants = (stage.participantRoleIds.length > 0 ? stage.participantRoleIds : stage.spec.roleIds).map(
    (roleId) => nameById.get(roleId) ?? roleId,
  );
  const tokensIn = turns.reduce((total, turn) => total + turn.usage.tokensIn, 0);
  const tokensOut = turns.reduce((total, turn) => total + turn.usage.tokensOut, 0);
  const cost = turns.reduce((total, turn) => total + turn.usage.costUsd, 0);
  const duration = (stage.endedAt ?? now) - (stage.startedAt ?? stage.endedAt ?? now);
  const modeDescription = `${stage.spec.mode}${stage.spec.rounds ? ` · ${stage.spec.rounds} rounds` : ''}${
    stage.spec.maxIterations ? ` · max ${stage.spec.maxIterations} iterations` : ''
  }`;

  return (
    <section className={`stage stage-${stage.status}`}>
      <header className="stage-head">
        <button type="button" className="stage-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <span className="stage-index mono">{String(index + 1).padStart(2, '0')}</span>
          <span className="stage-name strong">{stage.spec.name}</span>
          <Badge tone="accent">{stage.spec.kind}</Badge>
          <Badge tone="neutral">{modeDescription}</Badge>
          <Badge tone={statusTone(stage.status)}>{stage.status}</Badge>
          {stage.spec.optional && <Badge tone="warn">optional</Badge>}
          <span className="stage-spacer" />
          <span className="mono small dim">
            {turns.length} turns · {formatTokens(tokensIn, tokensOut)} · {formatUsd(cost)} ·{' '}
            {stage.startedAt ? formatDuration(Math.max(0, duration)) : 'not started'}
          </span>
          <span className="chev">{open ? '▾' : '▸'}</span>
        </button>
        <div className="stage-sub">
          <span className="dim small">participants</span>
          <span className="chips">
            {participants.map((name) => (
              <Badge key={name} tone="neutral">
                {name}
              </Badge>
            ))}
          </span>
          {stage.spec.produces !== undefined && <span className="dim small">produces: {stage.spec.produces}</span>}
        </div>
      </header>

      {open && (
        <div className="stage-body">
          {stage.error !== null && stage.error !== undefined && (
            <div className="alert alert-danger" role="alert">
              <span className="strong">Stage error</span>
              <span className="mono small">{stage.error}</span>
            </div>
          )}

          {stage.summary !== null && stage.summary.trim().length > 0 && (
            <details className="stage-summary" open>
              <summary>Stage summary</summary>
              <Markdown text={stage.summary} idPrefix={`summary-${stage.id}`} />
            </details>
          )}

          {artifacts.length > 0 && (
            <div className="stage-artifacts">
              <div className="field-label">Artifacts</div>
              {artifacts.map((artifact) => (
                <details key={artifact.id} className="artifact-inline">
                  <summary>
                    <Badge tone="accent">{artifact.kind}</Badge>
                    <span className="strong">{artifact.title}</span>
                    {artifact.path !== undefined && <span className="mono small dim">{artifact.path}</span>}
                  </summary>
                  <Markdown text={artifact.body} idPrefix={`artifact-${artifact.id}`} />
                </details>
              ))}
            </div>
          )}

          {turns.length === 0 && stage.status !== 'pending' && (
            <div className="dim small">no turns recorded for this stage yet</div>
          )}

          {turns.map((turn) => (
            <TurnBlock
              key={turn.id}
              turn={turn}
              employeeName={nameById.get(turn.employeeId) ?? turn.employeeId}
              expanded={isExpanded(turn, stage)}
              liveText={streaming[turn.id] ?? ''}
              liveReasoning={reasoning[turn.id] ?? ''}
              durationMs={Math.max(0, (turn.endedAt ?? now) - turn.startedAt)}
              onToggle={onToggle}
            />
          ))}

          {stage.spec.instruction !== undefined && stage.spec.instruction.length > 0 && (
            <details className="stage-instruction">
              <summary className="dim small">stage instruction</summary>
              <div className="small">{stage.spec.instruction}</div>
            </details>
          )}
          <div className="dim small mono">roles in spec: {stage.spec.roleIds.join(', ') || '—'}</div>
        </div>
      )}
    </section>
  );
}

// --------------------------------------------------------------- turn block

interface TurnBlockProps {
  turn: TurnRecord;
  employeeName: string;
  expanded: boolean;
  liveText: string;
  liveReasoning: string;
  durationMs: number;
  onToggle: (turnId: string, next: boolean) => void;
}

const TurnBlock = memo(function TurnBlock({
  turn,
  employeeName,
  expanded,
  liveText,
  liveReasoning,
  durationMs,
  onToggle,
}: TurnBlockProps) {
  const body = liveText.length > 0 ? liveText : turn.text;
  const thoughts = liveReasoning.length > 0 ? liveReasoning : turn.reasoning ?? '';
  const streaming = liveText.length > 0;

  return (
    <article className={`turn turn-${turn.status}`}>
      <header className="turn-head">
        <button type="button" className="turn-toggle" onClick={() => onToggle(turn.id, !expanded)} aria-expanded={expanded}>
          <span className="chev">{expanded ? '▾' : '▸'}</span>
          <span className="turn-who strong">{employeeName}</span>
          <span className="turn-purpose">{turn.purpose}</span>
          <span className={tierClassName(turn.route.tier)}>{turn.route.tier}</span>
          <span className="mono small dim">{turn.route.modelId}</span>
          <span className="mono small dim">{turn.route.taskClass}</span>
          <span className="stage-spacer" />
          <span className="mono small dim">{formatTokens(turn.usage.tokensIn, turn.usage.tokensOut)}</span>
          <span className="mono small dim">{formatUsd(turn.usage.costUsd)}</span>
          <span className="mono small dim">{formatDuration(durationMs)}</span>
          <Badge tone={statusTone(turn.status)}>{turn.status}</Badge>
          {streaming && <Badge tone="info">streaming</Badge>}
        </button>
      </header>

      {expanded && (
        <div className="turn-body">
          <div className="turn-route-reason dim small">
            routed by {turn.route.providerId}: {turn.route.reason}
            {turn.route.fallbacks.length > 0 && ` · ${turn.route.fallbacks.length} fallbacks`}
            {turn.route.considered.length > 0 && ` · ${turn.route.considered.length} considered`}
          </div>

          {thoughts.length > 0 && (
            <details className="turn-reasoning">
              <summary className="dim small">
                reasoning {streaming && liveReasoning.length > 0 ? '(streaming)' : `· ${formatInt(thoughts.length)} chars`}
              </summary>
              <pre className="reasoning-pre">{thoughts}</pre>
            </details>
          )}

          {body.length > 0 ? (
            <div className={`turn-text${streaming ? ' turn-text-live' : ''}`}>
              <Markdown text={body} idPrefix={`turn-${turn.id}`} />
              {streaming && <span className="caret" aria-hidden="true" />}
            </div>
          ) : (
            <div className="dim small">{turn.status === 'running' ? 'waiting for the first token…' : 'no text produced'}</div>
          )}

          {turn.error !== null && turn.error !== undefined && (
            <div className="alert alert-danger" role="alert">
              <span className="strong">Turn failed</span>
              <span className="mono small">{turn.error}</span>
            </div>
          )}

          {turn.toolCalls.length > 0 && (
            <div className="tool-calls">
              <div className="field-label">Tool calls ({turn.toolCalls.length})</div>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">tool</th>
                    <th scope="col">status</th>
                    <th scope="col">duration</th>
                    <th scope="col">files</th>
                    <th scope="col">result</th>
                  </tr>
                </thead>
                <tbody>
                  {turn.toolCalls.map((call) => (
                    <ToolCallRow key={call.id} call={call} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {turn.wroteFiles.length > 0 && (
            <div className="wrote-files">
              <div className="field-label">Wrote</div>
              <span className="chips">
                {turn.wroteFiles.map((path) => (
                  <Badge key={path} tone="ok" mono>
                    {path}
                  </Badge>
                ))}
              </span>
            </div>
          )}

          {turn.skills.length > 0 && (
            <div className="turn-skills">
              <div className="field-label">Skills pulled into context</div>
              <span className="chips">
                {turn.skills.map((selection) => (
                  <Badge key={selection.skillId} tone="accent" title={`${selection.via}: ${selection.reason}`}>
                    {selection.skillId} · {selection.via}
                  </Badge>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    </article>
  );
});

function ToolCallRow({ call }: { call: ToolCallRecord }) {
  return (
    <tr>
      <td className="mono">{call.name}</td>
      <td>
        <ToolStatusBadge status={call.status} />
      </td>
      <td className="mono">{formatDuration(call.durationMs)}</td>
      <td>
        {call.affectsPaths.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          <span className="chips">
            {call.affectsPaths.map((path) => (
              <Badge key={path} tone="neutral" mono>
                {path}
              </Badge>
            ))}
          </span>
        )}
      </td>
      <td className="tool-result">
        {call.resultPreview.length > 0 ? (
          <details>
            <summary>{truncate(plainPreview(call.resultPreview, 120), 120)}</summary>
            <pre className="result-pre">{call.resultPreview}</pre>
            {call.argumentsJson.length > 0 && (
              <>
                <div className="field-label">arguments</div>
                <pre className="result-pre">{call.argumentsJson}</pre>
              </>
            )}
          </details>
        ) : (
          <span className="dim">—</span>
        )}
      </td>
    </tr>
  );
}
