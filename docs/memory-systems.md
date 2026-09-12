# Memory and knowledge systems for LLM agents

A survey of how agent memory systems are actually built, what the evidence says
about which parts work, and what that implies for dev3d. Written while deciding
whether dev3d should have a memory system at all, and if so which kind.

**Read the evidence-quality map first.** The single most useful fact about this
literature is that most of its headline numbers are not reliable, and the
strongest evidence in it argues *against* the elaborate architectures it is
usually cited to justify.

---

## 0. Evidence-quality map

| Area | Quality | Why |
|---|---|---|
| Cognitive taxonomies (working / episodic / semantic / procedural) | Strong as vocabulary, weak as mechanism | Consistent across surveys, but the surveys themselves admit the boundaries blur in LLM systems |
| Write-path failure evidence | Strong, unusually honest | Operation-level benchmarks localise failures to extraction vs updating vs QA |
| Retrieval-strategy evidence | Contested | Peer-reviewed IR benchmarks support BM25 as a robust baseline; vendor benchmarks claim the opposite |
| Decay / forgetting constants | Weak | The specific decay values trace to a single-author field report, not a study |
| Cost / latency numbers | Weak–moderate | Vendor self-reported, different corpora, different backbones, different judges |
| Benchmark leaderboards | Weak as rankings | Metric mixing, backbone variance, judge variance, split variance |
| Vendor claims generally | Treat as claims, not facts | Documented, conceded arithmetic errors and failed reproductions |

Two meta-findings shape everything below.

**1. Memory is a write-path problem.** Every benchmark that decomposes the
pipeline finds errors originating in extraction and updating, then propagating
downstream to question answering. One benchmark deliberately *excluded*
retrieval from its hallucination evaluation because retrieval rarely introduces
generative error. If one component is to be instrumented, it is the writer.

**2. The benchmark numbers are not trustworthy.** The two best-known memory
vendors have publicly audited each other, and both audits found real defects:

- A vendor published 84% on LoCoMo; a competitor found a numerator/denominator
  bug that counted excluded adversarial questions in the numerator but not the
  denominator. The first vendor **conceded** and corrected to **75.14%**.
- The competitor's own re-run produced **58.44%** for the same system. So the
  same system on the same benchmark has published scores of **58.44 / 65.99 /
  75.14 / 84**.
- A vendor's own platform reports 92.5% on a benchmark where independent re-tests
  of its open-source artefact got **61.4–66.9%**.
- One system claimed 92.32%; two independent researchers reproduced **38.38%**.
- A vendor's platform stored memories with the current wall-clock time instead of
  the dataset timestamps, so a question about "7 May 2023" produced a memory
  referencing "January 2026" and the score collapsed to ~20%.

Any design justified by "system X scores N on benchmark Y" is on thin ice.

---

## 1. The systems, and what each actually does

### MemGPT / Letta — virtual context management

An explicit operating-system analogy: the context window is main memory, everything
else is disk. Main context is partitioned into system instructions, a fixed-size
read/write **working context** writable only through function calls, and a **FIFO
queue**. The first index of the queue holds a recursive summary of everything
evicted from it.

The paging mechanism, concretely:

| Trigger | Threshold | Action |
|---|---|---|
| Warning | prompt > ~70% of window | inject a "memory pressure" warning so the model can flush what matters |
| Flush | prompt > 100% of window | evict ~50% of the window, regenerate the recursive summary from the old summary plus the newly evicted messages |

Evicted messages stay in recall storage forever and are readable by function call.
**The model decides every write** — there is no external extractor and no write-time
filter. Conflict handling is weak: no invalidation, no validity intervals, no dedup;
a contradicted fact persists until the model notices and rewrites the block.

The direction of travel matters more than the original design. MemGPT became memory
blocks, then sleep-time agents, and in 2026 became **git-backed plain files** with
progressive disclosure. The trajectory is away from bespoke memory structures and
toward primitives that coding models are already post-trained on.

### Mem0 — extraction plus a decision-theoretic update

