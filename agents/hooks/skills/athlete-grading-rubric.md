# Skill: Athlete Grading Rubric

Purpose: produce consistent, position-appropriate grades on athletes based on film, stats, and context. Load into The Grader. Designed to be compatible with Optimum grading platform formats for eventual API integration.

## The grading scale (0–100)

- **90–100** — Elite. P4 (Power 4) starter projection at their position. Rare.
- **80–89** — High-major. P4 depth or G5 starter projection. Clear scholarship-level athlete.
- **70–79** — Mid-major starter or G5 depth. FCS starter projection. Solid recruit.
- **60–69** — FCS depth, D2 starter, or JUCO-to-D1 track. Developmental prospect.
- **50–59** — D2 depth, D3, or NAIA. High school starter with college-level effort.
- **Below 50** — Not currently on a college-recruiting track based on this evaluation. Development-focused only.

**Do not inflate.** A generous grade hurts the athlete when reality catches up. Grade to what the film actually shows on this cut.

## The four grading dimensions

For any position, evaluate against these four:

1. **Physical (measurables + testing)** — height, weight, 40, shuttle, vertical, arm length where relevant. Ground in known combines / testing where available; note "unverified" where estimated.
2. **Technical (position-specific mechanics)** — the position-specific fundamentals (see position rubrics below).
3. **Football IQ (decision-making, situational awareness)** — reads, reaction time, pre-snap identification, effort between reps.
4. **Projection (frame + trajectory)** — where they are on their growth curve, room to add weight/strength, age relative to grade, injury history.

Compute the pillar score as a weighted average, weighted toward whichever dimension matters most for the position (e.g. QBs are IQ-heavy, OL is physical-heavy, WR is technical-heavy).

## Position-specific rubrics (representative — extend as needed)

### QB
Physical (20%): height ≥ 6'0" preferred, arm strength, mobility class (pocket / dual / spread)
Technical (30%): footwork, base, throwing motion, ball placement, touch by distance
IQ (35%): progression reads, pre-snap ID, RPO decisions, situational awareness
Projection (15%): frame growth, mechanical fixability, offense fit

### WR
Physical (25%): height, weight, 40, catch radius
Technical (40%): release package, route tree completeness, tracking, contested-catch technique, YAC
IQ (20%): route-conversion (option / vs coverage), pre-snap ID, effort as blocker
Projection (15%): age, growth trajectory, position projection (X / Z / slot)

### CB
Physical (25%): height, weight, 40, hip flexibility, recovery speed
Technical (35%): press technique, off-man mechanics, mirror ability, top-of-route play, ball skills
IQ (25%): route recognition, pre-snap ID, help-defender communication
Projection (15%): frame, versatility (outside / nickel), tackle willingness

### LB
Physical (25%): height, weight, 40, change of direction, physical stack strength
Technical (30%): reads (guards / RB path), take-on ability, tackle technique, coverage drops
IQ (30%): pre-snap ID, gap fits, coverage rotations
Projection (15%): growth, playmaker rate (TFL/sack/INT/FF)

### OL / DL
Physical (35%): height, weight, arm length, strength testing
Technical (35%): stance/step, hand usage, pad level, anchor, movement in space
IQ (15%): pre-snap ID, twists/stunts/combos
Projection (15%): frame, weight-to-athleticism ratio, position projection

## Output format

Every grade output uses this exact structure:

```
ATHLETE: [Name]
POSITION: [Primary / Secondary]
GRADE DATE: [YYYY-MM-DD]
FILM CUT: [source of the film being graded]

OVERALL: [XX/100]
PROJECTION: [P4 starter / P4 depth / G5 starter / G5 depth / FCS / D2-D3 / Development]

PHYSICAL: [XX/100] — [1-line evidence]
TECHNICAL: [XX/100] — [1-line evidence]
FOOTBALL IQ: [XX/100] — [1-line evidence]
PROJECTION: [XX/100] — [1-line evidence]

TOP 3 STRENGTHS:
1. [specific — cite a rep or a stat]
2. [specific — cite a rep or a stat]
3. [specific — cite a rep or a stat]

TOP 3 DEVELOPMENT PRIORITIES:
1. [specific — say what to work on and how you'd know it improved]
2. [specific — same]
3. [specific — same]

RECRUITING FIT NOTES:
- Schemes: [what offensive/defensive schemes fit this player]
- Level range: [range of programs realistic to target]
- Reach schools (worth putting on the board): [if any]
- Fit schools (highest match probability): [if any]

NEXT FILM CUT: [what would need to be captured for the next evaluation]
```

## When film is insufficient

If the retrieved film / stats / context doesn't support a specific evaluation dimension, **say so explicitly** — do not fabricate. Example:

> PROJECTION: insufficient data — no growth trajectory information on file. Need updated measurables (height / weight / testing) before a projection grade can be assigned.

## API-friendliness

This format is designed for downstream parsing. Every field is on its own line, uses consistent labels, and can be extracted with a simple regex or LLM structured-output pass. When Optimum integration is live, this output shape maps cleanly onto their evaluation fields.
