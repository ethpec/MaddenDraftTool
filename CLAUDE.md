# CLAUDE.md — Madden Draft Tool

Notes for future agents working on this repo. Read before making changes.

## What this is

A local web app that lets the user run a Madden NFL draft outside the
game so we can apply richer trade/pick logic, then export results in a
shape Madden can re-import. Python (Flask) backend, vanilla JS +
Tailwind-via-CDN frontend.

The user picks which team to control on the **setup screen** (defaults
to Steelers if available). The chosen team is stored on the session as
`user_team`. **There is no "force pick" mode** anymore — every Draft
button in the UI works for whichever team is currently on the clock
(see `submitPick` in `app.js` and `force_make_pick` in `draft_state.py`).
The user_team distinction is preserved for sim-stopping behavior, the
Trade Hub layout, and the Previous Selections rail.

Run with `python app.py` -> http://localhost:5050.

## Repo layout

```
app.py                       Flask entry, all HTTP routes
backend/
  data_loader.py             Parses xlsx/json from Files/<year>/
  draft_state.py             DraftSession: pick order, on-the-clock, trades
  logic.py                   Decision functions (mostly stubs today)
  exporter.py                Writes the three output xlsx files (+ zip)
templates/index.html         App shell (Tailwind CDN, dark theme)
static/js/app.js             All frontend behavior (single file, ~1000 lines)
static/css/app.css           Component styles layered on Tailwind
static/nfl_logos/            32 NFL team logos (city-nickname.png)
static/college_logos/        ~389 college logos (slugified name.png)
Files/
  TestFiles/                 Sample data (the only "year" today)
    BigBoard.xlsx            Draftable rookies + per-team rankings
    Player.xlsx              ~3960 existing players, 271 cols (huge)
    DraftPicks.xlsx          Pick order, ownership, year offsets
    GMInfo.xlsx              GM traits per team
    PositionNeeds.xlsx       Tier table for need calculation
    DraftPickValue.xlsx      Jimmy-Johnson value chart (Current+Future)
    DraftMaxPerPosition.xlsx Caps on draftees per position
    TeamInfo.xlsx            TeamNumber -> TeamName (authoritative)
    all_colleges.json        College reference data
    DraftToolLogic.docx      Original spec from the user
  <year>/                    Same shape; loader picks this if present
  <year>/Exports/            Generated outputs (gitignored)
```

## Critical things to know before editing

### 1. BigBoard != Player.xlsx
- **BigBoard.xlsx** = the draftable rookie class (~455 rows). Each row
  has every NFL team as a column with that team's private ranking of
  the player. We do not use those per-team columns in code — see
  `compute_team_big_board` below.
- **Player.xlsx** = current rosters of all 32 teams (~3960 rows, 271
  columns). Used to compute team needs and current-roster top OVR per
  position. We deliberately load only the columns listed in
  `PLAYER_COLUMNS_OF_INTEREST` (`data_loader.py`); loading all 271 is
  slow and pointless. Add columns to that tuple as logic needs them.

### 2. Team ID resolution
- `DraftPicks.xlsx` stores team identity as a 32-char binary string.
  The **lowest 8 bits** decode to a `TeamNumber` (0–36) that maps
  directly to `TeamInfo.xlsx` (`TeamNumber` column).
- `TeamInfo.xlsx` is the authoritative lookup: `TeamNumber → TeamName`.
  Rows with `TeamIndex >= 32` are non-team entries (AFC, NFC, Free
  Agents, Hall Of Fame, NFL Greats) and are filtered out in
  `data_loader.load_team_info`.
- `GMInfo.xlsx` uses its own `TeamIndex` (`[0..31]`) for GM traits —
  **don't** use it for pick-order team resolution.
- `DraftSession._build_team_name_map` is now a simple passthrough of
  the `team_info` dict loaded by `data_loader`.