Per message pair, an extractor LLM proposes candidate facts, and a second LLM call
chooses an operation per candidate against the top-`s` similar existing memories:
`ADD`, `UPDATE`, `DELETE`, `NOOP`. Two details are worth stealing regardless of the
architecture: an **asynchronously refreshed conversation summary** as cheap global
context, and **explicit operation semantics as a stable interface** between model
reasoning and deterministic storage code.

Base Mem0's `DELETE` is a **hard delete** — history loss, no audit trail. There is no
decay or TTL policy at all.

**The part almost nobody cites: Mem0 replaced this in April 2026.** The current
algorithm is *single-pass ADD-only extraction — one LLM call, no UPDATE/DELETE;
memories accumulate, nothing is overwritten.* Reported LoCoMo went 71.4 → 92.5 and
LongMemEval 67.8 → 94.4. So the 2025 paper that everyone designs against describes a
design its own authors have since dropped, and they moved in the *opposite* direction
from the invalidation-based systems.

The community response is instructive: an open issue immediately reported that
ADD-only extraction "may surface stale/contradictory facts for time-sensitive
attributes." Append-only is not sufficient on its own.

### Zep / Graphiti — bi-temporal knowledge graph

Three tiers: non-lossy **episodes** (raw input with a reference timestamp),
**entities** with evolving summaries, and **facts** as edges carrying temporal
validity windows, plus hierarchical **communities** with summaries. Every fact links
back to its source episode, so provenance is complete.

The core contribution is the four-timestamp model — two independent pairs:

- **Valid time** — when the fact was true in the world: `t_valid` … `t_invalid`
- **Transaction time** — when the system learned or invalidated it: `t'_created` … `t'_expired`

When contradicting information arrives, overlapping edges are **invalidated, not
deleted**, so "what did we believe on date X" stays answerable. Retrieval is a real
IR stack rather than a graph query: cosine similarity + BM25 + graph BFS, then
reranking (RRF / MMR / cross-encoder), then context construction that includes the
validity ranges.

The cost is operational: graph construction and community summarisation are
LLM-heavy background jobs, ingestion is asynchronous, and the framework requires
reliable structured output — its own documentation warns that small models emit
schema-violating JSON that surfaces as extraction failures.

### GraphRAG — a graph index over a static corpus

Not an agent memory system: it has no conversational write path, no update
semantics and no invalidation. Entities, relationships, claims and hierarchical
Leiden communities, summarised bottom-up; retrieval is map-reduce over community
summaries with a helpfulness score.

Its reported win rates (72–83% comprehensiveness) are **LLM-judged with no gold
answers**. Scored against ground truth, the same class of comparison inverts: on
ROUGE-2 against gold, GraphRAG loses to plain RAG, 6.99 vs 10.08 and 3.23 vs 6.32.
The gain came from the measurement instrument, not the system.

A graph earns its cost only for global sensemaking over a corpus and multi-hop
relational questions. For single-hop factual retrieval it loses to reranked vector
RAG, and at 12×+ the index cost.

### Hierarchical summarisation — what breaks at scale

Three mechanisms: rolling window plus recursive summary (MemGPT), recursive tree
summarisation (RAPTOR), and programmable recursion where the long prompt is kept
outside context as a symbolic handle the model slices with code.

The independent evaluations are decisive here, because they test *incremental*
ingestion rather than single-shot retrieval. Holding the backbone constant at
GPT-4o-mini:

| Approach | Single-hop QA | LongMemEval-S | Summarisation |
|---|---|---|---|
| No memory at all | **53.5** | 30.7 | 28.9 |
| Dense RAG | **83.0** | 55.0 | 20.7 |
| BM25 | 61.0 | 45.3 | 20.9 |
| RAPTOR | 33.5 | 34.3 | 13.4 |
| GraphRAG | 47.0 | 35.0 | **0.4** |
| Mem0 | **28.0** | 36.0 | 0.8 |
| MemGPT | 39.5 | 32.0 | 2.5 |

Specialised memory systems scoring *below the no-memory baseline* on single-hop
recall is the headline. The diagnosed cause is that fact extraction discards
information later queries need, and it is unrecoverable.

