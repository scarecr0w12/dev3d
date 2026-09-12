# Releasing dev3d

The release process, and the reasoning for the parts of it that are not obvious.
Everything here is runnable as written from the repository root.

## What "done" means for a release

A release is a commit on `main` that has passed every check below, tagged
`vX.Y.Z`, with the version in the root `package.json` matching the tag.

The rule that matters: **nothing in the README may be aspirational.** If a
surface is documented as working, either the suite proves it or the release notes
say plainly that it does not. Every number in the README that a command can
produce should be produced by that command.

## Pre-release checklist

Run these in order. Each one is exactly what CI runs, so a local pass and a green
build mean the same thing.

```bash
# 1. Types across all four projects (core, server, web, and the test harness)
node packages/core/node_modules/typescript/bin/tsc     -p packages/core/tsconfig.json --noEmit
node apps/server/node_modules/typescript/bin/tsc       -p apps/server/tsconfig.json --noEmit
node apps/web/node_modules/typescript/bin/tsc          -p apps/web/tsconfig.json --noEmit
node apps/web/node_modules/typescript/bin/tsc          -p apps/web/.verify/tsconfig.json --noEmit

# 2. The server suites
cd apps/server && node --test --test-isolation=none "src/**/*.test.ts"

# 3. The client store reducer
node apps/web/.verify/smoke.ts

# 4. The degradation promises (no database, malformed skill, empty skills dir)
node scripts/check-failure-paths.mjs

# 5. Every className exists in the stylesheet, and no rule is dead
node scripts/check-css.mjs

# 6. The office asset still carries the anchors the UI needs
node scripts/inspect-glb.mjs apps/web/public/office/office.glb

# 7. A production bundle
cd apps/web && node node_modules/vite/bin/vite.js build

# 8. Boot the built thing and drive it as a real client
node apps/server/src/index.ts &
node scripts/smoke-ws.mjs
```

Then, by hand, because no script can judge these:

- **Look at every page.** `node scripts/shoot-state.mjs --script "click:Runs"`
  for each tab, and check the console is reported clean. A screenshot cannot show
  a console error, so the harness prints them; an audit that only looks at pixels
  will pass a page that threw on the way to painting.
- **Check the release notes against Known gaps.** If a limitation was fixed, it
  should have left that section; if one was added, it should be in it.
- **Check the README's numbers.** Every test count, check count and module count
  is reproducible from this list. `grep -n 'tests\|checks\|modules' README.md`.

## Cutting the release

```bash
# The version lives in the root package.json and nowhere else: the server reads
# it at boot, so /api/health and the Settings page cannot disagree with it.
node -e "console.log(require('./package.json').version)"

git switch -c release/v1.0.0        # optional, if main is protected
# bump "version" in package.json, and run the checklist above
git add -A
git commit -m "release: v1.0.0"
git tag -a v1.0.0 -m "dev3d v1.0.0"
git push origin main --follow-tags
```

Then write the notes. What belongs in them:

- The headline: what someone can now do that they could not before.
- Every behaviour change, phrased as what the operator will see.
- Anything in **Known gaps** that is new — a release that quietly gains a
  limitation is worse than one that states it.
- The verification numbers as they actually came out, not as they were planned.

## Version policy

Before 1.0 the API version and the package version were separate ideas. Now:

| Change | Bump |
|---|---|
| A breaking change to `ClientCommand`, `ServerEvent`, or `OfficeState` | major |
| A breaking change to a plugin manifest field, or the host's plugin API | major |
| A new command, event, page, or plugin contribution point | minor |
| A fix, a wording change, a documentation pass | patch |

`OfficeState` and the wire protocol live in `packages/core`. A change there is a
change to both ends at once, and the browser and the orchestrator are expected to
be the same version — there is no protocol negotiation, and this is deliberate:
the UI is served by the orchestrator it talks to.

## What is deliberately not part of a release

- **No npm publish.** The packages are `private: true`. This is an application
  you run, not a library you install.
- **No compiled artifacts.** Everything runs from source: Node 22 executes the
  TypeScript directly, and the web bundle is built on demand. The only build
  output that exists is `apps/web/dist`, which is served by the orchestrator and
  is not committed.
- **No authentication.** Documented as a limitation, not a gap to close silently.
  Bind it to localhost.

## If a release goes wrong

There is no migration path for `data/dev3d.sqlite` beyond the runtime's own
migrations, and no downgrade path at all. Before tagging:

```bash
cp data/dev3d.sqlite data/dev3d.sqlite.bak   # if you have real history
```

The store is forgiving by design: if the database cannot be opened, the office
still boots, says so, and forgets everything on exit. That is the documented
behaviour and `scripts/check-failure-paths.mjs` holds it to it.
