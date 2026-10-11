# Skill: consistency check

The question for every deal term in a document: **does the graph say the same thing?**

## Order of work

1. Overview → graph (latest approved) → diff from the document's graph version if it is older.
2. Read the document top to bottom. Record each deal term as a claim.
3. Compare. Raise one finding per real disagreement.
4. Run `voice_check` and raise banned-word findings from its hits.

## What a good finding says

> **Schedule M ¶2** says "Pylon receives 50% after the SportsClippers fee". The graph (v2, `split.pylon.event_sales`) has 20% of net sale price, off the top, paid monthly. **Fix:** replace with "Pylon receives 20% of the net sale price, off the top, paid monthly."

Locator, quote, fact key and graph value, fix. Plain words.

## Severity

- **blocker**: wrong money, wrong party, wrong share, a missing required disclosure in a document a family or partner signs, anything that would mislead a signer.
- **major**: wrong date, stale term in an internal plan, arithmetic that doesn't add up.
- **minor**: wording, banned vocabulary in internal documents.

## Don'ts

- Don't raise a finding you can't point to.
- Don't "fix" the graph to match the document. If the document is right and the graph is wrong, say so in the summary; a person proposes the new version.
- Don't repeat a finding that `open_findings` already shows.