The corresponding guideline, from a twelve-system study, is a **late-filtering
principle**: preserve context during extraction and filter at query time, because
"aggressive filtering during extraction often removes cues that might be essential
for future, unforeseen queries." The same study found aggressive summarisation and
delayed flushing break cross-turn linkage, and that semantic consolidation
specifically damages temporal cues — for time-sensitive queries, plain long-context
retrieval beat memory-augmented approaches.

Note the unresolved tension: one study says do not consolidate aggressively, another
says purely appended memory degrades catastrophically over long runs, and Mem0 went
append-only. The defensible synthesis is **preserve raw episodes, consolidate
lightly, resolve conflicts at read time**.

---

## 2. Retrieval: keyword versus embeddings

This is genuinely contested, and for a *coding* workload the honest reading is that
keyword search is stronger than the field assumes.

**For keyword.** A peer-reviewed heterogeneous IR benchmark concludes that "BM25 is a
robust baseline" and that dense and sparse-retrieval models "often underperform."
A widely-cited 96.6% retrieval result turned out to use stock ChromaDB with default
embeddings and *no system features at all* — and **BM25 alone scored 93.8%** on the
same setup, while enabling the actual system features *lowered* the score.

**For embeddings.** One well-documented decision record measured that pure lexical
search misses semantic associations, and addressed it with optional hybrid retrieval
rather than mandatory embeddings — the right way to justify them.

**For code specifically.** A production SWE-Bench agent reported that "grep and find
were sufficient… embedding-based retrieval wasn't the bottleneck," attributing this
to agent persistence compensating for weak tools. A vendor's own best-case number for
semantic search is +12.5% accuracy, concentrated on repositories above ~1,000 files.
For a small or mid-size repository, lexical retrieval plus a structural symbol map is
the stronger default.

**Reranking** wins zero-shot but at high computational cost.

**Agentic retrieval has its own failure mode.** Where the model decides whether to
search, one measurement found only 46.67% recall *with the tool available* — the
model simply failed to invoke it. That converts a retrieval-quality problem into a
tool-invocation-compliance problem, which is worse because it fails silently.
Deterministic triggers are the safer design.

---

## 3. Forgetting, contradiction and decay

**Decay.** The canonical scheme is a weighted score of recency, importance and
relevance, with all weights equal and each term min-max normalised; recency decays
at 0.995 per hour since last *access*, so retrieval refreshes it, and importance is
rated once by the model at creation time. The concrete tiered decay constants in
circulation (0.04 for raw episodes, 0.015 weekly, 0.005 monthly, **0 for
procedures**) come from a single-author field report and should be treated as one
team's tuning, not a consensus — but the *structure* is well reasoned: coarser
summaries decay slower, compacted summaries outrank an equivalent single raw event
because the repetition that produced them is itself evidence, and **rules never
decay**.

**Do not delete on decay.** Decay score measures recency of access, not behavioural
importance. An episode from 95 days ago — "this reviewer rejected this three times,
never wants assertive language here" — scores low precisely because it has not been
needed, and is the single most critical item the moment it is. Low decay should mean
*retrieve less often*, never *destroy*. The only hard-deletion paths should be
explicit operator erasure and operator-marked-wrong.

**Contradiction is the least-solved problem in the field.** Multi-hop conflict
accuracy caps at **6% for every method tested**. Memory-conflict question accuracy
ranges from 86% for the best system down to 18.9% for another at scale. Most
frameworks default to last-write-wins, which silently discards the losing fact.

The principled answer, and the one worth copying even without a graph, is
**supersession**: never overwrite; mark `invalid_from` and `superseded_by`, filter
reads on `superseded_by IS NULL`, and keep the losing fact retrievable for "what did
we believe then."

**Two security-shaped failure modes** that a multi-agent system must design for:

- **Poisoning is cheap.** One attack achieves >80% success at a poison rate below
  0.1% with under 1% degradation on benign inputs, no fine-tuning, by pushing
  malicious content into a distinct embedding region.
- **Memory makes prompt injection durable.** If any agent reads attacker-reachable
  content, memory becomes a persistence mechanism for injection: one poisoned input
  can shape every later session.

**Model-version drift is silent corruption.** Memories are natural-language artefacts
interpreted by a specific model; when the backbone changes, a stored rule can produce
different behaviour not because it became false but because its implicit assumptions
expired. No major system tags entries with the model that wrote them — a cheap
mitigation.

