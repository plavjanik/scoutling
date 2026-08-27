---
status: accepted
---

# Search uses the npm-bundled `@vscode/ripgrep`, not a system `rg`

On the reference machine `which rg` resolves to a Claude Code shell function that proxies to
Claude's own bundled ripgrep; from a Node `execFile` there is no `rg` at all. Depending on a
system binary would therefore have silently degraded to the slow, non-linear-time JavaScript
fallback on exactly the machine the tool was built on, and would have required a manual install
on every other machine. `@vscode/ripgrep` downloads a per-platform binary at install time, which
also gives Windows support for free. The JavaScript fallback remains only for the case that
download fails, and is capped (pattern length, per-file timeout) because it lacks ripgrep's
regex guarantees.

Do not "simplify" this back to `execFile("rg")` — it will appear to work in a Claude Code shell
and break everywhere else.
