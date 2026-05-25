# Madden Draft Tool

## Demo

<!--
  To make this video play inline:
    1. Open this README on github.com
    2. Click the pencil (Edit) icon
    3. Drag `recording_small.mp4` from your Desktop into the editor on
       the line below this comment
    4. GitHub uploads it and replaces this comment block with a
       user-attachments URL — that URL plays inline on github.com
    5. Commit the edit
-->

<!-- paste video here -->

Run the NFL draft outside Madden so we can apply richer trade and pick
logic, then export results in a shape Madden can re-import. Local web
app — Python backend, JavaScript frontend, opens in any browser.

## What it does

- Loads a draft year's data from `Files/<year>/` (BigBoard, current
  rosters, pick order, GM traits, position needs, pick value chart).
- Lets you (controlling the **Steelers**) draft your own players,
  sim other teams' picks, sim to your next pick, sim to a chosen
  round, or sim to any overall pick number.
- AI teams will make picks (and eventually trades) based on their own
  big board, GM traits, and team needs — see
  [`backend/logic.py`](backend/logic.py) for the contract; the
  heuristics are placeholder shells today.
- You can offer trade-ups to any team's pick; when their pick is up,
  you can review trade-down offers from AI teams.
- Exports three xlsx files for re-import / inspection:
  - `DraftPickOutcome.xlsx` — every pick + the player drafted.
  - `DraftPicks_updated.xlsx` — same shape as input, with new
    `CurrentTeam` ownership and `SelectedPlayer` filled in.
  - `Trades.xlsx` — chronological trade log (for testing).

## Run it

Requires Python 3.10+.

**macOS / Linux (bash/zsh):**

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

**Windows (PowerShell):**

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python app.py
```

If PowerShell blocks the activation script with a security error, you
can either run the commands above directly (they don't need the venv
"activated" — they invoke the venv's `pip` and `python` by path) or
loosen the policy for the current session with
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`.

Then open http://localhost:5050. Pick a year on the setup screen
(today only `TestFiles` is present) and click **Start Draft**.

## Adding a new draft year

Drop the source files under `Files/<year>/` matching the names in
`Files/TestFiles/`:

```
Files/2026/
  BigBoard.xlsx
  Player.xlsx
  DraftPicks.xlsx
  GMInfo.xlsx
  PositionNeeds.xlsx
  DraftPickValue.xlsx
  DraftMaxPerPosition.xlsx
  all_colleges.json   (optional)
```

Restart the server; the year shows up in the dropdown automatically.
If the requested year folder is missing, the loader falls back to
`Files/TestFiles/`.

## UI overview

- **On the Clock** (top left): which team is picking now. When it's
  the Steelers, you get *Check Trade-Down Offers* and *Offer Trade Up*
  buttons.
- **Last Selection** (left): most recent player drafted.
- **Team Needs** (left): position weakness ranking for whoever is on
  the clock.
- **Current Round** (center): 4×8 grid of the visible round; highlights
  the on-the-clock pick (pulsing green) and Steelers picks (gold).
  Round dropdown switches the view.
- **Mel Kiper Best Available** (center): public consensus board. When
  Steelers are on the clock, each row gets a Draft button.
- **Team Big Boards** (right): private per-team rankings. Mostly for
  testing how AI logic ranks players.
- **Top bar buttons**: *Sim Pick* (one AI pick), *Sim to My Pick*,
  *Sim to Round…*, *Full Draft Order* (modal showing the entire
  draft as a 4-wide grid), *Export* (downloads all three xlsx files).

## Project layout

```
app.py                Flask entry + HTTP routes
backend/
  data_loader.py      Reads xlsx/json from Files/<year>/
  draft_state.py      Pick order, on-the-clock, drafted players, trades
  logic.py            Decision functions (placeholder shells)
  exporter.py         Writes the three output xlsx files
templates/index.html  App shell
static/js/app.js      All frontend behavior
static/css/app.css    Custom styling layered on Tailwind CDN
Files/                Per-year source data + Exports/ (gitignored)
```

See [CLAUDE.md](CLAUDE.md) for engineering notes (data quirks,
team-ID-space mismatch, what's stubbed vs. real).

## Status

The plumbing — data load, draft state, API, UI, export — is real and
end-to-end. The decision functions in `backend/logic.py` are
placeholders with full docstrings describing the real algorithm. They
will be filled in iteratively without changing their signatures.