---

## 4. What production coding agents actually do

They store **files**. A project-level markdown file (`AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`), editor rule directories, or a tool-specific memory folder. The
properties that make this win are not sophistication: it is auditable through git,
naturally scoped, and needs no running service.

The strongest empirical result in this area argues for restraint rather than
elaboration. A controlled study of SWE-bench tasks and developer-committed context
files found that providing them **does not generally improve task success rates,
while increasing inference cost by over 20% on average** — holding across models,
agents, and both LLM-generated and developer-written files. Instructions were well
followed; repository *overviews* specifically were "not helpful," and agents followed
instructions even when they were irrelevant to the task. The authors' conclusion is
narrower than "context files are useless": they are useful **for specifying non-standard
coding practices**, and anything else "should be rigorously evaluated before
deployment."

Two limits on that finding matter for how it is used here, because it is easy to
over-read:

- It tested **always-on injection**. Nothing in it speaks to on-demand retrieval, which
  is a different channel with a different cost structure.
- It is about *guidance* (how to behave), not about *recall of past work*, which is the
  gap identified in §5.

Read carefully, it is the strongest available argument against unconditional memory
injection, and it points the same way as the late-filtering principle: **retrieve on
demand rather than inject unconditionally.** Store more than you show; show only what
the task asked for. The cost of a memory system is not only its tokens but the
attention it takes from the task.

There is a counterweight worth keeping: for multi-agent systems, token usage is
reported to explain ~80% of performance variance, and distributing work across
separate context windows is how total capacity scales. So a large store with small,
targeted retrieval windows is the shape that pays off — provided the retrieval
triggers are deterministic.

---

## 5. What this implies for dev3d

### What dev3d already has

| Surface | What it does | Where |
|---|---|---|
| `RunKnowledge` | Threads brief, objective, stage summaries, artifacts and files forward **within one run** | `engine/types.ts`, `engine/prompt.ts` |
| Skills | Keyword + task-class selection over 15 markdown documents; a role's first two are always on | `skills/loader.ts` |
| Learned model quality | Confidence-weighted, Beta-smoothed outcomes from the office's own turns | `llm/quality.ts` |
| Event log, turns, artifacts | Append-only SQLite record of every run, turn, tool call and artifact body | `store/store.ts` |
| Tools | `grep` (regex, include/exclude, files-only), `glob`, `read_file`, `list_dir`, `git` | `tools/fs.ts`, `tools/code.ts`, `tools/git.ts` |
| Plugins | A contribution point for models, skills, tools, routing rules and panels | `plugins/host.ts` |

Two of those are already memory systems in miniature, and the comparison is
instructive. `RunKnowledge` is exactly the episodic thread the ICML subtask-granularity
result argues for — keyed to the agent's own functional decomposition, **conveniently
the same shape as dev3d's existing `StageKind` enum**. And `llm/quality.ts` is the most
sophisticated memory in the repository: it keeps separate opinions rather than
averaging them, weights by confidence, shrinks a learned estimate towards its prior
rather than reporting it raw, and is consulted on the router's hot path. It is
outcome-driven memory with smoothing, and it already works.

### The actual gap

`RunKnowledge` dies with the run. Nothing substantive survives between runs, because
the only cross-run learning is `quality.ts` — and that records *whether a model
answered*, never *whether the work was good*. Concretely, the office cannot answer:

- What did we try for this problem last time, and did it work?
- We broke this exact thing three runs ago — what did we do?
- This project has a house convention that is nowhere in the README.
- This reviewer always rejects a certain shape of change.

It has the raw material for all four: `turns` and `artifacts` already hold the text.
What is missing is a layer that survives the run boundary, is keyed to the right
scope, and can be retrieved.

### Recommended design

**Scope.** `workspace` → `role` → `installation`, mirroring how the office already
partitions the building. A floor must not see another floor's memory, for the same
reason it cannot see its files: the existing confinement choke point is the model to
follow, and scoping must be enforced in exactly one place.

**Storage.** One SQLite file, the one dev3d already opens.

