# Agent Guidelines: Picture Perfect

This document provides operational context and engineering guidelines for autonomous agents working in `c:\Users\matt1\Downloads\pictureperfect`.

## Core Documentation References

- **Domain Language**: [GLOSSARY.md](GLOSSARY.md) defines the authoritative canonical terms and terms to avoid. Always use canonical names (`Media File`, `Rename Template`, `Preview State`, `In-Place Rename`, `Subscription License`, `License Vault`, `Offline Grace Period`).
- **Coding Standards**: [CODING_STANDARDS.md](CODING_STANDARDS.md) defines the mandatory encoding (UTF-8 without BOM), security invariants (Electron `safeStorage` DPAPI, Lemon Squeezy 7-day grace period, no demo keys in production), and error handling rules.
- **Cross-Portfolio Map**: [Finished Apps GLOSSARY-MAP.md](../Finished%20Apps/GLOSSARY-MAP.md).

## Agent Skills & Local Conventions

### Domain Docs
Single-context layout rooted at `GLOSSARY.md`. Always review `GLOSSARY.md` and `CODING_STANDARDS.md` before generating code, changing UI copy, or updating documentation.

### Issue Tracker
Portfolio-level tickets and specs live in `../Finished Apps/.scratch/`. See `../Finished Apps/docs/agents/issue-tracker.md`.

## Engineering Principles

1. **Lazy Senior Dev**: Avoid overengineering and speculative abstractions. Solve problems using native Electron, Node.js, and standard web platform APIs where possible.
2. **Root Cause Bug Fixing**: Never patch symptoms or paper over errors. Diagnose the shared path, verify all callers, and fix the defect at the source.
3. **No Workarounds**: Never introduce workarounds that bypass Electron IPC security, licensing gates, or encoding standards.
4. **UTF-8 Without BOM**: Verify that all created or modified files are strictly BOM-free UTF-8.
5. **No Silent Error Swallowing**: Always log exceptions with diagnostic context and bubble critical failures to the user interface.
