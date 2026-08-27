---
status: accepted
---

# Read-only is enforced by absence of capability, not by prompt

The model is never *asked* not to write; it is given no means to. The process has no
write/edit/shell/bash tool, and no tool implementation imports a filesystem write API. A prompt
instruction is only as reliable as the model following it — small local models, the whole point
of this tool, follow it least reliably — whereas a missing capability cannot be talked around.
This is why a "just add an `--allow-edit` flag" request must be refused: the moment the
capability exists behind a flag, the guarantee becomes configuration, and a parent agent can no
longer trust a scoutling answer came from a run that changed nothing.

## Consequences

- The `no-write` test (filesystem spy + adversarial prompt) is a permanent gate, not a nice-to-have.
- Child processes (the search binary) are outside the spy's view, so they get their own
  guard: search patterns are always passed as `-e <pattern> --` so a model-chosen pattern can
  never be parsed as a flag.
- Future tools (git log/blame/diff, symbols) are admitted only if they are read-only by the same
  standard.