The two candidate indexes were measured on this machine rather than assumed:

| Index | 20,000 items | Size | Query |
|---|---|---|---|
| **FTS5 + `bm25()`** | code-like documents | **5.1 MB** | **0.03 ms** |
| `sqlite-vec` `vec0` | 384-dim float32 vectors | **30.5 MB** | **29.8 ms** |

That is roughly **1000× faster and 6× smaller** for lexical, and it holds because
`sqlite-vec` is a brute-force linear scan with no ANN index — its own benchmarks state
that only exhaustive scans are tested. Scaling is linear in practice (5k vectors →
2.1 ms, 20k → 29.8 ms), which puts a practical ceiling around 10⁴–10⁵ vectors.

- **FTS5 with BM25** as the primary index. Confirmed compiled into this Node build
  (SQLite 3.53.3; `bm25()` ranking and `porter unicode61` tokenisation both working)
  with **zero dependencies and no extension loading at all**.
- **An append-only transcript remains ground truth** and is never mutated. Derived
  memory rows carry source pointers back to the turns they came from, so "why did it
  think that?" is always answerable.
- **Embeddings are optional**, gated by config, and degrade to lexical-only. This
  matters because a keyless install must stay fully functional: with no embedding
  provider the memory layer still works, exactly as the office already keeps a full
  model catalog in `mock` mode.
- **`sqlite-vec` works, with a trap.** Extension loading must be enabled at
  construction — `new DatabaseSync(path, { allowExtension: true })`. Calling
  `enableLoadExtension(true)` alone throws, and `'loadExtension' in db` returns `true`
  while still being unusable, so feature detection lies. Verified end-to-end (vec0
  tables, KNN `MATCH`, v0.1.9, a 282 KB native binary), with one further gotcha: vec0
  `rowid` must be bound as a `BigInt`, because a JS number throws.
- Despite working, it should be **off by default**. The lexical ceiling has to be
  measured on real queries before a native, pre-v1 dependency earns a place in a
  project whose server currently depends only on `ws`.

**Write path.** This is where the evidence says to spend the effort.

- Derive from the existing append-only transcript, with mandatory provenance.
- **Supersede, never overwrite.** `invalid_from` + `superseded_by`, reads filtered on
  `superseded_by IS NULL`, losing facts retained.
- Never hard-delete on decay grounds; decay demotes retrieval priority only.
- **Tag every row with the model that wrote it**, so backbone drift is visible later.
- Deduplicate before insert and increment an occurrence count rather than replacing.
- Cap derived writes per cycle so the system cannot flood itself.
- **Promote procedural rules only on accumulated evidence**, and demote on failure.

**Retrieval.** Deterministic triggers rather than asking the model whether it wants to
remember: task start, a failure, a stage boundary. Lexical-first, since the queries
this workload generates are dominated by file paths, identifiers, error strings and
symbol names — the exact regime where IDF is high and there is no paraphrase to
bridge. Hard token cap on anything injected, compressed explicitly rather than
silently truncated.

**Where it reaches the agent.** Two options, and they are not exclusive:

1. **Threaded** — retrieved memory joins `RunKnowledge` as one more section of
   `situationSection()`, so it arrives without the model having to ask.
2. **Held** — a `recall` tool the role holds, so memory is pulled on demand.

Evidence favours the second, and the reason is the ETH result plus the 46.67%
tool-invocation figure pulling in opposite directions. Always-injecting is measurably
expensive; letting the model decide whether to search fails silently. The resolution
both production tools converged on is **neither**: a small bounded surface that always
arrives (an index of what memory exists) over an unbounded store that is fetched on
demand. Claude Code's 200-line / 25 KB `MEMORY.md` index over unloaded topic files is
the cleanest version of this, and Cursor, Copilot and Windsurf all land on the same
four activation modes — always-on, path-triggered, model-selected, manual.

Applied here: the role is told *that* relevant memory exists and how to fetch it, and
the fetching is a deterministic tool call rather than a judgement. The cap on the
always-on part is enforced with a visible error rather than silent truncation, because
silent truncation is the failure mode users cannot see.

