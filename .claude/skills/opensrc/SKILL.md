---
name: opensrc
description: Look up dependency source code in opensrc/ for deep understanding of how packages work internally. Use when you need to understand a dependency's implementation (not just its types), debug unexpected behavior from a library, or find usage patterns in real source code. Triggers on "look at the source", "how does X work internally", "check opensrc", "fetch source for", or when library behavior is unclear from types alone.
---

# Source Code Reference

Source code for project dependencies is available in `opensrc/` for understanding implementation details beyond types and interfaces.

## When to use

- You need to understand **how** a package works, not just its API surface
- Library behavior is unexpected and types don't explain why
- You want real usage patterns or test examples from the library itself
- You're debugging an integration issue with a dependency

## Available sources

Check `opensrc/sources.json` for the list of fetched packages and their versions.

## Fetching new source code

If the package you need isn't in `opensrc/` yet, fetch it:

```bash
TMPDIR=/private/tmp/claude-501 npx opensrc <package>           # npm package
TMPDIR=/private/tmp/claude-501 npx opensrc pypi:<package>      # Python package
TMPDIR=/private/tmp/claude-501 npx opensrc crates:<package>    # Rust crate
TMPDIR=/private/tmp/claude-501 npx opensrc <owner>/<repo>      # GitHub repo
```

## Browsing source

After fetching, source lives under `opensrc/repos/`. Use Glob and Grep to navigate:

```bash
# Find a specific module
Glob: opensrc/repos/**/effect/src/internal/fiberRuntime.*

# Search for a pattern across the source
Grep: "serveEffect" in opensrc/
```

Focus on `src/` directories for implementation and `test/` directories for usage patterns.
