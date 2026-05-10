"""Data loader for Madden Draft Tool.

Resolves a year selection to a folder under ``Files/`` and parses the
xlsx/json source files into in-memory Python dicts the rest of the
backend can consume.

Folder convention: ``Files/<year>/``. If a folder for the requested year
does not exist, falls back to ``Files/TestFiles/`` so the tool stays
usable while only test data is present.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import openpyxl


REPO_ROOT = Path(__file__).resolve().parent.parent
FILES_ROOT = REPO_ROOT / "Files"
FALLBACK_FOLDER_NAME = "TestFiles"
NFL_LOGOS_DIR = REPO_ROOT / "static" / "nfl_logos"
COLLEGE_LOGOS_DIR = REPO_ROOT / "static" / "college_logos"


# Columns from Player.xlsx we actually care about for needs / roster OVR.
# Loading all 271 columns is wasteful; this list is the minimal join we
# need for now, expand as logic functions need more.
PLAYER_COLUMNS_OF_INTEREST: tuple[str, ...] = (
    "FirstName",
    "LastName",
    "Position",
    "OverallRating",
    "Age",
    "TeamIndex",
    "ContractStatus",
    "PLYR_DRAFTTEAM",
    "YearDrafted",
    "College",
    "PLYR_ASSETNAME",
)


def slugify(name: str) -> str:
    """Convert a team or college name to the on-disk logo slug.

    Logos in ``static/nfl_logos`` and ``static/college_logos`` use
    lowercase-hyphenated filenames (``pittsburgh-steelers.png``,
    ``alabama-a-and-m.png``). We mirror that convention: lowercase,
    ampersands become ``and``, drop apostrophes, anything else
    non-alphanumeric -> hyphen.
    """
    if not name:
        return ""
    s = str(name).lower().replace("&", " and ").replace("'", "")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def build_nfl_logo_map() -> dict[str, str]:
    """Map team nickname (matches GMInfo TeamName) -> logo URL path.

    NFL logos are named ``city-nickname.png`` (e.g.
    ``pittsburgh-steelers.png``). GMInfo only carries the nickname, so
    we look for any file whose slug ends with the nickname slug.
    Returns ``{team_name: "/static/nfl_logos/foo.png"}`` and silently
    omits teams whose logo isn't on disk.
    """
    if not NFL_LOGOS_DIR.is_dir():
        return {}
    files = [f.name for f in NFL_LOGOS_DIR.iterdir() if f.is_file() and f.suffix == ".png"]
    out: dict[str, str] = {}
    # Hardcoded full-name slugs for the 32 teams; this is the most reliable
    # mapping (some nicknames like "Cardinals" or "Panthers" exist in
    # multiple cities historically, but GMInfo always means the current
    # franchise so we fix the city explicitly).
    name_to_slug = {
        "Bills": "buffalo-bills", "Dolphins": "miami-dolphins",
        "Patriots": "new-england-patriots", "Jets": "new-york-jets",
        "Ravens": "baltimore-ravens", "Bengals": "cincinnati-bengals",
        "Browns": "cleveland-browns", "Steelers": "pittsburgh-steelers",
        "Texans": "houston-texans", "Colts": "indianapolis-colts",
        "Jaguars": "jacksonville-jaguars", "Titans": "tennessee-titans",
        "Broncos": "denver-broncos", "Chiefs": "kansas-city-chiefs",
        "Chargers": "los-angeles-chargers", "Raiders": "las-vegas-raiders",
        "Cowboys": "dallas-cowboys", "Giants": "new-york-giants",
        "Eagles": "philadelphia-eagles", "Commanders": "washington-commanders",
        "Bears": "chicago-bears", "Lions": "detroit-lions",
        "Packers": "green-bay-packers", "Vikings": "minnesota-vikings",
        "Falcons": "atlanta-falcons", "Panthers": "carolina-panthers",
        "Saints": "new-orleans-saints", "Buccaneers": "tampa-bay-buccaneers",
        "Cardinals": "arizona-cardinals", "Rams": "los-angeles-rams",
        "Seahawks": "seattle-seahawks", "49ers": "san-francisco-49ers",
    }
    file_set = set(files)
    for team, slug in name_to_slug.items():
        fname = slug + ".png"
        if fname in file_set:
            out[team] = "/static/nfl_logos/" + fname
    return out


def build_college_logo_map(colleges: Any) -> dict[str, str]:
    """Map collegeName -> logo URL path; only includes names whose file exists.

    ``colleges`` is the parsed all_colleges.json (list of
    ``{collegeName, binaryReference}``). Roughly 380/488 colleges have
    matching files in ``static/college_logos``; the rest get no logo
    and the UI will show a placeholder.
    """
    if not COLLEGE_LOGOS_DIR.is_dir() or not colleges:
        return {}
    files = {f.name for f in COLLEGE_LOGOS_DIR.iterdir()
             if f.is_file() and f.suffix == ".png"}
    out: dict[str, str] = {}
    for c in colleges:
        name = c.get("collegeName")
        if not name:
            continue
        fname = slugify(name) + ".png"
        if fname in files:
            out[name] = "/static/college_logos/" + fname
    return out


def build_college_id_to_name(colleges: Any) -> dict[str, str]:
    """Decode Player.xlsx ``College`` column (binary string) -> college name."""
    if not colleges:
        return {}
    return {c["binaryReference"]: c["collegeName"]
            for c in colleges if c.get("binaryReference")}


def resolve_year_folder(year: str | int | None) -> Path:
    """Return the folder path for a given draft year.

    Looks for ``Files/<year>/``. If that does not exist, returns
    ``Files/TestFiles/`` so the rest of the loader still works against
    sample data.
    """
    if year is not None:
        candidate = FILES_ROOT / str(year)
        if candidate.is_dir():
            return candidate
    return FILES_ROOT / FALLBACK_FOLDER_NAME


def list_available_years() -> list[dict[str, Any]]:
    """Return entries describing every draft folder under ``Files/``.

    Each entry has ``{"year": str, "is_test": bool, "path": str}``.
    """
    if not FILES_ROOT.is_dir():
        return []
    entries: list[dict[str, Any]] = []
    for child in sorted(FILES_ROOT.iterdir()):
        if not child.is_dir():
            continue
        if child.name.lower() == "exports":
            continue
        entries.append({
            "year": child.name,
            "is_test": child.name == FALLBACK_FOLDER_NAME,
            "path": str(child),
        })
    return entries


def _read_sheet(path: Path, sheet_name: str | None = None) -> tuple[list[str], list[list[Any]]]:
    """Open an xlsx file and return ``(headers, rows)`` for the chosen sheet.

    If ``sheet_name`` is None, the active/first sheet is used.
    """
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet_name] if sheet_name else wb.active
    iterator = ws.iter_rows(values_only=True)
    try:
        headers_tuple = next(iterator)
    except StopIteration:
        wb.close()
        return [], []
    headers = [str(h) if h is not None else "" for h in headers_tuple]
    rows: list[list[Any]] = []
    for row in iterator:
        if row is None or all(c is None for c in row):
            continue
        rows.append(list(row))
    wb.close()
    return headers, rows


def _rows_to_dicts(headers: list[str], rows: list[list[Any]]) -> list[dict[str, Any]]:
    return [
        {headers[i]: (row[i] if i < len(row) else None) for i in range(len(headers))}
        for row in rows
    ]


def load_big_board(folder: Path) -> dict[str, Any]:
    """Load BigBoard.xlsx -> draftable rookies plus per-team rankings.

    BigBoard has a row per rookie and one column per NFL team containing
    that team's private ranking of the player. We split those out into a
    nested ``team_rankings`` dict to keep the public board separate from
    each team's view.
    """
    headers, rows = _read_sheet(folder / "BigBoard.xlsx")
    base_cols = {"FirstName", "LastName", "Player_ID", "Drafted",
                 "BigBoardRank", "PLYR_DRAFTROUND", "PLYR_DRAFTPICK"}
    team_cols = [h for h in headers if h not in base_cols and h]
    players: list[dict[str, Any]] = []
    for row in rows:
        record = {headers[i]: row[i] for i in range(len(headers))}
        rankings = {team: record.pop(team, None) for team in team_cols}
        record["team_rankings"] = rankings
        record["drafted"] = record.get("Drafted") not in (None, "", 0, False)
        players.append(record)
    return {"players": players, "team_columns": team_cols}


def load_players(folder: Path) -> list[dict[str, Any]]:
    """Load Player.xlsx but project to columns of interest only.

    Player.xlsx is ~32MB with 271 columns; we never need most of them in
    the draft tool. We keep just the columns useful for computing team
    needs and current roster OVR.
    """
    headers, rows = _read_sheet(folder / "Player.xlsx")
    keep_idx = {h: headers.index(h) for h in PLAYER_COLUMNS_OF_INTEREST if h in headers}
    out: list[dict[str, Any]] = []
    for row in rows:
        rec = {col: row[idx] for col, idx in keep_idx.items() if idx < len(row)}
        out.append(rec)
    return out


def _decode_team_number(value: Any) -> int | None:
    """DraftPicks.xlsx stores team identity as a 32-bit binary string.

    The lowest 8 bits are the TeamNumber from TeamInfo.xlsx. We decode
    just that byte so callers can look the team name up in team_info.
    """
    if value is None:
        return None
    s = str(value)
    if len(s) != 32 or any(c not in "01" for c in s):
        return None
    return int(s[-8:], 2)


def load_team_info(folder: Path) -> dict[int, str]:
    """Load TeamInfo.xlsx -> {TeamNumber: TeamName} for real NFL teams only.

    Filters out non-team rows (AFC, NFC, Free Agents, Hall Of Fame, NFL
    Greats) whose TeamIndex >= 32.
    """
    headers, rows = _read_sheet(folder / "TeamInfo.xlsx")
    dicts = _rows_to_dicts(headers, rows)
    out: dict[int, str] = {}
    for d in dicts:
        team_num = d.get("TeamNumber")
        name = d.get("TeamName")
        team_idx = d.get("TeamIndex")
        if team_num is None or not name or team_idx is None:
            continue
        if int(team_idx) >= 32:
            continue
        out[int(team_num)] = str(name)
    return out


def load_draft_picks(folder: Path) -> list[dict[str, Any]]:
    """Load DraftPicks.xlsx.

    Columns: SelectedPlayer, OriginalTeam, CurrentTeam, YearOffset,
    Round, PickNumber. ``Round`` / ``PickNumber`` are 0-indexed in the
    source. Adds 1-indexed convenience fields and decoded TeamNumber ints
    (from TeamInfo.xlsx) for OriginalTeam / CurrentTeam.
    """
    headers, rows = _read_sheet(folder / "DraftPicks.xlsx")
    dicts = _rows_to_dicts(headers, rows)
    for d in dicts:
        d["round_1"] = (d.get("Round") or 0) + 1
        d["pick_1"] = (d.get("PickNumber") or 0) + 1
        d["OriginalTeamIndex"] = _decode_team_number(d.get("OriginalTeam"))
        d["CurrentTeamIndex"] = _decode_team_number(d.get("CurrentTeam"))
    return dicts


def load_gm_info(folder: Path) -> list[dict[str, Any]]:
    """Load GMInfo.xlsx -> per-team GM trait scores.

    Trailing legend rows (where TeamName is None) are dropped.
    """
    headers, rows = _read_sheet(folder / "GMInfo.xlsx")
    dicts = _rows_to_dicts(headers, rows)
    return [d for d in dicts if d.get("TeamName")]


def load_position_needs(folder: Path) -> list[dict[str, Any]]:
    """Load PositionNeeds.xlsx (TierNeedLogic sheet)."""
    headers, rows = _read_sheet(folder / "PositionNeeds.xlsx", "TierNeedLogic")
    return _rows_to_dicts(headers, rows)


def load_draft_pick_value(folder: Path) -> dict[str, list[dict[str, Any]]]:
    """Load DraftPickValue.xlsx (Current + Future sheets)."""
    cur_h, cur_r = _read_sheet(folder / "DraftPickValue.xlsx", "Current")
    fut_h, fut_r = _read_sheet(folder / "DraftPickValue.xlsx", "Future")
    return {
        "current": _rows_to_dicts(cur_h, cur_r),
        "future": _rows_to_dicts(fut_h, fut_r),
    }


def load_max_per_position(folder: Path) -> list[dict[str, Any]]:
    """Load DraftMaxPerPosition.xlsx -> per-position cap on draftees."""
    _, rows = _read_sheet(folder / "DraftMaxPerPosition.xlsx")
    out: list[dict[str, Any]] = []
    for row in rows:
        if row[0] in (None, ""):
            continue
        out.append({"Position": row[0], "MaxDrafted": row[1]})
    return out


def load_colleges(folder: Path) -> Any:
    """Load all_colleges.json if present."""
    path = folder / "all_colleges.json"
    if not path.is_file():
        return None
    with path.open() as f:
        return json.load(f)


def load_all(year: str | int | None) -> dict[str, Any]:
    """Top-level entry point. Returns a single dict with every parsed source.

    Joins college names onto BigBoard rows by Player_ID -> Player.xlsx
    so the frontend can render college logos without doing the join
    itself.
    """
    folder = resolve_year_folder(year)
    big_board = load_big_board(folder)
    players = load_players(folder)
    colleges = load_colleges(folder)
    college_by_id = build_college_id_to_name(colleges)
    college_logo_map = build_college_logo_map(colleges)
    nfl_logo_map = build_nfl_logo_map()

    # Annotate big board players with their college name + logo URL by
    # looking them up in Player.xlsx by FirstName+LastName (BigBoard
    # uses the same identifier shape — "FirstName LastName_id" — but
    # Player.xlsx joins more reliably on the (First, Last) tuple).
    player_lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for pl in players:
        key = (pl.get("FirstName"), pl.get("LastName"))
        if key not in player_lookup:
            player_lookup[key] = pl
    for p in big_board["players"]:
        key = (p.get("FirstName"), p.get("LastName"))
        match = player_lookup.get(key)
        if match:
            college_id = match.get("College")
            college_name = college_by_id.get(college_id)
            p["college"] = college_name
            p["position"] = match.get("Position")
            if college_name:
                p["college_logo"] = college_logo_map.get(college_name)

    return {
        "year": str(year) if year is not None else None,
        "folder": str(folder),
        "folder_name": folder.name,
        "big_board": big_board,
        "players": players,
        "draft_picks": load_draft_picks(folder),
        "gm_info": load_gm_info(folder),
        "team_info": load_team_info(folder),
        "position_needs": load_position_needs(folder),
        "pick_values": load_draft_pick_value(folder),
        "max_per_position": load_max_per_position(folder),
        "colleges": colleges,
        "college_logo_map": college_logo_map,
        "nfl_logo_map": nfl_logo_map,
    }