**Two operational requirements worth copying from the tools that ship this:** every
memory should record where it came from so it can be **revalidated before use**, and
the console should be able to answer *which memories were injected into this turn*.
A memory system without load provenance generates exactly the complaint class the
editor plugins suffer from — memories that appear to exist but silently do not apply.

**Export.** Memory should be dumpable to markdown in the workspace for human audit and
`git diff`, which is what production coding agents converge on and what makes a memory
reviewable by a person rather than only by the system that wrote it.

### The differentiator

The strongest critique of recency- and TTL-based decay is that it conflates "this is
irrelevant" with "this is rarely but critically needed," and the proposed fix —
scoring memory by whether using it contributed to task success — is unobtainable in
most deployments because they have no ground-truth reward signal at inference time.

**dev3d has one.** Runs halt or complete, reviews accept or reject, tests pass or
fail, and `llm/quality.ts` already implements outcome-driven scoring with smoothing
and a prior. Extending that posture from *which model answered* to *which memory
helped* is the one place this project can beat the published systems rather than
imitate them.

> This simulation is exactly the rare setting where ground-truth outcomes are
> available, so the loop can be closed — most deployments cannot.

### What to build first

Ordered by evidence-per-unit-of-work, and deliberately small:

1. **Episodic recall across runs** — a `recall` tool over past runs, turns and
   artifacts, FTS5-backed and scope-filtered. This is the highest-value gap, and it
   needs no extraction and therefore no write-path hallucination risk.
2. **Outcome-weighted retrieval** — record which memories were surfaced for a run and
   attach the run's outcome, so utility accumulates the way model quality already does.
3. **Semantic facts with supersession** — project conventions, decisions and
   constraints, written explicitly and invalidated rather than overwritten.
4. **Procedural rules promoted from evidence** — the last rung, because it is the one
   with real error-propagation risk and the one that most needs the outcome signal.

### What not to build

- **A knowledge graph.** Measured worse than reranked vector RAG on fact retrieval and
  0.4 F1 on summarisation, at 12×+ index cost — justified only by multi-hop and global
  sensemaking queries this workload does not generate.
- **An external vector database.** Rejected on the same grounds the rest of the
  repository rejects services: a daemon to run, backups to manage, and a mandatory
  dependency for a single-user local tool.
- **Always-injected memory.** The controlled study found context files raise cost by
  >20% without improving success.
- **An LLM extraction pass on every turn.** This is the component the evidence
  identifies as the origin of most memory errors, and the one that dominates cost —
  the write path runs 5–50× the retrieval path in published timings. Extraction, where
  it exists at all, belongs off the critical path.
- **Deletion as the answer to contradiction.** Last-write-wins silently discards facts
  and is the documented default failure of most frameworks.

---

## 6. How to know whether any of it works

None of the published benchmarks is worth adopting wholesale. These are cheap,
deterministic and more decision-relevant:

1. **Behavioural ablation — memory on, off, and shuffled.** Run the same task suite
   three ways. If the scores do not move, memory is not working regardless of what any
   retrieval metric says. The shuffled condition measures injecting irrelevant memory,
   which is worse than injecting none.
2. **Retrieval R@k on a hand-built needle set** of real file paths, symbol names and
   past failure signatures. Computable by string matching: no judge model, no variance.
3. **Write-path audit** — the fraction of stored memories traceable to a source turn,
   and the count of unattributable entries per hundred writes. This targets the stage
   the evidence says produces the errors.
4. **Contradiction regression** — inject a superseding fact and assert the agent uses
   the new one, the old one is marked invalid rather than deleted, and a "what did we
   believe then" query still returns it with its validity window.
5. **Cost accounting split by path** — tokens and wall-clock for writing versus
   retrieving. Expect the writer to dominate; if it does not, check whether the system
   is storing anything at all.

---

## Sources

