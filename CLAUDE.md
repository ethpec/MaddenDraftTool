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

Still placeholder:
- `sim_pick` picks the top available player on the team's board (no
  need/BPA blending yet).
- All trade functions refuse / return empty.

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
- `sim_until_end` deliberately **ignores** the user team — it pushes
  through every remaining pick, AI-filling the user team's slots too,
  for end-of-draft convenience.

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

- Real draft and trade heuristics (see `logic.py` docstrings).
- Per-row prefix preservation in `exporter._encode_team_id` if Madden
  re-import rejects the heuristic prefix.
- AI trade-up offers are not generated yet — the Trade Hub's "Incoming
  Offers" section always shows the empty state.
- Trade-value heuristics in `logic.pick_value` work, but
  `generate_trade_offers_for_pick` and `attempt_user_trade_up` return
  empty / refuse.
- Performance: `_find_player` is O(n) per pick (see prior performance
  audit in conversation history). The full DOM rewrites on each
  render are also the biggest UI cost.
