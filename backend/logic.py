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


# -----------------------------------------------------------------------------
# Big board / player ranking
# -----------------------------------------------------------------------------

def compute_team_big_board(team_name: str, draftable_players: list[dict[str, Any]],
                           gm_info: dict[str, Any]) -> list[dict[str, Any]]:
    """Return ``team_name``'s personal ranking of the still-undrafted players.

    Real implementation should:
    - Start from the BigBoard's per-team column (already loaded as
      ``player['team_rankings'][team_name]``).
    - Apply per-team variance based on ``BigBoardSkill`` (1=worst, 5=best):
      lower skill -> wider random shuffle around the true rank; higher
      skill -> closer to the consensus rank. Spec from DraftToolLogic:
      worst rank = default + max(10, draftPos); best rank = default -
      max(10, draftPos/2).
    - Filter out anyone already drafted.

    Current placeholder: returns the players sorted by their stored
    per-team rank.
    """
    avail = [p for p in draftable_players if not p.get("drafted")]
    avail.sort(key=lambda p: p.get("team_rankings", {}).get(team_name) or 9999)
    return avail


def compute_team_needs(team_name: str, team_index: int,
                       roster: list[dict[str, Any]],
                       position_needs_table: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a ranked list of position needs for ``team_name``.

    Real implementation should:
    - Filter roster to ``TeamIndex == team_index`` and signed players.
    - For each position, look at the highest OVR currently rostered.
    - Cross-reference PositionNeeds.xlsx rows: each row says "if your
      best player at POS has OVR in [Roster OVR Min, Roster OVR Max],
      then a player in OVR [Target OVR Min, Target OVR Max] satisfies
      this need with weight DefaultWeight, label NeedLabel".
    - Sort by weight desc; return e.g. ``[{"position": "WR", "weight": 2,
      "label": "WR1"}, ...]``.

    Current placeholder: derives a rough need list from rostered top-OVR
    by position (lower top-OVR -> bigger need) without consulting the
    tier table.
    """
    by_pos: dict[str, int] = {}
    for player in roster:
        if player.get("TeamIndex") != team_index:
            continue
        pos = player.get("Position")
        if not pos:
            continue
        ovr = player.get("OverallRating") or 0
        if ovr > by_pos.get(pos, 0):
            by_pos[pos] = ovr
    needs = [
        {"position": pos, "top_ovr": ovr, "weight": max(0, 80 - ovr)}
        for pos, ovr in by_pos.items()
    ]
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

    Current placeholder: picks the highest-ranked still-available player
    from this team's big board.
    """
    big_board = state["big_board"]["players"]
    avail = [p for p in big_board if not p.get("drafted")]
    if not avail:
        return {"outcome": "skip", "reason": "no_players_left"}
    avail.sort(key=lambda p: p.get("team_rankings", {}).get(team_name) or 9999)
    pick = avail[0]
    return {
        "outcome": "select",
        "player_id": pick.get("Player_ID"),
        "first_name": pick.get("FirstName"),
        "last_name": pick.get("LastName"),
        "rationale": f"placeholder: top of {team_name}'s board",
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
