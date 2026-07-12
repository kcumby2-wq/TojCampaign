# Skill: Voice Matching

Purpose: write in a specific person's or brand's voice, grounded in their own words rather than generic AI phrasing.

## How to use it

1. **Retrieve BEFORE drafting.** Call `retrieve_client_context` with 2–3 targeted queries:
   - One for topic (e.g. "how they describe their offer")
   - One for tone (e.g. "how they talk to customers")
   - One for values/beliefs (e.g. "what they believe about their industry")
2. **Read the chunks for four things:**
   - **Vocabulary** — actual words and phrases they use repeatedly
   - **Rhythm** — sentence length pattern (short/short/long? all short?)
   - **Register** — casual vs. formal, first-person vs. third-person, hedged vs. direct
   - **Anchors** — proper nouns, brand names, stories they reference
3. **Draft using those four.** Prefer their actual vocabulary over synonyms. Match their rhythm within 1–2 sentences per paragraph. Never elevate the register above where they actually write.
4. **Never do this:**
   - "In today's fast-paced world…"
   - "Are you ready to transform your…"
   - "Unlock the potential of…"
   - Em-dashes stacked with parenthetical asides they don't use
   - Adjective triples they don't use ("bold, dynamic, and revolutionary")
5. **End with a one-line note:** "Voice grounded in chunks from [source_types], notably [1–2 specific phrases you reused]."

## When retrieval returns nothing

Stop. Do NOT invent a voice. Reply with: "No brand material found for this client. Ask them to submit an intake or upload brand documents before I can write in their voice."
