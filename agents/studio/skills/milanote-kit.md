# Skill: Milanote kit

How a production playbook becomes a Milanote kit: the method that built the Same Work kit on Oct 19, 2026, written down so it runs the same way every time.

## What a kit is

A kit is one Milanote board written out as **columns of cards**. People copy a card from the kit page and paste it onto their board, paste a link so Milanote makes a preview card, and drag the template images in. Milanote has no import and no public API, so the kit page is the hand-off: every card has to paste cleanly and make sense on its own.

The kit page is generated from what you stage. You never write HTML pages, only cards.

## Card types

| Type | Fields | Use it for |
|---|---|---|
| `note` | title, body | Almost everything: rules, roles, steps, looks, gear |
| `link` | title, url, body | One outside page we learn from. The body is the notes that sit under the preview card |
| `image` | title, img, body | A template image from `kit_templates`. The body says how to use it |
| `todo` | title, items | Checklists people tick on the day: shoot day, edit delivery, release |

**Body HTML:** only `<p>`, `<b>`, `<i>`, `<ul>`, `<ol>`, `<li>`, `<a href="https://...">`, `<code>`, `<br>`. No attributes except `href`. Milanote keeps bold, italics, lists and links when pasted; anything else is lost or breaks the paste.

**Limits:** up to 14 columns, 16 cards a column, 140 cards a kit. A card body over about 1,800 characters is long for one Milanote card: split it.

## Header fields (kit_set_meta)

| Field | Same Work example |
|---|---|
| title | Same Work Milanote Kit |
| eyebrow | Same Work · Coached by Hooks · production playbook |
| lead_html | The director and editor playbook, rebuilt as Milanote cards, with gear from Netflix's approved list, vintage looks, a graphics system and two new formats. Copy a card here and paste it onto the board. |
| board_name | Same Work: Production Playbook |
| stats_label | Rebuilt Oct 19, 2026 |
| footer_html | Rebuilt from `<i>`Same Work Production Playbook: Director and Editor`</i>` (Oct 17, 2026). New on Oct 19: ... The graphics system and the two new formats start next season, after Kyron and Hooks approve them. Sources are on the last card. |

## The column plan

Start from the Same Work order and adjust it to the source. The logic: why and the rules first, then what we learn from, what we make, how it looks, the graphics, the gear and software, each role's playbook, and the handoffs and sources last.

| # | Column | Color | What goes in it |
|---|---|---|---|
| 1 | Start here | Red | What the production makes, who owns what, the rules nobody breaks, what's new on this board (dated) |
| 2 | The feel | Blue | The vision in two short paragraphs, one link card per reference page, "What it adds up to" |
| 3 | The formats | Purple | One card per format. New formats say "(new)" in the title and when they start |
| 4 | The look and sound | Yellow | Shooting rules, base color look, looks board image, vintage looks and the honesty rule, sound, type |
| 5 | Graphics | Orange | The graphics system (proposed until approved), then one image card per template |
| 6 | Gear | Green | What the approval standard means, cameras, lenses, audio, light, specialty capture, media and backup |
| 7 | Edit suite | Teal | Software, look tools, settings, approved tools, not-approved tools, review and delivery |
| 8 | Director's playbook | Grey | Numbered steps: "1. Build the board", "2. ..." |
| 9 | Editor's playbook | Grey | Numbered steps |
| 10 | Handoffs and checklists | Grey | The steps with one owner each, what each handoff carries, to-do cards, then **Sources** last |

Milanote colors you can use: Red, Blue, Purple, Yellow, Orange, Green, Teal, Grey.

## The method

1. **Read the whole source first.** List every rule, role, process step, checklist, format and deadline in it. Each one has to land on a card. Trim words; never change meaning, and never drop a rule because it's long.
2. **Read the brief.** It says what to add on top of the source: references to study, a gear standard (e.g. Netflix's approved list), looks, graphics, new formats.
3. **Research what the brief asks for** with `web_search` and `web_fetch`. For every outside fact (a camera on an approved list, a spec, a price, a follower count, what a page does), keep the source URL and the date you checked it. If a page won't load (Instagram often shows a login wall), say so; don't guess what's on it.
4. **Plan the columns** (above), then **write one whole column per `kit_put_column` call.** That keeps the run inside its turn budget. Use `kit_put_card` for later fixes.
5. **Mark the rule cards `locked: true`:** who owns what, the rules nobody breaks, minors on set, tools that may not touch footage, what the editor never does, the honesty rule for looks.
6. **Run `kit_check`** and fix every blocker. Then finish.

## How a card reads

- **One idea per card.** The title says the idea: "Who owns what", "6. Minors on set", "Cameras".
- **Bold lead-ins** carry the structure: `<b>What it is:</b>`, `<b>Take this:</b>`, `<b>Use it for:</b>`, `<b>Leave this:</b>` on every reference link card.
- **Plain words, short sentences.** Numbers over adjectives. Name the tool, the setting, the owner.
- **Say who owns it** wherever a step has an owner (producer, director, editor, Hooks, the speaker).
- **Proposed is labeled proposed.** A new format, a new look or a graphics system says "(new)" or "(proposed)" in the title and, in the body, when it starts and who approves it. Looks change only between seasons.
- **Date what goes stale.** "Netflix's capture floor (Lensrentals, February 2026)". "About 12.6 million followers" goes with the date it was checked in the Sources card.
- **Checklists are to-do cards.** One action per item, written so it can be ticked.
- **Quotes are real or they're placeholders.** A line from a reference page is quoted only as the page says it. A template shows `[Their line, in their words]`, never an invented quote from a real person.

## The two cards every kit has

- **"What's new on this board (date)"** in the first column: what this version adds, in four bullets or fewer, and what waits for approval.
- **"Sources"**, the last card of the last column: every outside page and our own documents, grouped (reference pages, videos, gear and looks, our own documents), each with the date it was checked.

## Finishing

End with a short plain summary for Kyron:
- what the kit holds (columns, cards, images) or, for a refresh, exactly what changed and why;
- what you couldn't verify, and why (a page behind a login, a list that has moved);
- what needs a person: new template images a designer has to make, anything waiting on Kyron's or Hooks's approval, any rule you think should change (rule cards are never changed on your own).

Never put a banned word in the summary either, not even to say you removed one.
