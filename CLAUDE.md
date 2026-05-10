# CLAUDE.md — Madden Draft Tool

Notes for future agents working on this repo. Read before making changes.

## What this is

A local web app that lets the user run a Madden NFL draft outside the
game so we can apply richer trade/pick logic, then export results in a
shape Madden can re-import. Python (Flask) backend, vanilla JS +
Tailwind-via-CDN frontend. The user controls the **Steelers**; everyone
else is AI-driven.

Run with `python app.py` -> http://localhost:5050.

## Repo layout

```
app.py                       Flask entry, all HTTP routes
backend/
  data_loader.py             Parses xlsx/json from Files/<year>/
  draft_state.py             DraftSession: pick order, on-the-clock, trades
  logic.py                   Decision functions (mostly stubs today)
  exporter.py                Writes the three output xlsx files
templates/index.html         App shell (Tailwind CDN, dark theme)
static/js/app.js             All frontend behavior (single file)
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
    all_colleges.json        College reference data
    DraftToolLogic.docx      Original spec from the user
  <year>/                    Same shape; loader picks this if present
  <year>/Exports/            Generated outputs (gitignored)
```

## Critical things to know before editing

### 1. BigBoard != Player.xlsx
- **BigBoard.xlsx** = the draftable rookie class (~455 rows). Each row
  has every NFL team as a column with that team's private ranking of
  the player.
- **Player.xlsx** = current rosters of all 32 teams (~3960 rows, 271
  columns). Used to compute team needs and current-roster top OVR per
  position. We deliberately load only ~9 columns
  (`PLAYER_COLUMNS_OF_INTEREST` in `data_loader.py`); loading all 271
  is slow and pointless. Add columns to that tuple as logic needs them.

### 2. Two team-ID spaces (foot-gun)
- `GMInfo.xlsx` uses TeamIndex `[0..31]`.
- `DraftPicks.xlsx` stores team identity as a 32-char binary string;
  the **lowest 8 bits** are the TeamIndex byte, but the values used
  there are `[0..7, 10..17, 19, 21..23, 25..36]` — five GM teams
  (Chiefs=8, Colts=9, Lions=18, Panthers=20, Ravens=24) are missing
  from that range and instead appear at indices 32..36.
- `DraftSession._build_team_name_map` patches this with a heuristic
  that aligns the two sorted "leftover" lists. **If you ever get a
  documented mapping, replace that heuristic.** Until then, expect the
  five wrap-around teams to display correctly only because of the
  alignment trick.
- `exporter._encode_team_id` reuses a fixed 24-bit prefix observed in
  the sample data when writing CurrentTeam back out. If Madden
  re-import rejects the file, the fix is to preserve each row's
  *original* prefix instead of using a constant.

### 3. Logic is stubs
Every function in `backend/logic.py` is a documented placeholder. The
docstrings describe the real algorithm (BigBoardSkill variance, GM
trait influence on trade-up/down propensity, BPA-vs-need mixing,
Jimmy-Johnson value math, future-pick discounting). The plumbing
around them (state mutation, API surface, UI rendering, exporters) is
real and ready to be driven by real logic. **When implementing real
logic, do not change the function signatures** — `draft_state.py` and
`app.py` already call them with the documented arguments.

Current placeholder behavior:
- `sim_pick` always picks the top of the team's per-team big board.
- All trade functions refuse / return empty.

### 4. Year folders
The user picks a year on the setup screen. `data_loader.resolve_year_folder`
looks for `Files/<year>/` and falls back to `Files/TestFiles/` if
missing. `list_available_years()` is what populates the dropdown — it
scans `Files/` for subdirs (excluding `Exports`).

### 5. Single global session
`app.py` keeps **one** `DraftSession` in module-level state. There's no
multi-user support — this is a local single-user tool by design. Don't
add session IDs or auth without asking. Restarting the server wipes
state; the user is expected to export before quitting.

### 6. Logos
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

### 7. The export step always re-runs
`/api/export/download/<kind>` re-runs `export_session` on every call so
the file reflects current state. This is intentional — the user can
download mid-draft. Don't cache output paths.

## Frontend conventions

- Vanilla JS, no build step. Add new behavior in `static/js/app.js`.
- State lives in the `state` object at the top of `app.js`. Renders are
  full-subtree rebuilds from state — don't try to do incremental
  patching, the data is small enough.
- All API calls go through the `api.get` / `api.post` helpers.
- Tailwind classes inline; `static/css/app.css` is for things awkward
  to do inline (animations, scrollbars, hover states).
- The dark theme uses custom Tailwind colors (`ink-*`, `accent-*`,
  `field-*`) configured in `<script>tailwind.config = {...}</script>`
  inside `index.html`.

## API surface (current)

```
GET  /api/years                          List Files/* folders
POST /api/session/start                  { year } -> bootstrap session
GET  /api/session                        Current session summary
GET  /api/board                          All picks
GET  /api/big-board/public               Mel Kiper consensus board
GET  /api/big-board/team/<team_name>     One team's private board
GET  /api/needs/<team_name>              Computed needs list
GET  /api/gm-info                        All GM trait rows
GET  /api/trades                         Trade log
POST /api/pick/make                      { player_id } user picks now
POST /api/pick/sim                       Sim the current AI pick
POST /api/pick/sim-until-user            Sim until Steelers on clock
POST /api/pick/sim-until-round           { round }
POST /api/pick/sim-until-overall         { overall }
GET  /api/trade/down-offers              AI offers for user's pick
POST /api/trade/up                       { target_overall, offered_overalls }
POST /api/export                         Write all 3 xlsx files
GET  /api/export/download/<kind>         kind = outcome | picks | trades
```

## When you make changes

- **Don't** load the full Player.xlsx column set — keep the projected
  column list in `PLAYER_COLUMNS_OF_INTEREST` and grow it intentionally.
- **Don't** invent multi-session/auth/persistence. This is local-only.
- **Don't** change `logic.py` function signatures unless you also update
  the callers in `draft_state.py` and `app.py`.
- **Do** match the existing dark/gold visual language when adding UI.
- **Do** smoke-test by starting `python app.py` and hitting at least:
  start session -> sim a few -> make a user pick -> export. Any of
  those breaking is a regression.

## Open work / known gaps

- All real draft and trade heuristics (see logic.py docstrings).
- Documented team-ID mapping (currently heuristic; see #2 above).
- Per-row prefix preservation in `_encode_team_id` if Madden re-import
  rejects the heuristic prefix.
- "Sim to next pick" semantics for the user team-needs panel — today
  the needs panel always shows whoever is currently on the clock; we
  may want a separate "Steelers needs" pin.
- Position info isn't shown on the big-board rows yet (BigBoard.xlsx
  doesn't carry it directly; needs a join with Player.xlsx by
  `Player_ID` once we add Position to the column projection).
