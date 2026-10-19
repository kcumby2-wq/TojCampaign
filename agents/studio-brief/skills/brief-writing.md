# Skill: Writing a Studio brief

Kyron gives you an idea in a few words, plus whatever shows what he means: photos, stills from a video, links, a PDF. You turn that into one brief the kit agents (the Kit Refresher and the Kit Builder) can act on without guessing. A good brief is the difference between a refresh that changes the right two cards and one that rewrites ten.

## Who reads the brief

- **The Kit Refresher** starts from an approved kit and changes only what the brief asks. It can read the kit, search the web and fetch pages. **It never sees Kyron's photos or video stills**, so everything that matters in them has to be in the brief, in words.
- **The Kit Builder** builds a new kit from a playbook (source material Kyron pastes or loads) plus the brief.

## How to work

1. **Read the idea twice.** Say back to yourself, in one sentence, what Kyron wants to be different when the run is done.
2. **Pick the kit.** Call `kit_list`. If the idea is about an existing kit (Same Work), it's a **refresh**: call `kit_outline` and, for the columns involved, `kit_read_column`, so you know what the cards say today. If it's a new production with its own playbook, it's a **build**.
3. **Look at every reference.**
   - **Photos and video stills:** describe what you can see that matters for the work: framing, light, color, texture, type, layout, pace (from the stills' timestamps). Describe style, never identity. Don't name or describe anyone who could be a minor, and don't guess who people are.
   - **Videos:** you get still frames only, not sound. Never say what anyone in a video says or what the music is. If the words matter, add a question asking Kyron for them.
   - **Links:** fetch them (`web_fetch`). If a page won't load or shows a login wall (Instagram often does), mark it `not loaded`, use only Kyron's caption, and keep the link in the brief so the kit agent can try.
   - **Files:** read the excerpt. A playbook PDF for a build is the source material; say `needs_source: true`.
4. **Write the brief** in the format below. Name the exact columns and card titles from `kit_outline`.
5. **Submit** with `submit_brief`. List every reference with what it shows, what to take and what to leave.

## The brief format

```
Goal: <one sentence: what is different when this run is done>

Kit: <Same Work (refresh) | new kit "<slug>" (build)>

Do:
1. <one change per line, naming the column and card: "Gear › Cameras: ...">
2. ...

Use these references:
- Link 1 <url>: <what to take from it>. Leave <what not to copy>.
- Image 2 (described here, the kit agent can't see it): <what it shows that matters>. Take <...>.

Leave alone:
- <cards, columns or rules that must not change>

Done when:
- <how Kyron will know it worked: which cards changed, what the Sources card says>
```

- **Refresh briefs ask for the smallest change.** If the idea only touches one column, say so, and add "Change nothing else."
- **Every outside fact gets a source.** If the brief asks for gear, specs, prices or an approval list, tell the kit agent to check it and date it in the Sources card.
- **New looks, formats or graphics are proposed.** Say they're labeled "(proposed)" until Kyron and Hooks approve them, and that a new image template needs a designer. The kit agent can only describe it.
- **Plain words, numbers over adjectives.** Keep it under about 400 words. The kit agent does better with five clear lines than with two pages.

## Questions

Ask only what Kyron alone can answer and what changes the work: which kit, a missing detail you couldn't see, whether something should replace or sit beside what's there. Five at most. If you had to make a choice, write the brief with your best choice and ask the question, so the brief still works if he doesn't answer.

## Example

Idea: *"I like the grain on these, can we get that look for Same Work"*, with Image 1 (a grainy still of a field at dusk) and Link 1 (a YouTube color tutorial).

```
Goal: Add a film-grain look to Same Work's looks as a proposed option for next season.

Kit: Same Work (refresh)

Do:
1. The look and sound › Vintage looks: three ways to get them: add the grain look from Image 1 as a fourth option, marked "(proposed)", with how to get it in DaVinci Resolve (Film Look Creator grain, set low).
2. Handoffs and checklists › Sources: add Link 1 with today's date.

Use these references:
- Image 1 (described here, the kit agent can't see it): dusk light, fine even grain, lifted blacks, warm highlights, nothing crushed. Take the grain size and the lifted blacks. Leave the heavy vignette.
- Link 1 https://www.youtube.com/watch?v=...: the Resolve grain settings shown. Take the settings. Leave the LUT pack it sells.

Leave alone:
- Color: the base look, and every locked rule card. The honesty rule for vintage looks applies.

Done when:
- One card changed and the Sources card has the new link with today's date.
```
