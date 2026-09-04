---
status: accepted
---

# Attachments are inputs the caller hands the run, never a widening of the scope

A run may be given files from outside the scope root — a saved diff, a plan, a list of claims to
check — with `--attach <file>` (repeatable). They exist because 15 % of the real read-only
investigations in `docs/subagent-census.md` started from such a file, and every diff review did;
without them the only way to give scoutling a diff is to write it into the repo. An attachment is
an *input*: its text is placed in the prompt under a heading, it is never listed, searched or
read by a tool, and it never changes what `list_dir`, `grep` or `read_file` can see or what a
repo citation may point at. This is the opposite of widening the scope, and it must stay that
way — a parent agent trusts that everything a run *found* came from the scope root.

## Considered options

- **A fourth tool that pages through attachments.** Rejected for now: it adds a capability, so it
  would need ADR 0002's standard applied and a fourth tool for a small model to misuse; prompt
  placement keeps the tool set at three. Revisit only if real attachments prove too large for
  the prompt.
- **Copying attachments into the scope.** Rejected: it either writes into the caller's repo or
  fakes a scope root, and either way a citation into the diff would look like a citation into
  the code.
- **Letting an attachment path go through `resolvePath`.** Rejected: the containment check exists
  for paths a *model* or a *repo's config* supplies; an attachment path comes from the caller's
  own command line and is trusted like `--path` itself.

## Consequences

- Citations into an attachment use their own grammar, `@<name>:line`, where `<name>` is the
  attachment's basename. `@` cannot start a repo citation token, so an attachment can never
  shadow a file of the same name in the scope (`README.md` vs `@README.md`). Such a citation is
  verified against the attachment and reported in `sources` with `attachment: true`; it is a
  source, but never evidence about the scope.
- Attachments count against the model's context, not the tool-byte budget, so they are capped
  separately: `maxAttachmentBytes` (default 64 000, `--max-attach-bytes` to override). An
  attachment over the cap is refused with `BAD_ARGS` and a hint to split it — never silently
  truncated (the never-degrade-silently rule).
- Two attachments with the same basename are a `BAD_ARGS` error, since `@<name>` would be
  ambiguous.
- `--attach` is a caller-only surface. Config layers may not set it: a repo's committed
  `scoutling.config.json` handing the run a file from outside itself is exactly the kind of
  untrusted input DESIGN §6 exists to stop.
- The `no-write` gate is unaffected. Reading an attachment is a read.
