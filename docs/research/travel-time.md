# Travel time research: jumps and supercruise

Research for estimating "time to reach a station" from (a) the jump distance in
LY and (b) the station's distance from the arrival star in light seconds (ls).
Collected 2026-10-13. Each claim is labelled:

- **Measured**: someone timed it, or fitted a curve to timed data.
- **Code**: a constant or formula that ships in a tool. It may or may not be
  measured.
- **Inferred**: my own derivation or judgement. Treat it as a default to tune.

## Summary

| Quantity | Recommended default | Confidence |
| --- | --- | --- |
| Supercruise, arrival star to station drop | `t_sc(d) = 63 + 6.2 · d^0.43` seconds, `d` in ls (ed-mcp: `base_s` 43 plus 20 s expected occlusion) | Medium-high up to 20,000 ls. Fitted to one commander's journals (section 6). Overestimates beyond about 20,000 ls. |
| Seconds per hyperspace jump, chained, no scooping | 50 s | High. Measured minimum is 43.6 s. Measured median for a human pilot is 52 s. |
| Extra per refuel stop (scooping) | 120 s flat, or `30 s + tonnes / scoop rate` | Medium. Spansh uses 120 s. One journal fit gives about 36 s plus fill time. |
| SCO (Supercruise Overcharge) | Optional multiplier on `t_sc`, default 1.0 | Low. Large savings are measured. No short-range curve exists. |

