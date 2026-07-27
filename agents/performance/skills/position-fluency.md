# Position Fluency

The position-specific framing every coach-facing scout report uses. What metric to lead with, what pattern to name, what scheme to project the athlete into. Speak the position, not around it.

## The core seven positions (WR-first, extensible)

### WR — Wide Receiver (the Hooks specialty, the starting position)

**Lead metrics:** top speed, high-intensity running yards, sprint count, accel-to-decel ratio (route pattern signature).

**Signature reads:**
- **Burst profile** — high top speed (top-20% of age × position band), high % of measured max, few but efficient sprints, low overall volume. Projection: vertical / take-the-top / slot-fade / go-ball specialist.
- **Route-runner profile** — balanced A:D ratio (~1.0-1.2), high change-of-direction volume, mid-high top speed. Projection: comeback / hitch / stack-release / mesh-concept fit.
- **Volume / conditioning profile** — highest distance in cohort, highest session load, mid top speed but near-ceiling %. Projection: possession / underneath / rep-heavy scheme; run-first offenses that ask a lot of WR blocking.
- **Explosive load profile** — highest accel count, highest peak-force numbers (max accel avg ≥6.0), balanced A:D. Projection: motion-heavy schemes, jet-sweep / bubble-screen usage, physical route trees.

### RB — Running Back

**Lead metrics:** max acceleration (avg + peak), max deceleration (contact-adjacent proxy), accel count, sprint distance.

**Signature reads:**
- **Home-run threat** — high top speed + high sprint count. Big-play burst profile.
- **Between-the-tackles** — high max-decel (contact-adjacent), high accel count, moderate top speed. Physical downhill runner.
- **Third-down back** — balanced A:D, high change-of-direction volume, mid top speed. Passing-game / route-out-of-backfield fit.

### DB — Defensive Back (CB, S)

**Lead metrics:** top speed, change-of-direction speed (accel-to-decel transitions), high-intensity events, sprint count.

**Signature reads:**
- **Man-cover profile** — top-tier top speed, high sprint count, balanced A:D. Press / man-heavy scheme fit.
- **Zone-cover profile** — high change-of-direction volume, mid top speed, high HI-event count. Cover-3 / cover-4 fit.
- **Nickel / slot** — highest change-of-direction, high accel count, mid top speed. Match-up-per-motion nickel fit.

### LB — Linebacker

**Lead metrics:** max acceleration (contact-triggered), session load, HI-event count, change-of-direction speed.

**Signature reads:**
- **Downhill LB** — high peak accel + peak decel, physical volume, mid top speed. Run-fit / MIKE fit.
- **Coverage LB** — high top speed, high change-of-direction, high sprint count. Nickel-LB / hybrid safety fit.
- **Blitzer** — highest accel count from stationary, high peak-force, moderate volume. Pass-rush spec LB fit.

### QB — Quarterback

**Lead metrics:** pocket movement distance (delta between pocket-move sessions and dropback sessions), session load in scrambling reps, top speed on designed runs.

**Signature reads:**
- **Pocket passer** — low mobility metrics across sessions, high per-throw load. Half-field-read scheme fit.
- **Dual-threat** — high top speed + high accel count in scramble reps, moderate volume. RPO / zone-read scheme fit.
- **Athletic pocket QB** — mid mobility metrics, high peak accel when extending plays. Modern West Coast fit.

### OL — Offensive Line

**Lead metrics:** short-burst acceleration (2-4 yard bursts), peak force, session load in high-rep scenarios.

**Signature reads:**
- **Puller / zone lineman** — high accel count on shorter bursts, high change-of-direction. Outside-zone / puller-heavy scheme fit.
- **Gap / power lineman** — highest peak-force numbers, high session load, lower total volume. Inside-zone / gap / power fit.
- **Pass-pro spec** — balanced short-area movement, high session load without high peak-force. Pass-first-offense fit.

### DL — Defensive Line

**Lead metrics:** first-step acceleration (peak accel from stationary), peak decel (contact absorb), HI-event count in pass-rush reps.

**Signature reads:**
- **Speed rusher** — highest first-step accel, high top speed on angle rushes, low volume high intensity. Wide-9 / edge rusher fit.
- **Power rusher** — highest peak accel + peak decel paired, high session load, moderate top speed. 3-tech / 4-3 defensive tackle fit.
- **Two-way lineman** — balanced, high overall session load, mid peak numbers. 3-4 defensive end / 4-3 strongside end fit.

## Rules for reports across all positions

- **Lead with the position's headline metric.** Don't bury it below a generic "session snapshot" table.
- **Name the projection, don't hedge.** "Route-runner signature" is a real read; "shows some route-running potential" is a hedge.
- **Scheme-fit language when the signal is strong.** "Projects into offenses with heavy comeback / hitch usage" beats "would fit various schemes."
- **Don't force a signature if the data is noisy.** Sometimes the honest read is "balanced across metrics — no dominant signature yet at 3 sessions."

## Cross-skill

- Every coach-scout-reporter output uses this skill for the WHAT THE DATA SAYS ABOUT FIT block.
- Session report generator uses position framing lightly in the "WHAT THIS SESSION MEANT" block.
- Position framing is stored per athlete in the `athletes.position` column; the reporter looks it up on every run.

## When the position is unknown or non-standard

If the athlete's position is missing, note the gap and produce a position-agnostic profile with the raw metrics. Do NOT guess the position from the metric shape — that's a scout claim without evidence.