- `exporter._encode_team_id` reuses a fixed 24-bit prefix observed in
  the sample data when writing CurrentTeam back out. If Madden
  re-import rejects the file, the fix is to preserve each row's
  *original* prefix instead of using a constant.

### 3. Logic — what's real vs. stubs
Most functions in `backend/logic.py` are documented placeholders. The
docstrings describe the real algorithm (GM trait influence on
trade-up/down propensity, BPA-vs-need mixing, Jimmy-Johnson value math,
future-pick discounting). **When implementing real logic, do not change
the function signatures** — `draft_state.py` and `app.py` already call
them with the documented arguments.

Implemented:
- `compute_team_big_board` — applies rank-scaled noise (±max(10, rank/2.5)
  spots, scaled by `BigBoardSkill`) starting from consensus `BigBoardRank`.
  `Can'tMiss` and `BlueChip` prospects (from `ProspectType` column in
  BigBoard.xlsx) have their downward swing capped. Called once per team at
  session start; boards stored on `DraftSession._team_boards` as
  `{team_name: [Player_ID, ...]}` and never re-randomized mid-draft.
  Per-team BigBoard columns are not used — team uniqueness comes from noise.
- `compute_team_needs` — for each PositionNeeds row, finds the Rank-th
  highest OVR player at that position on the team's roster (default 0 if
  fewer players than Rank). If that OVR falls in `[Roster OVR Min, Roster
  OVR Max]`, it is a need. `TrueWeight` is pre-computed once at session
  start in `DraftSession._weighted_needs` (DefaultWeight ± 25% random) and
  stays fixed for the draft. Roster updates as players are drafted — see
  section on roster mutation below.

- `sim_pick` — round-aware BPA vs. need decision engine. Each round
  (and each pick sub-range within round 1) has a `(bpa_prob,
  need_window, reach_limit)` bucket that sets the base probability of
  going BPA. The GM's `NeedvsBPA` trait (1–5) shifts that probability
  by ±10 pp per step from the midpoint. The need path filters
  `compute_team_needs` output to weights within `[need_window_min,
  need_window_max]` for the current round; it then scans the top
  `reach_limit` players on the team's board for a match. If no match
  is found within reach, falls back to BPA. Round-1 special case:
  skips QB via BPA if QB is not a current need. Returns a dict with
  `outcome`, `player_id`, and `rationale` describing the path taken.

- `_round_bucket(round_1, pick_in_round)` — returns `(bpa_prob, (need_window_min,
  need_window_max), reach_limit)` for a pick. Shared by `sim_pick` and the
  trade-down willingness check so both use the same need window.
- `_slide_prob(current_slot, rank)` — converts a board-slide ratio
  `(current_slot - rank) / current_slot` to a base probability component
  (caller scales by a round-based impact weight). Buckets:
  ≥ 0.40 → −0.05, ≥ 0.33 → 0.02, ≥ 0.25 → 0.15, ≥ 0.125 → 0.50,
  ≥ 0 → 0.70, < 0 → 1.00.
  (Negative ratios mean the player has slid past the pick, so willingness
  to trade down spikes; large positive ratios mean a top-tier talent is
  still available and the team should NOT trade down.)
- `_trade_down_probability(state, pick)` — computes willingness probability
  from two components, each weighted by a round-based impact factor:
  - **BPA slide** (×0.25 in round 1, ×0.50 in rounds 2–3, ×0.75 in rounds 4–7)
  - **Need slide** (×0.75 in round 1, ×0.50 in rounds 2–3, ×0.25 in rounds 4–7)
  Both components use `_slide_prob`. The rationale: round 1 picks are
  need-driven so a need-slide signal dominates; late rounds are BPA-driven.
  Sum + hot-zone bonus (pick 33 +15 pp; picks 30–32 / 34–35 +7.5 pp;
  picks 20–29 / 36–42 +5 pp), then × GM `TradeDown` trait multiplier ×
  `_portfolio_multiplier_down` (pick-rich teams less willing, pick-poor
  more — see helper below) × `_cooldown_for_events_since` (decaying
  cooldown based on drafts since last trade) × `_round_modifier_down`
  (R1 0.90×, R2-3 1.10×, R4-6 1.15×, R7 1.25×). Clamped to [5%, 95%].
  The cooldown counter lives on `DraftSession._events_since_trade_per_team`
  (dict[team] = int). Reset to 0 by `_execute_cpu_trade`,
  `accept_trade_down_offer`, and `submit_user_trade_up` (when the target was
  on the clock). Incremented by `_record_selection` for the team that drafted.
