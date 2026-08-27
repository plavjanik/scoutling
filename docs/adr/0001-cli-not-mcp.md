---
status: accepted
---

# Scoutling is a CLI, not an MCP server

A parent agent delegates one question and reads one answer; that is a one-shot subprocess
shape, not a persistent multi-endpoint service. We ship a CLI invoked as `scoutling "<question>"`
and deliberately do not ship an MCP server in v1: a daemon would need a supervisor, a port, health
checks and auth for something used ad hoc, and the AXI benchmarks show well-designed CLIs match
MCP on success rate at lower cost and fewer turns. A thin stdio MCP wrapper is cheap to add later;
it is gated on evidence of tight repeated-call bursts within a single session, which one-shot
investigation has not shown.

## Considered options

- MCP server (persistent, tool-per-call) — rejected for v1 as above.
- Both from day one — rejected: two surfaces to keep consistent before either is proven.
