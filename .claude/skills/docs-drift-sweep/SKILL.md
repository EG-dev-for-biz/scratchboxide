---
name: docs-drift-sweep
description: After a change to behaviour (a renamed or retired switch, tool argument, pipeline, default, stage or message), find every place that still describes the old behaviour - AGENTS.md, the in-app system prompt, tool descriptions, both agents' skills, living plans, code comments, stage and skip messages, tests - and fix or flag each one. Use before committing any change that renames, retires or re-defaults something, and whenever a comment or message turns out to say something the code no longer does.
---

# Docs drift sweep

The coverage-map idea draws on gstack's `/document-release` (MIT, Garry Tan), turned here into a sweep over the places
this repo writes behaviour down.

## Why this exists

Each reader sees a different copy of the behaviour. The in-app model reads only its system prompt, its tool descriptions
and its skills; coding agents read AGENTS.md and their skills; the user reads stage, skip and degrade messages. Any copy
left describing the old behaviour misleads whoever reads it next. AGENTS.md section 4 asks that the code and its summary
stay in step.

## Step 1: list what changed

From your own diff (the checkout is shared, so only your files), list every renamed or removed symbol, environment
variable, tool argument or enum value, default, stage, skip reason and file. Write the old and the new for each.

## Step 2: sweep these places for each old name and each old meaning

| Place | Read by | Where |
|---|---|---|
| AGENTS.md | coding agents | `AGENTS.md` |
| System prompt | the in-app model | `packages/core/src/node/gemini/prompt-builder.ts` |
| Tool declarations | the in-app model | `packages/core/src/node/gemini/tools/**` (descriptions and enums) |
| App skills | the in-app model | `.agents/skills/**/SKILL.md` |
| Coding skills | coding agents | `.claude/skills/**/SKILL.md` |
| Living plans | people and agents | `docs/research/*-plan.md` |
| Comments and doc comments | whoever edits next | the files around the change |
| Stage, skip and degrade messages | the user, in the build panel | `runner.skip(`, `record(`, `io.progress(` strings |
| Node graph labels and switches | the user | `packages/core/src/common/staged-build-graph.ts`, `staged-build-steps.ts` |
| Tests | CI | `packages/core/test/**` |

Search by name (`grep -rn`), then by meaning: a retired option is often described in words ("the earlier rules", "the
default when no services are wired") rather than by its name. Dated records (`docs/processes/` reports, changelogs)
describe their own day and stay as they are.

## Step 3: fix or flag

- Fix every living description in the same change.
- Flag what you cannot fix (another session's uncommitted work in that file, a choice that is the user's) in your
  report; never leave it silently.
- When a retired name may still be set somewhere (an environment, a saved workflow, a node graph), make the code say so
  when it meets it rather than ignore it, as `staged-switches.ts` `stagedSwitchProblems` does.

## Step 4: prove it

- Run `packages/core/test/instruction-tool-drift.test.ts`, which fails when AGENTS.md, the system prompt, the capability
  resolver or a skill names a tool that does not exist.
- Run `npm run docs:mcp:check` when a tool's declaration changed.
- Finish with one grep per old name, and explain any hit that remains.
