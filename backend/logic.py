"""Draft and trade decision logic (placeholder implementations).

These functions are the brain of the tool. They are intentionally
shipped as documented stubs so the rest of the app (state, API, UI,
exporters) can be built and wired end-to-end first; the real heuristics
based on GM traits, big board variance, position needs, and trade value
will be filled in iteratively.

Every function has a complete docstring describing the contract: what it
takes in, what it returns, and what real logic it should perform once
implemented.
"""

from __future__ import annotations

import random
from typing import Any


# Maps raw Madden positions to the need-group used in PositionNeeds.xlsx.
# Both compute_team_needs (collection) and sim_pick (matching) use this
# so a player at LE/RE is correctly recognized as satisfying an EDGE need.
POSITION_GROUPS: dict[str, str] = {
    "LT": "OT", "RT": "OT",
    "LG": "OG", "RG": "OG",
    "LE": "EDGE", "RE": "EDGE",
    "LOLB": "OLB", "ROLB": "OLB",
    "MLB": "ILB",
}


# -----------------------------------------------------------------------------
# Big board / player ranking
# -----------------------------------------------------------------------------

def compute_team_big_board(team_name: str, draftable_players: list[dict[str, Any]],
                           gm_info: dict[str, Any]) -> list[dict[str, Any]]:
    """Return ``team_name``'s personal ranking of the still-undrafted players.

    Starts from the per-team BigBoard column, applies rank-scaled noise so
    mid-round players move more than top players, then re-assigns clean 1..N
    positions so there are no ties or out-of-bounds values.

    Noise window: ±max(10, rank/3) spots, scaled by BigBoardSkill
    (1=widest variance → 1.375x, 3=default → 1.125x, 5=tightest → 0.875x).
    At rank 150 with skill 3 this gives roughly ±50 spots.
    """
    # Can'tMiss / BlueChip prospects are protected from falling too far.
    # PROSPECT_FACTOR caps the downward (worse rank) portion of the swing.
    PROSPECT_FACTOR: dict[str, float] = {"Can'tMiss": 0.00, "BlueChip": 0.1}

    skill = max(1, min(5, int(gm_info.get("BigBoardSkill") or 3)))
    skill_factor = 1.0 + (4 - skill) * 0.125

    noisy: list[tuple[float, int | float, dict[str, Any]]] = []
    for p in draftable_players:
        if p.get("drafted"):
            continue
        rank = p.get("BigBoardRank") or 9999
        swing = max(10.0, rank / 2.5) * skill_factor
        prospect_factor = PROSPECT_FACTOR.get(p.get("ProspectType") or "Standard", 1.0)
        noisy_rank = max(1.0, rank + random.uniform(-swing, swing * prospect_factor))
        noisy.append((noisy_rank, rank, p))

    noisy.sort(key=lambda x: (x[0], x[1]))
    return [p for _, _, p in noisy]


