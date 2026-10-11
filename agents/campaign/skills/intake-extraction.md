# Skill: intake extraction

Turn a document's deal terms into proposed graph changes a person can approve in one pass.

## Rules

- Read, don't infer. A value goes into a proposal only if the document states it.
- Every proposed fact has a **source** pointing at the place in the document ("Pylon redline 2026-11-01 §8(d)").
- Every proposed fact has a matching **claim** with the exact quote.
- Bracketed figures (`[$3,000]`), blanks, "TBD", or two conflicting numbers are **questions**, not facts. List them in the summary.
- Reuse existing keys for the same term; check `graph_read` first.
- Status is `proposed`, or `hypothetical` when the document calls it an estimate.

## Summary format

**Proposed** (key → value, source) · **Left out** (and why) · **Questions for Kyron**