- `_cooldown_for_events_since(n)` — returns the trade-down cooldown multiplier:
  `n is None` (team has never traded) → 1.0×; `n == 0` (just traded) → 0.5×;
  `n == 1` (1 draft since) → 0.75×; `n ≥ 2` → 1.0× (fully restored). Forces
  ~2 drafts between trade-downs instead of allowing trade-draft-trade patterns.
- `willing_to_trade_down(state, pick)` — rolls against `_trade_down_probability`.
  Called once per pick in `_ensure_pending_offers`; the result is cached in
  `DraftSession._trade_down_willing` so CPU and user trade paths share the
  same answer for the current on-clock pick.
- `_roll_trade_threshold(round_1, is_trade_up)` — rolls a multiplier from a
  round-keyed table. `is_trade_up=True` adds a fresh random offset drawn
  from uniform `[-_TRADE_UP_OFFSET, +_TRADE_UP_OFFSET]` (currently ±0.049)
  so each offering team gets a different M_up even on the same base bucket.
  Trade-down team rolls M_down once per pick (cached on session as
  `_trade_down_m_down`); trade-up teams roll M_up per offer.
- `_trade_up_probability(state, gm, target_pick)` — willingness probability
  for an offering team to trade up to `target_pick`. Components combined
  multiplicatively: `(bpa_prob + need_prob)` (each scored by `_slide_prob_up`
  × the same round-based impact weights used by `_trade_down_probability`:
  Round 1 bpa 0.25 / need 0.75; Rounds 2-3 balanced; Rounds 4-7 bpa 0.75 /
  need 0.25) × GM `TradeUp` trait multiplier (0.75–1.25×) × `_distance_multiplier`
  × `_portfolio_multiplier` × `_round_modifier_up`. Clamped to [0.1%, 50%].
- `_round_modifier_up(round_1)` — trade-UP round multiplier: R1-2 1.00×,
  R3-5 1.10×, R6-7 1.15×. Boosts late-round trade-ups since those picks
  change hands more freely.
- `_round_modifier_down(round_1)` — trade-DOWN round multiplier: R1 0.90×,
  R2-3 1.10×, R4-6 1.15×, R7 1.25×. Dampens round 1 (teams hold R1 picks
  tightly) and boosts late rounds significantly.