def compute_team_needs(team_name: str, team_index: int,
                       roster: list[dict[str, Any]],
                       position_needs_table: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a ranked list of position needs for ``team_name``.

    For each row in PositionNeeds, finds the Rank-th highest OVR player
    at that position on the team (defaulting to 0 if the team has fewer
    players than Rank). If that OVR falls within [Roster OVR Min, Roster
    OVR Max] (inclusive), it is a need. TrueWeight is DefaultWeight ±
    random(DefaultWeight * 0.25). Returns rows sorted by TrueWeight desc.
    """
    # Collect each position's OVRs for this team, sorted descending.
    # Split positions (LT/RT, LG/RG, etc.) are combined into their group.
    by_pos: dict[str, list[int]] = {}
    for player in roster:
        if player.get("TeamIndex") != team_index:
            continue
        pos = player.get("Position")
        ovr = player.get("OverallRating")
        if not pos or ovr is None:
            continue
        group = POSITION_GROUPS.get(pos, pos)
        by_pos.setdefault(group, []).append(int(ovr))
    for pos in by_pos:
        by_pos[pos].sort(reverse=True)

    needs: list[dict[str, Any]] = []
    for row in position_needs_table:
        pos = row.get("Position")
        rank = row.get("Rank")
        if not pos or rank is None:
            continue
        ovrs = by_pos.get(pos, [])
        player_ovr = ovrs[int(rank) - 1] if len(ovrs) >= int(rank) else 0
        ovr_min = row.get("Roster OVR Min") or 0
        ovr_max = row.get("Roster OVR Max") or 0
        if not (ovr_min <= player_ovr <= ovr_max):
            continue
        weight = float(row.get("TrueWeight") or row.get("DefaultWeight") or 0)
        needs.append({
            "position": pos,
            "label": row.get("Need Label"),
            "weight": weight,
            "roster_ovr": player_ovr,
        })

    needs.sort(key=lambda n: n["weight"], reverse=True)
    return needs


# -----------------------------------------------------------------------------
# Pick simulation
# -----------------------------------------------------------------------------

def sim_pick(state: dict[str, Any], team_name: str) -> dict[str, Any]:
    """Decide what ``team_name`` does with their current pick.

    Real implementation should:
    1. Build the team's personal big board (compute_team_big_board).
    2. Compute team needs (compute_team_needs).
    3. With probability driven by GM ``TradeDown`` trait, evaluate any
       trade-up offers from other teams (generate_trade_offers_for_pick).
       If best offer's value beats keeping the pick, return a TRADE
       outcome.
    4. Otherwise, choose between "best player available" and "best player
       at a position of need" using the GM's NeedvsBPA bias and the
       phase of the draft (early rounds lean BPA, later lean need).
       Respect DraftMaxPerPosition.
    5. Return a SELECT outcome with the chosen player.

    Current placeholder: picks the top still-available player from this
    team's pre-built big board.
    """
    player_map = {p.get("Player_ID"): p for p in state["big_board"]["players"]}
    board = state.get("team_boards", {}).get(team_name, [])
    pick = next(
        (player_map[pid] for pid in board
         if pid in player_map and not player_map[pid].get("drafted")),
        None,
    )
    if pick is None:
        return {"outcome": "skip", "reason": "no_players_left"}
    return {
        "outcome": "select",
        "player_id": pick.get("Player_ID"),
        "first_name": pick.get("FirstName"),
        "last_name": pick.get("LastName"),
        "rationale": f"top of {team_name}'s board",
    }


# -----------------------------------------------------------------------------
# Trades
# -----------------------------------------------------------------------------

def pick_value(pick: dict[str, Any], pick_value_table: dict[str, list[dict[str, Any]]]) -> float:
    """Return the Jimmy-Johnson-style value of a single pick.

    ``pick`` carries Round, PickNumber, YearOffset. ``pick_value_table``
    is the parsed DraftPickValue workbook (Current + Future sheets).
    Future-year picks are valued via the ``Future`` sheet (or by
    discounting Current values for years > 1).
    """
    overall = pick.get("PickNumber")
    if overall is None:
        return 0.0
    year_offset = pick.get("YearOffset", 0) or 0
    sheet = pick_value_table["current"] if year_offset == 0 else pick_value_table["future"]
    for row in sheet:
        if row.get("Pick") == overall:
            return float(row.get("Value") or 0)
    return 0.0


def generate_trade_offers_for_pick(state: dict[str, Any], pick: dict[str, Any]) -> list[dict[str, Any]]:
    """Return a list of trade-up offers other teams would make for this pick.

    Real implementation should:
    - Iterate every team that does not already own this pick.
    - For each, decide based on GM ``TradeUp`` trait whether they're in
      the market, and whether their personal big board has a target
      sliding to this pick.
    - Construct a package of their own picks (current + future) whose
      total value approximates the target pick's value plus a premium
      proportional to how much they want to move up.
    - Return offers sorted by value to the picking team.

    Current placeholder: returns an empty list.
    """
    return []


def evaluate_trade_offer(state: dict[str, Any], offer: dict[str, Any],
                         receiving_team: str) -> dict[str, Any]:
    """Decide whether ``receiving_team`` accepts a given trade offer.

    Real implementation should:
    - Sum the value of picks offered vs picks given up using
      ``pick_value``.
    - Apply the receiving GM's TradeDown trait as a threshold (better
      trait -> more willing to move down even at marginal value).
    - Optionally compare offer to all other live offers for the same pick.
    - Return ``{"accepted": bool, "counter": {...}|None, "reason": str}``.

    Current placeholder: refuses everything.
    """
    return {"accepted": False, "counter": None, "reason": "placeholder logic"}


def attempt_user_trade_up(state: dict[str, Any], target_pick: dict[str, Any],
                          offered_picks: list[dict[str, Any]]) -> dict[str, Any]:
    """Process the user's trade-up attempt against another team's pick.

    Real implementation should:
    - Build the same trade-evaluation flow used by AI: compare the user's
      offer to other live AI offers for the same pick, factor in the
      receiving GM's traits, and either accept, counter, or refuse.

    Current placeholder: refuses every attempt with a stub reason.
    """
    return {
        "accepted": False,
        "counter": None,
        "reason": "trade evaluation not implemented yet",
    }


def attempt_user_trade_down(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Return AI-generated trade-up offers targeted at the user's current pick.

    Real implementation should call ``generate_trade_offers_for_pick`` for
    the user's pick and return those offers verbatim so the UI can show
    them to the user.

    Current placeholder: returns an empty list.
    """
    return []


# -----------------------------------------------------------------------------
# RNG helpers
# -----------------------------------------------------------------------------

def seeded_rng(seed: int | None) -> random.Random:
    """Return a ``random.Random`` instance, optionally seeded."""
    return random.Random(seed)