**Surveys and taxonomies**
- [A Survey on the Memory Mechanism of Large Language Model based Agents](https://arxiv.org/abs/2404.13501)
- [Rethinking Memory in LLM based Agents: Representations, Operations, and Emerging Topics](https://arxiv.org/abs/2505.00675)
- [Cognitive Architectures for Language Agents (CoALA)](https://arxiv.org/abs/2309.02427)
- [Structurally Aligned Subtask-Level Memory for Software Engineering Agents](https://icml.cc/virtual/2026/poster/66605) (ICML 2026)

**Systems**
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
- [Sleep-time Compute](https://arxiv.org/abs/2504.13171)
- [Letta: Memory Blocks](https://www.letta.com/blog/memory-blocks) · [Context Repositories](https://www.letta.com/blog/context-repositories/) · [Benchmarking AI Agent Memory](https://www.letta.com/blog/benchmarking-ai-agent-memory/)
- [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413) · [OSS v2→v3 migration (ADD-only)](https://docs.mem0.ai/migration/oss-v2-to-v3) · [ADD-only staleness issue](https://github.com/mem0ai/mem0/issues/4956)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) · [Graphiti](https://github.com/getzep/graphiti)
- [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://arxiv.org/abs/2404.16130)
- [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442)
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- [ExpeL: LLM Agents Are Experiential Learners](https://arxiv.org/abs/2308.10144)
- [Agent Workflow Memory](https://arxiv.org/abs/2409.07429)
- [MemoryBank: Enhancing Large Language Models with Long-Term Memory](https://arxiv.org/abs/2305.10250)
- [ENGRAM: Effective, Lightweight Memory Orchestration for Conversational Agents](https://arxiv.org/abs/2511.12960)

**Benchmarks and independent evaluation**
- [Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo)](https://arxiv.org/abs/2402.17753)
- [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813)
- [Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions (MemoryAgentBench)](https://arxiv.org/abs/2507.05257)
- [HaluMem: Evaluating Hallucinations in Memory Systems of Agents](https://arxiv.org/abs/2511.03506) · [leaderboard](https://github.com/MemTensor/HaluMem)
- [MemBench](https://arxiv.org/abs/2506.21605)
- [BEIR: A Heterogenous Benchmark for Zero-shot Evaluation of Information Retrieval Models](https://arxiv.org/abs/2104.08663)

**The vendor dispute, primary sources**
- [Mem0's audit of Zep's LoCoMo score](https://github.com/getzep/zep-papers/issues/5)
- [Zep's critique of Mem0](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- [Zep on memory poisoning](https://blog.getzep.com/defending-agent-memory-poisoning/)
- [Mem0 platform timestamp defect](https://github.com/mem0ai/mem0/issues/3944)

**Security**
- [AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases](https://arxiv.org/abs/2407.12784)

**Engineering practice**
- [mnemon-memory-mcp ADR-0001: SQLite + FTS5 as the storage and retrieval core](https://github.com/nikitacometa/mnemon-memory-mcp/blob/main/docs/adr/0001-sqlite-fts5-over-vector-db.md)
- [Production Agent Memory: Compaction, Decay, and the Observation Engine](https://dev.to/ac12644/production-agent-memory-compaction-decay-and-the-observation-engine-24gf)
- [AI Agent Memory Architectures for Multi-Agent Systems](https://zylos.ai/research/2026-03-09-multi-agent-memory-architectures-shared-isolated-hierarchical/) (Zylos Research)
- [The Use of MMR, Diversity-Based Reranking](http://www.cs.cmu.edu/~jgc/publication/MMR_DiversityBased_Reranking_SIGIR_1998.pdf) (SIGIR 1998)

---

*Environment facts in this document were verified on the machine this repository
is developed on: Node v24.19.0, `node:sqlite` over SQLite 3.53.3, FTS5 available
with `bm25()` and `porter unicode61` tokenisation, and `sqlite-vec` v0.1.9 loading
successfully via `allowExtension: true`.*

**Outcome.** Vector search was subsequently implemented and is off by default
(`DEV3D_MEMORY_VECTORS`, plus `DEV3D_MEMORY_EMBEDDING` naming where text becomes
vectors). It re-ranks a lexically selected candidate set rather than selecting it,
so the scope and activity filters keep living on the one code path that already
enforces them. `sqlite-vec` is an optional dependency of `apps/server`, chosen
because a native binary that cannot install must degrade to lexical recall rather
than fail an install. The measurements above still argue for leaving it off until
the lexical ceiling has been measured on real queries.