A linear model ("N seconds per 150 ls") has the wrong shape. Supercruise time
grows roughly with the cube root of distance (power about 0.33). See
[Linear model check](#linear-model-check).

---

## 1. Supercruise time vs distance

### 1.1 Mechanics

- All ships have the same supercruise speed and acceleration. Mass, thrusters
  and FSD class or rating do not change them. Only turn rate varies by ship.
  Gravity wells set the speed cap. Sources: community consensus in Frontier
  forum threads (for example
  https://forums.frontier.co.uk/threads/do-thrusters-make-a-difference-in-supercruise.199236/)
  and the fandom wiki
  (https://elite-dangerous.fandom.com/wiki/Supercruise: "Turn rates are fastest
  at 50% throttle ... and are not affected by Thruster class"). These sources
  are older than SCO. Measured/consensus, not official.
- Maximum speed is 2,001c. It takes about 57 min to reach, away from all
  bodies (fandom wiki, Supercruise page). Speed is capped by distance to nearby
  masses. Heading toward a body lowers the cap.
- Safe drop: under 1 Mm (about 0.003 ls) from the target and under 1 Mm/s.
  After a safe drop the FSD has a 10 s cooldown (fandom wiki).
- **"7 second rule"**: full throttle until the ETA reads 0:07, then hold 75%
  throttle (the blue zone). The ETA then stays near 7 s while distance falls
  (fandom wiki; elitepve.com thread https://elitepve.com/viewtopic.php?t=7509).
  Inferred consequence: if `d/v` is held at a constant `tau`, distance decays
  exponentially, so the approach phase lasts about `tau · ln(d_start / d_drop)`.
  This adds a logarithmic term to the trip. Together with the acceleration
  phase, this explains why time grows sublinearly.

### 1.2 Published models and fits

**A. Fuel Rats `!sctime` (MechaSqueak / SwiftSqueak).** Code, fitted to measured
data. This is the most widely used formula. The source is Radlock's timing
spreadsheet, with "extra processing ... for v8" by NumberPi (2020), according
to the Fuel Rats knowledge base.

Source:
https://github.com/FuelRats/SwiftSqueak/blob/master/Sources/mechasqueak/Extensions/NumberFormatter.swift
(function `distanceToSeconds`, around lines 127-161, at commit 1225e47,
2026-10-03). The same formula is in
https://github.com/Delrynn/inline-sctime (`HexChat/inline_sctime.py`
`calcTotalSeconds`, `AdiIRC/inline-sctime.ini` `CalcTotalSeconds`; last commit
2026-01-10).

```swift
if distance < 100000 {
    seconds = 8.9034 * Double.pow(distance, 0.3292)
} else if distance < 1_907_087 {
    // -8e-23 x^4 + 4e-16 x^3 - 8e-10 x^2 + 0.0014 x + 264.79
} else {
    seconds = (distance - 5265389.609) / 2001 + 3412
}
if destinationGravity { distance /= 2 before, seconds *= 2 after }
```

Assumptions, from the Fuel Rats page: there are no gravity bodies on the path,
the main star is low mass, and the ship accelerates from the arrival point at
full throttle. The `-g` variant (destination has a gravity well) halves the
distance and doubles the time. This models deceleration into a second star.

**B. Fuel Rats measured table.** Measured: "time from acceleration start",
https://confluence.fuelrats.com/pages/viewpage.action?pageId=7635281 (created by
MasterLoon, last updated by SuperManifolds on 2025-04-28, credited to Radlock's
spreadsheet).

| Distance (ls) | Time (m:ss) | Seconds | Formula A (s) |
| ---: | ---: | ---: | ---: |
| 1,000 | 1:00 | 60 | 87 |
| 5,000 | 2:20 | 140 | 147 |
| 10,000 | 2:50 | 170 | 185 |
| 25,000 | 3:50 | 230 | 250 |
| 50,000 | 5:00 | 300 | 314 |
| 100,000 | 6:25 | 385 | 397 |
| 150,000 | 7:30 | 450 | 458 |
| 200,000 | 8:30 | 510 | 516 |
| 300,000 | 10:12 | 612 | 623 |
| 500,000 | 13:10 | 790 | 810 |
| 1,000,000 | 19:25 | 1165 | 1185 |
| 2,000,000 | 30:00 | 1800 | 1780 |
| 3,000,000 | 39:30 | 2370 | 2280 |

The page also lists the top speed reached (1030c at 300 kls, 1824c at
3,000 kls).

**C. My fits to table B, 1,000-200,000 ls only.** Inferred:

| Form | Fit | Residuals (s) |
| --- | --- | --- |
| Power | `t = 4.63 · d^0.386` | -7 to +16 |
| Square root | `t = 57.6 + 1.029 · sqrt(d)` | -30 to +12 |
| Log | `t = -565 + 83.3 · ln(d)` | -48 to +58 (poor; negative below about 900 ls) |

Power laws fit best. A pure log fails at the short distances that matter for
stations.

**D. Zoy's Excel regression, 2015.** Measured, but weak. Frontier forum,
2015-09-08:
https://forums.frontier.co.uk/threads/long-distance-supercruise-times-anyone-got-rough-numbers.151459/
gives `minutes = 8.6692 · ln(ls) - 92.826`. The fit is negative below about
45,000 ls. The timing ended when the ETA dropped below 15 s, so it is useless
for station distances. Other data points in that thread: 65 kls in about 8 min
and 360 kls in about 15 min (star to star, Ian Doncaster); 203 kls in just under
10 min (Asp); 500 kls in about 20 min. These are 2015 values, before later
supercruise tuning.

**E. Real-pilot journal data (EDDA, 2026).** Measured: one commander's own
journals, 2026-07-15 to 2026-09-09. Source:
https://github.com/terakilobyte/edda-app, file
`docs/benches/trade-timing-profile-2026-09-09-waldorf-all.csv`. The window is
arrival `FSDJump` (or `SupercruiseEntry`) to `SupercruiseExit`, with the
station's distance taken from the following `Docked`. The ships were mostly
SCO-era ships (Mandalay, Panther Clipper Mk II, Caspian).

| Station distance bucket | n | Median (s) |
| --- | ---: | ---: |
| < 100 ls | 63 | 100 |
| 100-500 ls | 77 | 146 |
| 500-2,000 ls | 101 | 131 |
| >= 2,000 ls | 109 | 146 |
| All (fit) | 350 | 148 + 0.49 s per 1,000 ls |

EDDA now ships `150 s + 0.5 s per 1,000 ls` (`crates/ed-route/src/cost.rs`,
`SUPERCRUISE_BASE_SECONDS`, `SUPERCRUISE_PER_KLS`). In real play, fixed costs
(turning away from the star, lining up, the approach, the drop) dominate inside
about 5,000 ls. The data shows almost no slope. This is one pilot, possibly
using SCO. It is evidence about overhead, not a general curve. EDDA's earlier
guess, `45 + 22 · ln(1 + ls)`, was retired because it overpriced the measured
loop (174/234 s modelled vs 98/139 s flown).

**F. Anecdotes.** Measured loosely, Steam threads: about 10-30 s for a station
100 ls away, and "2 or 3 minutes tops" within 5,000 ls. For Hutton Orbital
(about 6.8 M ls), 70-90 min is usual. These are consistent with A and B.

### 1.3 Supercruise Overcharge (SCO)

- SCO is available only on FSD (SCO) modules (Odyssey Update 18, April 2024).
  Boost sets top speed far above 2,001c. Up to about 6,000c is quoted, and it
  depends on drive class and ship.
- **Measured time saved:** with a class 7 SCO FSD, 182,000 ls takes 11:30 in
  normal supercruise and 5:30 with SCO. "For shorter jumps it can cut travel time
  to 1/10th or less." The source is the reddit post "Supercruise Overcharge - How
  good is it? (test results)", 2024-04-11,
  https://www.reddit.com/r/EliteDangerous/comments/1c17dlf/ , as cited on the
  fandom wiki (Frame Shift Drive (SCO) page). Leaving a planet's gravity well
  drops from 1-3 min to about 3 s (same page).
- **Measured speed and fuel:** CMDR Osiliran's spreadsheet, "Measured SCO
  Fuel/Hour and Speed Rates", Frontier forum, 2024-04-15, with updates to
  2026-02-25:
  https://forums.frontier.co.uk/threads/measured-sco-fuel-hour-and-speed-rates.624525/
  Before patch 18.06, max speeds were 3,150c (Corvette, Anaconda, Type-9),
  3,450c (Imperial Clipper) and 3,850c (Fer-de-Lance). Fuel burn was
  925-7,393 t/h. The fuel rate is driven by core fuel tank size: fuel/h is about
  `120 · FSD class constant · rating constant · ship constant ·
  2^(core tank size) · throttle constant`. Changing the loadout did not change
  speed or fuel rate. Heat needs heat sinks on older ships.
- A Steam SCO guide (https://steamcommunity.com/sharedfiles/filedetails/?id=3445518261)
  gives 4,200c and about 297 t/h for the Mandalay, and 3,075c for the Panther
  Clipper Mk II. The fandom wiki gives about 93 t/h for the Mandalay and about
  1,800 t/h for the Krait Mk II. Values vary by patch and rating.
- **Code:** inline-sctime has rough SCO fits for long range only (AdiIRC
  `CalcMandalaySeconds` / `CalcCaspianSeconds`):
  - Mandalay: `t = 0.000237255 · d + 13.9247` for `d >= 50,000 ls`, else a 25 s placeholder.
  - Caspian: `t = 0.000351263 · d + 12.7655` for `d >= 33,000 ls`, else 25 s.
  SwiftSqueak's `--sco <maxSpeed>` integrates a logistic speed curve:
  `v(t) = vmax / (1 + e^(-0.2443 (t - 24.30))) - 90.98` ls/s.
- **Ship dependence:** SCO is where the loadout matters. Speed, acceleration,
  heat and fuel depend on FSD class and rating and on whether the ship was built
  for SCO (Python Mk II, Type-8, Mandalay, Cobra Mk V, Corsair, Panther Mk II,
  Caspian, and later ships). Normal supercruise does not depend on loadout.
- No published short-range (under 10,000 ls) SCO curve exists. Pilots often
  pulse SCO for about 3 s to escape the star's gravity well. Boosting under about
  1,000 ls "is a guaranteed overshoot" (Frontier forum thread "Supercruise
  Overcharges Use Cases",
  https://forums.frontier.co.uk/threads/supercruise-overcharges-use-cases.624420/).

---

## 2. Time per hyperspace jump

### 2.1 Phase breakdown

Measured by CMDR Major Klutz, Frontier forum, 2017-05-28 (game 2.3):
https://forums.frontier.co.uk/threads/fsd-cooldown-and-jump-to-jump-timing.354764/

| Phase | Seconds | Notes |
| --- | ---: | --- |
| FSD charge | 15.0 | Fixed for all ships and FSDs. Nearby ships do not slow a hyperspace charge. |
| Countdown | 4.9 | Cannot be cancelled. |
| Hyperspace tunnel | 13.8 | Others report 13-16 s, depending on loading and network. Not distance dependent. |
| Arrival to FSD cooldown done | 9.9 | |
| **Total, button to button** | **43.6** | Others in the thread: 43, 44, 44. In 2.2 it was 48. Video check: 43.3-44.4. |

Alignment to the next target and fuel scooping can overlap the 10 s cooldown
and the 15 s charge. "If you can get around the star and re-fuel in those
25 seconds, you can hit the jump button every 44 seconds or 82 jumps/hour"
(same thread). The author could not keep this rate while scooping without
overheating.

Current-game check (2026): EDDA measured 1,222 `StartJump` to `FSDJump` pairs.
The median was 18.0 s and p90 was 19.0 s (`crates/ed-route/src/cost.rs`,
`JUMP_SECONDS`). The journal writes `StartJump` at the start of the countdown,
so this is countdown plus tunnel. That matches 4.9 + 13.8 = 18.7 s from 2017.
The fixed phases have not changed much.

### 2.2 Does it vary by ship or FSD?

- **Charge time:** no measured difference between ships, FSD classes, normal and
  SCO drives, or engineering. "There is no Fast Charge on FSDs, they all take the
  same time to charge for a jump" (Frontier forum thread "FSD V1 (SCO) -
  Pre-Engineered (SCO)",
  https://forums.frontier.co.uk/threads/fsd-v1-sco-pre-engineered-sco-im-confused.640970/).
  "Faster Boot Sequence" changes module boot time only, not charge time (fandom
  wiki). I found no patch note that changes hyperspace charge time for SCO
  drives. Consensus; I found no official statement.
- **SCO drives** heat up more while charging, especially near a star (fandom
  wiki; Caspian reports). This can force a pause while scooping.
- **Fleet carriers** are different: Spansh uses 20 min per jump.

### 2.3 Real-pilot cadence (includes human time)

| Source | What | Seconds per jump |
| --- | --- | --- |
| Major Klutz 2017 (measured) | Theoretical minimum, no pause | 43.6 |
| EDDA journal, 2026-07 to 2026-09 (measured, one pilot) | `FSDJump` to `FSDJump`, transit only, median (p25-p75) | 52 (46-62), n=122 |
| EDDA journal fit, 2026-09-02 (measured, one pilot) | Median plain gap per ship, 436 gaps | Mandalay 64, Caspian 74 |
| Spansh ship plotters (code) | Shown "estimated time" | 60 per jump + 120 per refuel |
| EDDA public default (code) | Flat model for unknown pilots | 60 per jump + 120 per stop |
| EDDA route ETA in the UI (code) | Reader projection | about 50 per jump |

Spansh source: the site bundle
`https://spansh.co.uk/assets/elite-dangerous-gui-4ce93861bd384bc982212db7e24f463c.js`
(fetched 2026-10-13), helper `elite-dangerous-gui/helpers/ship-time`:

```js
function journeyTime(e,t,l,r,i){ /* e = jumps, t = 60, l = 120 */
  for (...) { o++; e[n].must_refuel && a++ }
  return moment.duration({ seconds: o*t + a*l }).humanize() }
```

The templates call it as `(jumps, 60, 120)`. `carrier-time` uses
`(jumps, 1200, 25200)`, which is 20 min per jump plus 7 h per tritium restock.

### 2.4 Scooping

- Scoop rate depends on scoop size and rating, and on how close the ship is to
  the star. Max rates from the fandom wiki Fuel Scoop table: 3A 0.176 t/s,
  5A 0.577 t/s, 6A 0.878 t/s, 7A 1.245 t/s, 8A 1.680 t/s.
- A top-up of a few tonnes fits inside the cooldown and charge windows, so it
  adds about 0-10 s. A deep fill adds `tonnes / rate`.
- EDDA journal fit (measured, one pilot): a refuel stop costs about 36 s of
  approach overhead plus fill time. The first validation flight measured a stop
  at about 110 s in total. EDDA's flat public model uses 120 s per stop.

### 2.5 Neutron and white dwarf boosts

- A supercharge does not change charge, countdown or tunnel timing. It adds a
  dive into the jet cone. EDDA's UI estimate (code, not measured) adds 35 s to
  line up a neutron cone and 60 s for a white dwarf. EDDA measures a "dive extra"
  from `JetConeBoost` gaps but publishes no number.
- Range multipliers (fandom wiki): neutron ×4 and white dwarf ×1.5 for normal
  FSDs. The Mk II SCO (Caspian, 8A) gets ×6 and ×3. Each supercharge does 1% FSD
  damage, except on the Mk II SCO.

---

## 3. Existing route-time estimators

| Tool | Estimate? | Model | Source |
| --- | --- | --- | --- |
| Spansh ship plotters (neutron, galaxy, exact, road to riches) | Yes, "estimated time" | 60 s per jump + 120 s per `must_refuel` hop | Site bundle, `helpers/ship-time` (above) |
| Spansh fleet carrier router | Yes | 1,200 s per jump + 25,200 s per restock | `helpers/carrier-time`; page text "20 minutes per jump" |
| Fuel Rats MechaSqueak `!sctime` | Supercruise only | Formula A; `-g` halves the distance and doubles the time; `--sco vmax` uses a logistic integral | SwiftSqueak `NumberFormatter.swift` |
| inline-sctime (IRC plugin) | Supercruise only | Same as Fuel Rats, plus linear SCO fits for Mandalay and Caspian | github.com/Delrynn/inline-sctime |
| EDDA (Elite Dangerous Desktop Aid) | Yes, full legs | Jump 60 s (unfitted) or a fit from your journal; supercruise `150 + 0.5 s per kls`; undock 50/60/70 s by pad; docking 60 s; market 35 s | github.com/terakilobyte/edda-app `crates/ed-route/src/cost.rs`, `src-tauri/src/time_fit.rs`, `crates/ed-galaxy/src/long_range.rs` |
| supercruisetimer.xyz | Supercruise countdown | Not published; claims about 5% error | https://supercruisetimer.xyz/ |
| EDDiscovery | No estimator | Records past travel time only (`TravelledTimeSec`) | EDDiscovery `HistoryGrid.cs`, `ActionVars.cs` |
| EDMC / EDDI | No estimator found | n/a | GitHub code search, EDCD org |
| Inara | No estimator found | n/a | n/a |

---

## 4. Loadout dependence

| Factor | Affects jump time? | Affects normal supercruise? | Affects SCO? |
| --- | --- | --- | --- |
| Ship type and mass | No (fixed 15 s charge) | No (consensus) | Yes (ship-specific speed, heat and fuel factors) |
| Thrusters | No | No | No |
| FSD class or rating | No measured effect on charge | No | Yes (speed, acceleration, heat and fuel by class and rating) |
| FSD engineering (Faster Boot, Increased Range, Mass Manager) | No (boot time is not charge time) | No | Not measured |
| Guardian FSD booster | Range only, so it changes jump count, not seconds per jump | No | No |
| Fuel scoop size | Yes, via scoop time | n/a | n/a (SCO burns fuel fast, about 93-7,400 t/h) |
| Jump range | Changes the number of jumps | n/a | n/a |

Loadout matters through the number of jumps (range), scooping time, and SCO.
It does not change the fixed per-jump time.

---

## 5. Recommended model for the station-ranking tool

```
t_total = jumps · JUMP_SECONDS + t_sc(arrival_ls)

t_sc(d) = SC_BASE_SECONDS + SC_COEFF · d ^ SC_EXPONENT
```

| Constant | Default | Range to allow | Basis |
| --- | --- | --- | --- |
| `JUMP_SECONDS` | 50 | 44-75 | Measured: 43.6 s floor (2017), 52 s human median (2026). Spansh and EDDA use 60 s as a conservative value. ed-mcp ships with 60 s. |
| `SC_COEFF` | 8.9 | 4.5-9 | Measured fit (Fuel Rats formula A). 4.6 with exponent 0.386 matches table B. |
| `SC_EXPONENT` | 0.33 | 0.30-0.40 | Measured fit (Fuel Rats formula A) |
| `SC_BASE_SECONDS` | 20 | 0-60 | Inferred. Covers turning away from the star after arrival, lining up, and the drop. EDDA's real-pilot medians (100-146 s) suggest more overhead in practice. |
| `SCO_FACTOR` (optional) | 1.0 | 0.3-1.0 | Inferred. Measured savings are about 50% at 182 kls and up to 90% for short trips. No curve exists. |

If the tool knows only the straight-line distance in LY, the jump count is
`ceil(distance_ly / jump_range_ly)`. Add about 10% on long routes because real
routes are not straight. Add 120 s per expected refuel stop if fuel is modelled.
If the jump range is unknown, assume 1 jump for any target inside the range.

Values of `t_sc` with the defaults (seconds): 10 ls: 39; 100 ls: 61; 500 ls: 89;
1,000 ls: 107; 2,000 ls: 129; 5,000 ls: 168; 10,000 ls: 206; 50,000 ls: 336;
100,000 ls: 418. For distances over 100,000 ls, the Fuel Rats piecewise formula
is more accurate. Station-ranking cutoffs are rarely that far, so the simple
power law is enough.

### Linear model check

A model of "k seconds per 150 ls" (`t = k · d / 150`) has the wrong shape:

| d (ls) | Formula A (s) | `d/150` (k = 1) | Best line with intercept, fitted 100-10,000 ls |
| ---: | ---: | ---: | ---: |
| 100 | 41 | 0.7 | 63 |
| 1,000 | 87 | 6.7 | 77 |
| 5,000 | 147 | 33 | 138 |
| 10,000 | 185 | 67 | 214 |
| 50,000 | 314 | 333 | 821 |

- With no intercept, a linear model is about 10 times too fast under 5,000 ls.
  This is where almost all stations are.
- If you calibrate the slope to be right at about 1,000 ls (about 13 s per
  150 ls), it is wrong at 100 kls by about 25 times (8,700 s against 394 s).
- The best straight line with an intercept over 100-10,000 ls is about
  `62 s + 2.3 s per 150 ls`. It stays within about ±30 s in that range, then
  fails beyond it. If a linear form is required, use one with an intercept and
  limit it to `d <= 10,000 ls`.
- The one pilot's journal data (E) is nearly flat: about 148 s plus 0.5 s per
  1,000 ls. That is about 0.07 s per 150 ls. Overhead, not distance, dominates
  at bubble station distances.

### "About 50 s per jump" check

This is supported. The measured minimum is 43.6-44 s, from button to button,
with scooping and alignment hidden inside the cooldown and charge windows.
A measured 2026 human median is 52 s (p25-p75: 46-62 s). Both tools that
publish a constant use 60 s. That is conservative but reasonable for casual
pilots. Use 50 s by default. Use 60 s for a cautious estimate, and 44 s as the
floor. Add scooping separately.

---

## 6. Journal benchmark (2026-10-13)

Timings from one commander's journals (796 files from 2018 to 2026). Only
files from October 2024 onward are used, so the numbers reflect supercruise
assist, SCO-era ships and current docking. Medians include normal human
delays: finding the target, overshooting, waiting for docking permission.
**Measured.**

| Quantity | Median | n |
| --- | --- | --- |
| Jump cycle (FSDJump to FSDJump), no scooping | 52 s | 245 |
| Jump cycle with scooping | 64 s | 906 |
| SupercruiseExit to Docked: Coriolis / Orbis / Ocellus / Outpost | 87 / 78 / 83 / 54 s | 414 / 231 / 66 / 203 |
| FSDJump to SupercruiseExit at a station, 0-50 ls | 89 s | 81 |
| Same, 200-500 ls | 138 s | 102 |
| Same, 1,000-2,000 ls | 200 s | 81 |
| Same, 2,000-5,000 ls | 319 s | 21 |

A fit on the medians of equal-count bins gives `63 + 6.21 · ls^0.43`, with a
mean error of 10 s per bin. Stations near the star show no extra time beyond
the curve, so the near-star penalty is 0. Scooping adds about 12 s per jump,
because the FSD charges while scooping. Older journals (all years) show that
the curve overestimates far stations: 492 s measured against 643 s fitted at
38,000 ls. That is acceptable, because far stations should rank last.

ed-mcp defaults from this benchmark: `supercruise` `base_s` 43, `coeff` 6.2,
`exponent` 0.43 (43 plus 20 s expected occlusion gives the fitted 63);
`near_star.seconds` 0; `dock_s` 80; `refuel_s` 15.

Test flights by the same commander in an AX ship with no supercruise assist,
at full throttle with manual drops, set a lower bound:

| Station | Arrival | Supercruise | Docking | Curve |
| --- | --- | --- | --- | --- |
| Reed's Rest (Merope) | 4,042 ls | 244 s (about 215 s without a 25-30 s search and overshoot) | 70 s | 283 s |

A pilot who flies like this can set `speed_factor` to about 1.4.

## Sources

- Fuel Rats KB, Supercruise Travel Times (updated 2025-04-28):
  https://confluence.fuelrats.com/pages/viewpage.action?pageId=7635281
- FuelRats/SwiftSqueak `distanceToSeconds`, `timeToTravel`:
  https://github.com/FuelRats/SwiftSqueak/blob/master/Sources/mechasqueak/Extensions/NumberFormatter.swift
- Delrynn/inline-sctime: https://github.com/Delrynn/inline-sctime
- Frontier forum, "Long Distance Supercruise times" (2015):
  https://forums.frontier.co.uk/threads/long-distance-supercruise-times-anyone-got-rough-numbers.151459/
- Frontier forum, "FSD cooldown and jump to jump timing" (Major Klutz, 2017-05-28):
  https://forums.frontier.co.uk/threads/fsd-cooldown-and-jump-to-jump-timing.354764/
- Frontier forum, "Measured SCO Fuel/Hour and Speed Rates" (Osiliran, 2024-04-15 to 2026-02-25):
  https://forums.frontier.co.uk/threads/measured-sco-fuel-hour-and-speed-rates.624525/
- Reddit, "Supercruise Overcharge - How good is it? (test results)" (2024-04-11):
  https://www.reddit.com/r/EliteDangerous/comments/1c17dlf/
- Fandom wiki: Supercruise, Hyperspace, Frame Shift Drive, Frame Shift Drive (SCO),
  Fuel Scoop: https://elite-dangerous.fandom.com/wiki/Supercruise (read via the
  MediaWiki API on 2026-10-13)
- elitepve.com, "7 second rule for supercruise": https://elitepve.com/viewtopic.php?t=7509
- Steam SCO guide: https://steamcommunity.com/sharedfiles/filedetails/?id=3445518261
- EDDA (terakilobyte/edda-app), timing model and journal fits:
  https://github.com/terakilobyte/edda-app (`crates/ed-route/src/cost.rs`,
  `docs/benches/trade-timing-profile-2026-09-09-waldorf-all.csv`,
  `docs/benches/knobs/knobsearch.py`, `src-tauri/src/time_fit.rs`)
- Spansh site bundle, `helpers/ship-time` and `helpers/carrier-time` (fetched 2026-10-13):
  https://spansh.co.uk/assets/elite-dangerous-gui-4ce93861bd384bc982212db7e24f463c.js
- Frontier Journal Manual (StartJump is written at the start of the countdown):
  https://hosting.zaonce.net/community/journal/v32/Journal_Manual-v32.pdf
