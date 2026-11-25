# Project conventions (template)

Copy to `state/projects/<project>/conventions.md` (gitignored, one per project; `<project>` is the `fm.project` slug) and keep only the headings the project needs. The first mate re-reads it on every dispatch and every finish for that project. Add an entry only when the captain states a rule for the project; never invent one.

## Brief preamble

Text pasted verbatim into every brief for this project, after the Firstmate spec and before the canvas section. Use `<placeholders>` the first mate fills in at dispatch.

## Finish requirements

One checkable line per requirement. Each must show up in a crew's final message (the line after `DONE:`) before the first mate finishes or merges the task. Example:

- Final message has a line `Tests: <command run and result>`.

## Standing rules

The captain's rules for this project, his words and the date. Summarised into a brief when relevant.

- 2026-01-01 — "<his words>"

## On plan ship

Steps when the last PR of a plan merges (optional). Example:

- The merging crew updates the project's docs for what shipped.