- `_slide_prob_up(current_slot, rank)` — base trade-up probability component
  (caller scales by impact weight). Buckets: ≥ 0.33 → 0.40, ≥ 0.25 → 0.20,
  ≥ 0.125 → 0.05, ≥ 0 → 0.0, < 0 → −0.25. Negative ratios (target below the
  player's rank) penalize willingness.
- `_distance_multiplier(value_ratio)` — dampens trade-up willingness based on
  how close the offering team's highest remaining current-year pick is to the
  target *in value* (Jimmy-Johnson chart auto-normalizes across rounds).
  `value_ratio = team_high_val / target_val`. Caps at 1.0× (no boost), drops
  toward 0.125× as the team gets further from the target. Buckets tuned in
  the function body.
- `_portfolio_multiplier(share)` — for trade-UP willingness. Scales by the
  team's share of remaining current-year picks across the league. `share =
  team_remaining / total_remaining`. Baseline (1.0×) is set at 4% share —
  above the ~3.1% league average (1/32), so most teams fall in the
  0.625–0.875× range. Pick-rich teams (≥ 5%) hit 1.25×; very pick-poor teams
  (< 2%) drop to 0.50×.
- `_portfolio_multiplier_down(share)` — top-to-bottom flip of the trade-up
  version, used by `_trade_down_probability`. Pick-rich teams hit 0.50×
  (they don't need more picks), pick-poor teams get up to 1.25× (eager to
  acquire). Same share buckets, multipliers reversed.
- `generate_trade_offers_for_pick(state, pick, m_down)` — builds CPU offers.
  For each other team that passes `_trade_up_probability` AND whose rolled M_up
  ≥ m_down, enumerates (offered, return) combinations subject to:
    - 1 ≤ |offered| ≤ 3, 0 ≤ |return| ≤ 2, net pick count for trade-down in [0, 2]
    - `m_down ≤ offered_val / (target_val + return_val) ≤ M_up`
    - offered package anchored on team's highest-value current-year pick
      (`P_high`) OR — when their future-pick gate passes — their highest-value
      future pick whose value < 1.1× target's value (`F_high`; small overshoot
      tolerated since the trade-down team can balance with a small return pick)
    - 3-pick offers consisting of the team's **next 3 eligible current-year
      picks** are rejected (too aggressive to surrender all near-term picks)
    - future picks in the offered package must be from a round ≥ the
      target-round floor: round-1 target → no floor (any round); round-2
      target → round 2+ (no future 1sts allowed); round-3+ target →
      `target_round − 1`.
    - each side capped at 1 future pick AND gated by independent future-pick
      rolls: trade-up side `_FUTURE_PICK_GATE_UP` (15%), trade-down side
      `_FUTURE_PICK_GATE_DOWN` (10%)
  Returns offers sorted by ratio `offered/(target+return)` descending (tie-
  break: fewer total picks). Caller (`_ensure_pending_offers`) is responsible
  for rolling/caching `m_down`.
- `select_trade_down_offer(offers)` — applies the on-clock CPU's personality
  to choose which offer to accept. Rolls one of: **max_ratio** (40%),
  **max_value** (40%, highest `offered_val − return_val`), **nearest_pick**
  (10%, smallest distance from target to the closest current-year offered
  pick), or **furthest_pick** (10%). The offers list is already ratio-sorted
  for UI display; this selector only affects CPU-on-clock acceptance — user
  Trade Hub still shows them ratio-sorted for manual review.
- `_best_offer_for_team` — inner helper that picks each offering team's
  single best combo. Two layered rolls:
    1. **Complexity tier** (`_roll_complexity_tier`): 85% small (max 2 offered,
       max 1 return) / 10% medium (max 3 offered, max 1 return) / 5% large
       (max 3 offered, max 2 return). If no valid combo exists at the rolled
       tier, escalates to the next tier until one is found or tiers exhaust.
    2. **Selection mode** (`_roll_selection_mode`): one of six modes —
       min_cost 20% / min_ratio 20% / max_cost 12.5% / max_ratio 12.5% /
       min_value 30% / random_deal 5%. The chosen mode is applied to the
       full pool of valid combos at the resolved tier (see `_select_combo`).
       All deterministic modes tiebreak on fewer total picks; `random_deal`
       skips the tiebreak. This produces visibly different offer "styles"
       across the league (cheap-and-clean vs. generous vs. random).
  The tier roll biases the league heavily toward 1-for-2 and 2-for-2 deals;
  3-for-3 trades only happen when a team rolls into the 5% top tier or
  escalates there because their portfolio doesn't fit the smaller tiers.
- `attempt_user_trade_up` — calculates offer/target values; acceptance logic
  lives in `DraftSession.submit_user_trade_up` (which uses the cached `m_down`).
- `attempt_user_trade_down(state, m_down)` — delegates to
  `generate_trade_offers_for_pick` for the user's on-clock pick. Trade Hub
  "Incoming Offers" is fully wired (see section 5a for the flow).

### 3a. Roster mutation during the draft
When a player is drafted (`DraftSession._record_selection`), their entry in
`data["players"]` (Player.xlsx roster) is updated in-place: `TeamIndex` is
set to the drafting team's GMInfo `TeamIndex`, and `ContractStatus` is set
to `"Signed"`. This makes `compute_team_needs` reflect the pick on the next
call without any re-load.

The lookup uses a pre-built dict `DraftSession._roster_lookup` keyed by
`(FirstName, LastName, PLYR_DRAFTROUND, PLYR_DRAFTPICK)` for O(1) access. Rookies
in BigBoard already carry `PLYR_DRAFTROUND`/`PLYR_DRAFTPICK` from `keep_cols`
in `load_big_board`, so the key matches Player.xlsx directly. If a player
isn't in the roster (no Player.xlsx entry), the update is silently skipped.

### 4. Year folders
The user picks a year on the setup screen. `data_loader.resolve_year_folder`
looks for `Files/<year>/` and falls back to `Files/TestFiles/` if
missing. `list_available_years()` is what populates the dropdown — it
scans `Files/` for subdirs (excluding `Exports`).

### 5. User-controlled team (set at startup)
- The setup modal shows a 4-column grid of NFL logos. The user clicks
  one and that name is sent as `user_team` in
  `POST /api/session/start`. `DraftSession.__init__(data, user_team=...)`
  validates the name against GMInfo and falls back to Steelers, then to
  the first available team.
- The user-team setting controls:
  - **Sim-stopping**: `sim_until_user` stops the moment the user team is
    on the clock; `sim_until_round` stops at the first user pick of the
    target round.
  - **Trade Hub layout**: when the user is on the clock, the modal shows
    "Incoming Offers" + "Offer Manual Trade"; when an AI team is on the
    clock, the modal opens directly into a trade-up form with the
    on-clock pick pre-selected as the target.
  - **Previous Selections rail**: shows whichever team is currently on
    the clock, not the user team specifically. (Same for Team Needs.)
  - **Team Needs filtering**: `_team_needs` in `app.py` filters the
    returned needs to those whose `TrueWeight` falls in the current
    round's need window OR the next round's window (using
    `logic._round_bucket`). Surfaces only round-appropriate needs to
    the UI. Round 7 only uses its own window.
- `sim_until_end` deliberately **ignores** the user team — it pushes
  through every remaining pick, AI-filling the user team's slots too,
  for end-of-draft convenience.

### 5a. CPU trade-down flow

When a CPU pick is simmed (`_sim_one_locked`):
1. `_ensure_pending_offers()` lazily rolls willingness + M_down, then generates
   offers (keyed by `overall`; not re-generated until the pick changes).
   Both `_trade_down_willing` and `_trade_down_m_down` are cached on the session.
2. Each generated offer is built within the rolled `[m_down, m_up]` window AND
   the pick-count constraints — see `generate_trade_offers_for_pick` above.
   Offers may include `return_picks` (the on-clock team sending picks back to
   balance value when the offering team's package overshoots their M_up).
3. `_best_qualifying_cpu_offer()` delegates to `logic.select_trade_down_offer`,
   which rolls a **personality mode** (40% max_ratio / 40% max_value /
   10% nearest_pick / 10% furthest_pick) and applies it to the pre-filtered
   offer pool. The selected offer is what executes.
4. If a qualifying offer exists, `_execute_cpu_trade()` swaps ownership of the
   target + return picks + offered picks (bidirectional) and appends a
   `TradeRecord` before `sim_pick` chooses the player.
5. The sim response includes a `"trade"` key with the summary; the UI toasts it.

When the user submits a trade-up offer (`submit_user_trade_up`):
- For the current on-clock pick, `_ensure_pending_offers()` is called first;
  the cached `_trade_down_willing` + `_trade_down_m_down` results are reused.
- For non-current picks, `willing_to_trade_down` and `_roll_trade_threshold`
  are rolled independently (one-shot, not cached).
- The user can also request picks back (`target_also_sends_overalls`); the
  acceptance ratio accounts for them: `offer_val / (target_val + return_val)`.
- If willing: accepted when ratio `≥ m_down` AND user's net value
  (`offer_val − return_val`) is `≥` the best competing CPU offer's net value
  (only checked when target is the current on-clock pick).
- Declined with a reason and the threshold value so the UI can show it.

User trade-down (Trade Hub "Incoming Offers") goes through `_ensure_pending_offers`
with the same caching: when user is on the clock, willingness defaults to True
and the cached `_trade_down_m_down` is set to 0.0. Inside
`generate_trade_offers_for_pick`, the user-on-clock case (detected via
`on_clock_team == user_team`) substitutes a **per-team floor** of
`max(_USER_TRADE_DOWN_HARD_FLOOR, m_up - _USER_TRADE_DOWN_FLOOR_OFFSET)`
(currently `max(0.95, m_up - 0.05)`) — the relative offset keeps each AI's
window ≥ 5 pp wide; the hard floor blocks anyone from sending a sub-0.95×
ratio to the user regardless of how low their m_up rolled. The user picks one in the UI;
`accept_trade_down_offer(from_team)` looks up the cached offer by team name
and calls `_apply_trade` with `USER` as initiator. No auto-acceptance — the
user always decides.

**No chained trades on the just-traded pick.** After a user-accepted trade,
`_pick_must_select` is set to that pick's overall. `_sim_one_locked` checks
this flag and skips the auto-trade phase for that one pick (the new owner
must select a player). `submit_user_trade_up` also rejects re-acquiring the
flagged pick. The flag clears in `_advance` once a player is selected. Other
picks that moved in the trade (offered/return) remain freely tradable when
they later come on the clock.

`_trade_down_willing`, `_trade_down_m_down`, and `_pick_must_select` are
all cleared in `_advance()` alongside pending offers.

### 6. Single global session
`app.py` keeps **one** `DraftSession` in module-level state. There's no
multi-user support — this is a local single-user tool by design. Don't
add session IDs or auth without asking. Restarting the server wipes
state; the user is expected to export before quitting.

### 7. Logos
- **NFL logos** in `static/nfl_logos/` are named `city-nickname.png`
  (e.g. `pittsburgh-steelers.png`). GMInfo only carries the nickname,
  so `data_loader.build_nfl_logo_map` uses an explicit
  `nickname -> slug` table for the 32 franchises (handles cases like
  `Cardinals`/`Panthers` where the nickname alone is ambiguous
  historically). The map is stored on the loaded data dict as
  `nfl_logo_map` and surfaced by API responses as `current_team_logo`,
  `original_team_logo`, `user_team_logo`.
- **College logos** in `static/college_logos/` are slugified college
  names. `data_loader.slugify` is the single source of truth: lowercase,
  `&` -> `and`, drop apostrophes, anything else non-alphanumeric -> `-`.
  About 380/488 colleges from `all_colleges.json` have files; the rest
  return `None` and the UI shows a dashed placeholder.
- BigBoard rows do not carry the college directly. We join to
  Player.xlsx by `(FirstName, LastName)` in `load_all` to resolve each
  rookie's `College` (a binary ID) -> college name -> logo URL. That
  result is stored on the BigBoard player dict as `college`,
  `college_logo`, and `position`. **Don't** ship API responses that
  expose the raw binary `College` value — always pass it through
  `build_college_id_to_name`.

### 8. The export step always re-runs
`/api/export/download/<kind>` re-runs `export_session` (or
`export_session_zip` for `kind=zip`) on every call so the file reflects
current state. This is intentional — the user can download mid-draft.
Don't cache output paths. `exporter.export_session_zip` bundles all
three xlsx outputs into a single `DraftExport.zip` and is what the UI's
Export button hits today.

### 9. Position aliases (frontend-only, Big Board modal)
Madden stores split positions (`LE`/`RE`, `LG`/`RG`, `LT`/`RT`,
`LOLB`/`ROLB`, `MLB`, `HB`) but the Big Board modal exposes the
conventional grouping (`END`, `OG`, `OT`, `OLB`, `ILB`, `RB`). The
mapping lives in `POSITION_ALIASES` (`static/js/app.js`):
- `QB`, `FB`, `WR`, `TE`, `C`, `DT`, `CB`, `SS`, `FS`, `K`, `P` map 1:1.
- `RB → [HB]`, `OG → [LG, RG]`, `OT → [LT, RT]`, `END → [LE, RE]`,
  `OLB → [LOLB, ROLB]`, `ILB → [MLB, ILB]`.
- The display order in `POSITION_ORDER` is the user-specified order:
  `QB, RB, FB, WR, TE, OG, OT, C, END, DT, OLB, ILB, CB, SS, FS, K, P`.

The filter logic uses these aliases to expand a clicked pill into the
set of raw positions that count. Individual rows still show the raw
Madden code in their subtitle (e.g. `LE · Alabama`).

## Frontend conventions

- Vanilla JS, no build step. Add new behavior in `static/js/app.js`.
- State lives in two places: the main `state` object at the top of
  `app.js` (session, board, publicBoard, etc.) and small per-feature
  state objects (`setupState`, `bigBoardState`, `pickerState`). Renders
  are full-subtree rebuilds from state — don't try to do incremental
  patching, the data is small enough.
- All API calls go through the `api.get` / `api.post` helpers.
- Tailwind classes inline; `static/css/app.css` is for things awkward
  to do inline (animations, scrollbars, hover states).
- The dark theme uses custom Tailwind colors (`ink-*`, `accent-*`,
  `field-*`) configured in `<script>tailwind.config = {...}</script>`
  inside `index.html`.
- **Modal pattern**: everything reuses the single `#modal-root` element.
  Each modal sets a class on it (`big-board-modal-open`,
  `full-board-modal`) which CSS uses to size/style the dialog. Always
  remove all of those classes in `closeModal`.
- **Confirm dialogs**: use `confirmAction({ title, message,
  confirmLabel, onConfirm })` for any destructive or "you sure?"
  action. Used by Sim to Round, Sim to End of Draft, and Sim to Pick
  (click on a future pick cell). **Don't** use the browser's native
  `confirm()`.
- **Universal Draft buttons**: every Draft button in the UI (public
  board, team big board, Big Board modal) routes through `submitPick`,
  which hits `/api/pick/force-make`. Don't add separate "user pick" vs
  "AI override" paths.

## UI layout

- **Header (sticky)**: brand + year, **Big Board** pill (left side),
  **Trade Hub** pill (always available — has a ringing-phone SVG
  icon and a red badge showing incoming-offer count when the user is
  on the clock), then sim controls on the right (Sim Pick, Sim to My
  Pick, Sim to Round dropdown, Full Draft Order, Export).
- **Left column**: On The Clock (logo + team + pick meta), Last
  Selection, Team Needs, Previous Selections.
- **Center column**: Current Round grid (with click-to-sim on
  unselected future picks).
- **Right column**: Team Big Boards (per-team picker, shows the user's
  team by default; rows have Draft buttons when a pick is on the
  clock).
- **Big Board modal**: header row with on-clock info + sort toggle +
  show-drafted checkbox + search; horizontal position pill bar
  (`POSITION_ORDER`); scrollable list of players. Sort by Consensus
  (default) or My Team. Show drafted defaults off.

## API surface (current)

```
GET  /api/years                          List Files/* folders
GET  /api/teams?year=<y>                 Team list for a year (logos + names) — used by setup screen
POST /api/session/start                  { year, user_team } -> bootstrap session
GET  /api/session                        Current session summary (includes last_pick, user_team_logo)
GET  /api/board                          All picks (with team logos)
GET  /api/big-board/public               Mel Kiper consensus board (all rookies)
GET  /api/big-board/team/<team_name>     One team's private board (with team_rank/original_rank/consensus_rank)
GET  /api/needs/<team_name>              Computed needs list
GET  /api/gm-info                        All GM trait rows
GET  /api/trades                         Trade log
POST /api/pick/make                      { player_id } — user-team-only pick (kept for legacy; UI uses force-make)
POST /api/pick/force-make                { player_id } — universal pick for whoever's on the clock
POST /api/pick/sim                       Sim the current AI pick
POST /api/pick/sim-until-user            Sim until the user team is on clock
POST /api/pick/sim-until-round           { round } — stops at first pick of target round
POST /api/pick/sim-until-overall         { overall } — stops with that pick on the clock
POST /api/pick/sim-until-end             Drives the draft to completion (ignores user-team)
GET  /api/trade/down-offers              AI offers for user's pick (only valid when user on clock)
POST /api/trade/up                       { target_overall, offered_overalls }
POST /api/trade/accept-offer             { from_team } — user accepts a cached AI trade-up offer
POST /api/export                         Write all 3 xlsx files + zip
GET  /api/export/download/<kind>         kind = outcome | picks | trades | zip
```

## When you make changes

- **Don't** load the full Player.xlsx column set — keep the projected
  column list in `PLAYER_COLUMNS_OF_INTEREST` and grow it intentionally.
- **Don't** invent multi-session/auth/persistence. This is local-only.
- **Don't** change `logic.py` function signatures unless you also update
  the callers in `draft_state.py` and `app.py`.
- **Don't** reintroduce force-pick mode or per-Draft-button gates by
  user-team — there is exactly one Draft path (`submitPick` -> 
  `/api/pick/force-make`).
- **Do** match the existing dark/gold visual language when adding UI.
- **Do** use `confirmAction` for any sim/export action that's destructive
  or large in scope — don't fire automatically on dropdown change.
- **Do** smoke-test by starting `python app.py` and hitting at least:
  start session as a non-Steelers team -> sim a few -> open Big Board ->
  draft from it -> sim to end of draft -> export. Any of those breaking
  is a regression.

## Team-board consensus delta (frozen at session start)

In the right-rail team big board, each row shows `team_rank (orig_rank)`
on the left and `#consensus (±delta)` on the right where:

- `delta = consensus_rank - original_rank` (i.e. compared to the team's
  *session-start* rank, NOT its currently displayed `team_rank`).
- **Positive (green)** = team had him higher than consensus.
- **Negative (red)** = team had him lower than consensus.

This delta is frozen for the entire draft — it does not shift as
players get drafted. The dynamic `team_rank` column changes (it's the
current rank among undrafted players), but the parenthesized delta
stays the same. See `renderConsensusDelta` in `app.js`.

## Open work / known gaps

- BPA/need probability tuning in `sim_pick` — the round/pick-bucket
  values (`bpa_prob`, `need_window`, `reach_limit`) are initial guesses
  and will be refined based on play-testing.
- CPU trade probability tuning — `_slide_prob` / `_slide_prob_up` bucket
  thresholds, hot-zone bonuses, `_TRADE_THRESHOLD_TABLE` probabilities,
  `_TRADE_UP_OFFSET` (±0.049, applied as a uniform random offset per offer),
  `_FUTURE_PICK_GATE_UP` (0.15) / `_FUTURE_PICK_GATE_DOWN` (0.10), and the complexity
  tier weights (0.85/0.10/0.05) are initial guesses; refine via play-testing.
- Per-row prefix preservation in `exporter._encode_team_id` if Madden
  re-import rejects the heuristic prefix.
- Trade-value heuristics in `logic.pick_value` work; pick value lookup
  uses 0-indexed `Pick` column in `DraftPickValue.xlsx` (subtract 1 from
  `draft_slot` before lookup — see `_pick_point_value` in `app.py` for
  the same pattern).
- Performance: `_find_player` is O(n) per pick (see prior performance
  audit in conversation history). The full DOM rewrites on each
  render are also the biggest UI cost.
