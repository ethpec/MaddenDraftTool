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

import itertools
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
    (1=widest variance → 1.5x, 3=default → 1.25x, 5=tightest → 1.0x).
    At rank 150 with skill 3 this gives roughly ±50 spots.
    """
    # Can'tMiss / BlueChip prospects are protected from falling too far.
    # PROSPECT_FACTOR caps the downward (worse rank) portion of the swing.
    PROSPECT_FACTOR: dict[str, float] = {"Can'tMiss": 0.00, "BlueChip": 0.1}

    skill = max(1, min(5, int(gm_info.get("BigBoardSkill") or 3)))
    gm_skill_factor = 1.0 + (5 - skill) * 0.125

    noisy: list[tuple[float, int | float, dict[str, Any]]] = []
    for p in draftable_players:
        if p.get("drafted"):
            continue
        rank = p.get("BigBoardRank") or 9999
        swing = max(10.0, rank / 2.5) * gm_skill_factor
        prospect_factor = PROSPECT_FACTOR.get(p.get("ProspectType") or "Standard", 1.0)
        noisy_rank = max(1.0, rank + random.uniform(-swing , swing * prospect_factor))
        noisy.append((noisy_rank, rank, p))

    noisy.sort(key=lambda x: (x[0], x[1]))
    return [p for _, _, p in noisy]


def _get_needs(state: dict[str, Any], team_name: str, team_index: int) -> list[dict[str, Any]]:
    """Cached wrapper around ``compute_team_needs``.

    Within a single pick cycle the rosters don't change, so the same team's
    needs are identical across every ``sim_pick`` / trade-probability call.
    The session injects its ``_needs_cache`` dict into the state under
    ``needs_cache`` and invalidates the drafting team's entry after each pick.
    """
    cache = state.get("needs_cache")
    if cache is not None:
        hit = cache.get(team_name)
        if hit is not None:
            return hit
    needs = compute_team_needs(
        team_name, team_index, state["players"], state["position_needs"],
    )
    if cache is not None:
        cache[team_name] = needs
    return needs


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

def _round_bucket(round_1: int, pick_in_round: int) -> tuple[float, tuple[float, float], int]:
    """Return (bpa_probability, (need_window_min, need_window_max), reach_limit) for a pick.

    Round 1 is split into pick-range sub-buckets. Used by both sim_pick and
    the trade-down willingness check so they share the same need window.
    """
    if round_1 == 1:
        if pick_in_round <= 5:
            return 0.05, (2.50, 100), 3
        if pick_in_round <= 10:
            return 0.10, (2.50, 100), 3
        if pick_in_round <= 16:
            return 0.15, (2.50, 100), 5
        return 0.20, (2.50, 100), 5
    return {
        2: (0.30, (2.00, 100), 5),
        3: (0.40, (1.75, 100), 8),
        4: (0.60, (1.50, 2.50), 10),
        5: (0.70, (1.25, 2.25), 12),
        6: (0.80, (1.00, 2.00), 15),
        7: (0.90, (0.75, 1.75), 16),
    }.get(round_1, (0.50, (1.50, 100), 10))


def sim_pick(state: dict[str, Any], team_name: str) -> dict[str, Any]:
    """Decide what ``team_name`` does with their current pick.

    Uses a round-based BPA vs need probability, modified by the GM's
    NeedvsBPA trait. Each round has a TrueWeight window that determines
    which needs are eligible — too low a weight isn't worth a pick at
    that stage, and in later rounds very high-weight needs are excluded
    (the window has passed). If the need path produces no match within
    the reach limit, falls back to BPA.

    Specialist guard: K and P are never taken via BPA in any round
    unless they are an explicit need. Round-1 QB guard works the same way.

    Trade logic is not yet implemented; the TRADE outcome path is a
    placeholder for a future step.
    """
    current_pick = state.get("current_pick") or {}
    round_1 = current_pick.get("round", 1)
    pick_in_round = current_pick.get("pick_in_round", 1)

    player_map = {p.get("Player_ID"): p for p in state["big_board"]["players"]}
    board = state.get("team_boards", {}).get(team_name, [])
    available = [player_map[pid] for pid in board
                 if pid in player_map and not player_map[pid].get("drafted")]

    # Filter out position groups that have hit the per-team draft cap.
    _pg_cfg = state.get("max_per_position_group", {})
    _pos_to_group = _pg_cfg.get("pos_to_group", {})
    _max_per_group = _pg_cfg.get("max_per_group", {})
    if _pos_to_group and _max_per_group:
        _team_counts = state.get("team_pos_group_counts", {}).get(team_name, {})
        available = [
            p for p in available
            if _team_counts.get(_pos_to_group.get(p.get("position", ""), ""), 0)
               < _max_per_group.get(_pos_to_group.get(p.get("position", ""), ""), 999)
        ]

    if not available:
        return {"outcome": "skip", "reason": "no_players_left"}

    base_bpa, (win_min, win_max), reach = _round_bucket(round_1, pick_in_round)

    # NeedvsBPA trait: 1 = extreme BPA, 5 = extreme need. Each step from
    # the midpoint (3) shifts the base probability by 10 percentage points.
    gm = next((g for g in state["gm_info"] if g.get("TeamName") == team_name), {})
    need_vs_bpa = max(1, min(5, int(gm.get("NeedvsBPA") or 3)))
    bpa_prob = max(0.05, min(0.95, base_bpa + (3 - need_vs_bpa) * 0.10))

    # Need path — compute needs and filter to this round's weight window.
    gm_index = gm.get("TeamIndex")
    needs = _get_needs(state, team_name, int(gm_index)) if gm_index is not None else []
    eligible = {n["position"] for n in needs if win_min < n["weight"] <= win_max}

    def _bpa(rationale: str) -> dict[str, Any]:
        """Pick BPA with QB (round 1) and specialist (all rounds) guards applied."""
        player = available[0]
        _SPECIALISTS = {"K", "P"}
        if round_1 == 1 and player.get("position") == "QB" and "QB" not in eligible:
            player = next((p for p in available if p.get("position") != "QB"), player)
            return _make_select(player, "BPA (QB skipped — not a need)")
        if player.get("position") in _SPECIALISTS and player.get("position") not in eligible:
            pos = player.get("position")
            player = next((p for p in available if p.get("position") not in _SPECIALISTS), player)
            return _make_select(player, f"BPA ({pos} skipped — not a need)")
        return _make_select(player, rationale)

    if random.random() < bpa_prob:
        return _bpa("BPA")

    if not eligible or gm_index is None:
        return _bpa("BPA (no eligible needs this round)")

    need_pick = next(
        (p for p in available[:reach]
         if POSITION_GROUPS.get(p.get("position"), p.get("position")) in eligible),
        None,
    )

    if need_pick is None:
        return _bpa("BPA (no need match in reach)")

    raw_pos = need_pick.get("position")
    return _make_select(need_pick, f"need ({POSITION_GROUPS.get(raw_pos, raw_pos)})")


def _make_select(player: dict[str, Any], rationale: str) -> dict[str, Any]:
    return {
        "outcome": "select",
        "player_id": player.get("Player_ID"),
        "first_name": player.get("FirstName"),
        "last_name": player.get("LastName"),
        "rationale": rationale,
    }


# -----------------------------------------------------------------------------
# Trades
# -----------------------------------------------------------------------------

# Round-keyed multiplier distributions used by both sides of a trade.
# Each entry: list of (ratio, probability) summing to 1.0. Trade-down team
# rolls from this table for their acceptance floor (M_down); trade-up team
# rolls the same table and adds _TRADE_UP_OFFSET to get their ceiling (M_up).
# The offset guarantees a non-zero acceptance window when both rolls land on
# the same bucket (e.g. M_down=1.05, M_up=1.075 → 2.5% spread).
_TRADE_THRESHOLD_TABLE: dict[int, list[tuple[float, float]]] = {
    1: [(1.00, 0.20), (1.05, 0.60), (1.10, 0.175), (1.15, 0.025)],
    2: [(0.95, 0.05), (1.00, 0.60), (1.05, 0.30), (1.10, 0.05)],
    3: [(0.95, 0.05), (1.00, 0.65), (1.05, 0.25), (1.10, 0.05)],
    4: [(0.95, 0.10), (1.00, 0.65), (1.05, 0.20), (1.10, 0.05)],
    5: [(0.95, 0.10), (1.00, 0.70), (1.05, 0.15), (1.10, 0.05)],
    6: [(0.95, 0.15), (1.00, 0.70), (1.05, 0.10), (1.10, 0.05)],
    7: [(0.95, 0.15), (1.00, 0.75), (1.05, 0.10), (1.10, 0.05)],
}

# Random offset applied to the trade-up team's rolled ratio. Drawn fresh
# per offering team per pick from uniform [-_TRADE_UP_OFFSET, +_TRADE_UP_OFFSET].
# Adds per-team variance so two AI teams rolling the same threshold bucket
# can land at meaningfully different M_up values. With the range centered on
# zero, half the time the offset closes the window vs the trade-down team's
# M_down and half the time it opens it — adds realistic deal/no-deal variance.
_TRADE_UP_OFFSET: float = 0.049

# When the user is on the clock, each AI team gets a per-team floor of
# max(_USER_TRADE_DOWN_HARD_FLOOR, m_up - _USER_TRADE_DOWN_FLOOR_OFFSET)
# instead of the cached m_down=0. The relative offset prevents very narrow
# windows; the hard floor blocks anyone from sending lowball offers below
# 0.95× value back to the user.
_USER_TRADE_DOWN_FLOOR_OFFSET: float = 0.05
_USER_TRADE_DOWN_HARD_FLOOR: float = 0.95

# Probability that a side will even consider including a future-year pick
# in their package. Each side rolls independently per offer. Trade-down side
# is slightly more restrictive — teams are less willing to accept NEXT YEAR
# capital back than they are to spend it moving up.
_FUTURE_PICK_GATE_UP: float = 0.15
_FUTURE_PICK_GATE_DOWN: float = 0.10

# Cap on how many future picks a single side can include.
_MAX_FUTURE_PICKS_PER_SIDE: int = 1


def _roll_trade_threshold(round_1: int, is_trade_up: bool) -> float:
    """Roll an acceptance/offer ratio from the round-keyed table.

    Trade-up rolls receive a fresh random offset drawn from uniform
    [-``_TRADE_UP_OFFSET``, +``_TRADE_UP_OFFSET``]. Each offering team gets
    a different effective M_up even when they roll the same base bucket.
    """
    table = _TRADE_THRESHOLD_TABLE.get(round_1, _TRADE_THRESHOLD_TABLE[2])
    r = random.random()
    cumulative = 0.0
    base = table[-1][0]
    for ratio, prob in table:
        cumulative += prob
        if r <= cumulative:
            base = ratio
            break
    if is_trade_up:
        return base + random.uniform(-_TRADE_UP_OFFSET, _TRADE_UP_OFFSET)
    return base


def _slide_prob(current_slot: int, rank: int | None) -> float:
    """Convert a board-slide ratio into a trade-down probability component.

    Returns a "base" value — the caller (`_trade_down_probability`) applies
    a round-based impact multiplier on top of this (BPA vs. need weights
    differ by round, so the same slide signal matters differently across
    early vs. late rounds).
    """
    effective_rank = rank or current_slot
    ratio = (current_slot - effective_rank) / current_slot
    if ratio >= 0.4:
        return 0.05
    if ratio >= 0.33:
        return 0.10
    if ratio >= 0.25:
        return 0.35
    if ratio >= 0.125:
        return 0.75
    if ratio >= 0.0:
        return 0.90
    return 0.95


def _slide_prob_up(current_slot: int, rank: int | None) -> float:
    """Convert a board-slide ratio into a trade-up probability component.

    Mirror of `_slide_prob`: a player ranked well above the current pick slot
    (large positive ratio) makes a team more willing to trade up. Returns a
    "base" value — the caller (`_trade_up_probability`) applies a round-based
    impact multiplier on top (BPA vs. need weights differ by round).
    """
    effective_rank = rank or current_slot
    ratio = (current_slot - effective_rank) / current_slot
    if ratio >= 0.40:
        return 0.5
    if ratio >= 0.33:
        return 0.33
    if ratio >= 0.25:
        return 0.2
    if ratio >= 0.125:
        return 0.05
    if ratio >= 0.0:
        return 0.01
    return 0.001


def _trade_down_probability(state: dict[str, Any], pick: dict[str, Any]) -> float:
    """Return the probability (0–1) that the on-clock team is willing to trade down.

    Components:
      1. BPA slide via _slide_prob × round-based bpa_impact weight (Round 1:
         0.25, Rounds 2/3: 0.50, Rounds 4-7: 0.75).
      2. Need slide via _slide_prob × round-based need_impact weight (Round 1:
         0.75, Rounds 2/3: 0.50, Rounds 4-7: 0.25). Round 1 is need-driven so
         a need-slide signal dominates; late rounds are BPA-driven.
      3. Hot-zone bonus for attractive slots (pick 33 +15 pp, etc.).
    Sum × GM TradeDown trait multiplier × portfolio multiplier from
    `_portfolio_multiplier_down` × cooldown multiplier (0.10× if this team's
    last on-clock action was a trade, 1.0× otherwise — discourages back-to-
    back trade-downs) × `_round_modifier_down` (R1 0.90×, R2-3 1.10×,
    R4-6 1.15×, R7 1.25×). Clamped to [5%, 95%].
    """
    on_clock_team = pick.get("current_team")
    current_slot = pick.get("draft_slot") or pick.get("overall") or 1
    round_1 = pick.get("round", 1)
    pick_in_round = pick.get("pick_in_round", 1)

    player_map = {p.get("Player_ID"): p for p in state["big_board"]["players"]}
    team_board = state.get("team_boards", {}).get(on_clock_team, [])
    # 1-indexed rank of each player on this team's private board (all players,
    # including drafted, so the rank reflects their pre-draft assessment).
    team_rank = {pid: i + 1 for i, pid in enumerate(team_board)}
    available = [player_map[pid] for pid in team_board
                 if pid in player_map and not player_map[pid].get("drafted")]

    # Round-based impact weights — what matters more in this round, BPA or
    # need? Round 1 picks are need-driven so a need-slide signal dominates;
    # late-round picks are BPA-driven so a BPA-slide signal dominates.
    if round_1 == 1:
        bpa_impact, need_impact = 0.25, 0.75
    elif round_1 in (2, 3):
        bpa_impact, need_impact = 0.40, 0.60
    else:  # rounds 4-7
        bpa_impact, need_impact = 0.50, 0.50

    # Component 1: BPA slide using team's private rank.
    bpa = available[0] if available else None
    bpa_prob = _slide_prob(current_slot, team_rank.get(bpa.get("Player_ID")) if bpa else None) * bpa_impact

    # Component 2: Best eligible need player slide using team's private rank.
    _, (win_min, win_max), _ = _round_bucket(round_1, pick_in_round)
    gm = next((g for g in state["gm_info"] if g.get("TeamName") == on_clock_team), {})
    gm_index = gm.get("TeamIndex")
    needs = (_get_needs(state, on_clock_team, int(gm_index))
             if gm_index is not None else [])
    eligible = {n["position"] for n in needs if win_min < n["weight"] <= win_max}
    best_need = next(
        (p for p in available
         if POSITION_GROUPS.get(p.get("position"), p.get("position")) in eligible),
        None,
    )
    need_prob = _slide_prob(current_slot, team_rank.get(best_need.get("Player_ID")) if best_need else None) * need_impact

    # Hot-zone bonus: certain pick slots are especially attractive trade-down
    # targets, boosting willingness before the GM multiplier is applied.
    if current_slot == 1:
        hot_zone = -0.50
    elif current_slot == 33:
        hot_zone = 0.15
    elif 30 <= current_slot <= 32 or 34 <= current_slot <= 35:
        hot_zone = 0.075
    elif 20 <= current_slot <= 29 or 36 <= current_slot <= 42:
        hot_zone = 0.05
    else:
        hot_zone = 0.025

    # Portfolio multiplier (inverted): pick-rich teams less willing to trade
    # down (already have plenty), pick-poor teams more willing.
    all_picks = state.get("remaining_picks", []) + state.get("future_picks", [])
    current_year_remaining = [p for p in all_picks
                              if p.get("year_offset", 0) == 0
                              and not p.get("selected_player_id")]
    team_remaining_count = sum(1 for p in current_year_remaining
                               if p.get("current_team") == on_clock_team)
    total_remaining = len(current_year_remaining)
    share = (team_remaining_count / total_remaining) if total_remaining > 0 else 0.0
    portfolio_mult = _portfolio_multiplier_down(share)

    # Cooldown: decay willingness based on how many drafts have happened
    # since this team's last trade-down. Counter resets to 0 on every trade
    # and increments per draft. Fully back to baseline after 2 drafts.
    events_since_trade = state.get("events_since_trade_per_team", {}).get(on_clock_team)
    cooldown_mult = _cooldown_for_events_since(events_since_trade)

    trait = max(1, min(5, int(gm.get("TradeDown") or 3)))
    gm_multiplier = {1: 0.9, 2: 0.95, 3: 1.0, 4: 1.05, 5: 1.1}[trait]
    round_mod = _round_modifier_down(round_1)
    return max(0.075, min(0.95,
        (bpa_prob + need_prob + hot_zone) * gm_multiplier * portfolio_mult * cooldown_mult * round_mod))


def _distance_multiplier(value_ratio: float) -> float:
    """Dampen trade-up willingness by how close the offering team's highest
    remaining current-year pick is to the target — in VALUE, not slot number.

    value_ratio = team_high_pick_value / target_pick_value. The Jimmy-Johnson
    chart naturally normalizes across rounds (a 15-slot gap in round 1 is a
    much bigger value gap than 15 slots in round 7).
    """
    if value_ratio >= 0.85:
        return 1.00
    if value_ratio >= 0.75:
        return 0.85
    if value_ratio >= 0.65:
        return 0.75
    if value_ratio >= 0.50:
        return 0.5
    if value_ratio >= 0.25:
        return 0.25
    return 0.125


def _portfolio_multiplier(share: float) -> float:
    """Scale trade-up willingness by the team's current-year pick-portfolio share.

    share = team's remaining current-year picks / total remaining current-year
    picks across the league. League average is ~3.1% (1/32). Above average →
    pick-rich, more willing; below average → pick-poor, less willing.
    """
    if share >= 0.050:
        return 1.25
    if share >= 0.045:
        return 1.125
    if share >= 0.040:
        return 1.00
    if share >= 0.035:
        return 0.875
    if share >= 0.025:
        return 0.75
    if share >= 0.020:
        return 0.50
    return 0.25


def _round_modifier_up(round_1: int) -> float:
    """Round-based multiplier for trade-UP willingness. Late rounds get a
    bigger boost since late-round picks change hands more freely.
    """
    if round_1 == 1:
        return 1.20
    if round_1 in (2, 3):
        return 0.95
    if round_1 == 4:
        return 0.70
    if round_1 == 5:
        return 0.75
    if round_1 == 6:
        return 0.85
    return 1.05  # round 7+


def _round_modifier_down(round_1: int) -> float:
    """Round-based multiplier for trade-DOWN willingness. Dampens round 1
    (teams hold their R1 picks tightly) and boosts late rounds significantly.
    """
    if round_1 == 1:
        return 0.75
    if round_1 == 2:
        return 1.10
    if round_1 == 3:
        return 1.20
    if round_1 == 4:
        return 1.40
    if round_1 == 5:
        return 1.55
    if round_1 == 6:
        return 2.25
    return 2.75  # round 7


def _cooldown_for_events_since(n: int | None) -> float:
    """Trade-down willingness cooldown based on drafts since last trade.

    n is None when the team has never traded down — full willingness.
    Otherwise n counts drafts since the most recent trade-down: 0 means
    "just traded, no drafts since," and willingness recovers as the team
    drafts players. Fully restored at n >= 2.
    """
    if n is None:
        return 1.0
    if n == 0:
        return 0.50
    if n == 1:
        return 0.75
    return 1.0  # n >= 2


def _portfolio_multiplier_down(share: float) -> float:
    """Top-to-bottom flip of _portfolio_multiplier for trade-DOWN willingness.

    Pick-rich teams (high share) are LESS willing to trade down — they
    already have plenty of capital. Pick-poor teams (low share) are MORE
    willing — they want to acquire more picks.
    """
    if share >= 0.05:
        return 0.25
    if share >= 0.045:
        return 0.33
    if share >= 0.040:
        return 0.50
    if share >= 0.035:
        return 0.75
    if share >= 0.030:
        return 0.875
    if share >= 0.025:
        return 1.0
    if share >= 0.020:
        return 1.125
    if share >= 0.015:
        return 1.25
    return 1.5


def _trade_up_probability(state: dict[str, Any], gm: dict[str, Any], target_pick: dict[str, Any]) -> float:
    """Return the probability (0–1) that a team is willing to trade up to target_pick.

    Five components combined multiplicatively:
      1. (bpa_prob + need_prob): each scored by `_slide_prob_up` × a round-based
         impact weight (Round 1: bpa 0.25 / need 0.75; Rounds 2-3: 0.50 each;
         Rounds 4-7: bpa 0.75 / need 0.25). Round 1 trades chase needs; late-
         round trades chase BPA.
      2. GM TradeUp trait multiplier (0.75–1.25x).
      3. Distance multiplier from _distance_multiplier — dampens willingness
         when the team's highest remaining current-year pick is far (in value)
         from the target. Caps at 1.0 (no boost).
      4. Portfolio multiplier from _portfolio_multiplier — scales by the team's
         share of remaining current-year picks across the league. Pick-rich
         teams (>5%) get up to 1.25x; pick-poor teams (<1.5%) drop to 0.50x.
      5. Round modifier from `_round_modifier_up`: R1-2 1.00×, R3-5 1.10×,
         R6-7 1.15×. Boosts late-round trade-ups.
    Final result clamped to [0.1%, 50%] — trade-up willingness is the rarer event.
    """
    offering_team = gm.get("TeamName")
    target_slot = target_pick.get("draft_slot") or target_pick.get("overall") or 1
    round_1 = target_pick.get("round", 1)
    pick_in_round = target_pick.get("pick_in_round", 1)

    player_map = {p.get("Player_ID"): p for p in state["big_board"]["players"]}
    team_board = state.get("team_boards", {}).get(offering_team, [])
    team_rank = {pid: i + 1 for i, pid in enumerate(team_board)}
    available = [player_map[pid] for pid in team_board
                 if pid in player_map and not player_map[pid].get("drafted")]

    # Round-based impact weights — same logic as _trade_down_probability.
    # Round 1 is need-driven; rounds 4-7 are BPA-driven. Trade-up willingness
    # responds more strongly to whichever signal matches the round's flavor.
    if round_1 == 1:
        bpa_impact, need_impact = 0.34, 0.66
    elif round_1 in (2, 3):
        bpa_impact, need_impact = 0.40, 0.60
    else:  # rounds 4-7
        bpa_impact, need_impact = 0.50, 0.50

    # Component 1: BPA slide using team's private rank vs target slot.
    bpa = available[0] if available else None
    bpa_prob = _slide_prob_up(target_slot, team_rank.get(bpa.get("Player_ID")) if bpa else None) * bpa_impact

    # Component 2: Best eligible need player slide using target pick's round window.
    _, (win_min, win_max), _ = _round_bucket(round_1, pick_in_round)
    gm_index = gm.get("TeamIndex")
    needs = (_get_needs(state, offering_team, int(gm_index))
             if gm_index is not None else [])
    eligible = {n["position"] for n in needs if win_min < n["weight"] <= win_max}
    best_need = next(
        (p for p in available
         if POSITION_GROUPS.get(p.get("position"), p.get("position")) in eligible),
        None,
    )
    need_prob = _slide_prob_up(target_slot, team_rank.get(best_need.get("Player_ID")) if best_need else None) * need_impact

    # Distance multiplier: value ratio of team's highest remaining current-year
    # pick (after target) vs the target pick itself. No eligible picks → far.
    target_overall = target_pick.get("overall", 0)
    all_picks = state.get("remaining_picks", []) + state.get("future_picks", [])
    team_eligible_current = [
        p for p in all_picks
        if p.get("current_team") == offering_team
        and not p.get("selected_player_id")
        and p.get("year_offset", 0) == 0
        and p.get("overall", 0) > target_overall
    ]
    target_val = pick_value(target_pick, state["pick_values"])
    if team_eligible_current and target_val > 0:
        high_val = max(pick_value(p, state["pick_values"]) for p in team_eligible_current)
        value_ratio = high_val / target_val
    else:
        value_ratio = 0.0
    distance_mult = _distance_multiplier(value_ratio)

    # Portfolio multiplier: team's share of remaining current-year picks across
    # the league. Pick-rich teams are more willing to spend assets to trade up.
    current_year_remaining = [p for p in all_picks
                              if p.get("year_offset", 0) == 0
                              and not p.get("selected_player_id")]
    team_remaining_count = sum(1 for p in current_year_remaining
                               if p.get("current_team") == offering_team)
    total_remaining = len(current_year_remaining)
    share = (team_remaining_count / total_remaining) if total_remaining > 0 else 0.0
    portfolio_mult = _portfolio_multiplier(share)

    trait = max(1, min(5, int(gm.get("TradeUp") or 3)))
    gm_multiplier = {1: 0.90, 2: 0.95, 3: 1.0, 4: 1.05, 5: 1.1}[trait]
    round_mod = _round_modifier_up(round_1)
    return max(0.001, min(0.5,
        (bpa_prob + need_prob) * gm_multiplier * distance_mult * portfolio_mult * round_mod))


def willing_to_trade_down(state: dict[str, Any], pick: dict[str, Any]) -> bool:
    """Roll to decide if the on-clock team considers trading down."""
    return random.random() <= _trade_down_probability(state, pick)


def pick_value(pick: dict[str, Any], pick_value_table: dict[str, Any]) -> float:
    """Return the Jimmy-Johnson-style value of a single pick.

    Accepts both raw DraftPicks.xlsx dicts (keys ``PickNumber``, ``YearOffset``)
    and the internal ``_pick_to_dict`` format (keys ``draft_slot``, ``year_offset``).
    Future-year picks use the ``Future`` sheet.

    Hot path: trade-offer enumeration looks up hundreds of picks per pick
    cycle. Uses the pre-built ``by_pick`` dict from ``load_draft_pick_value``
    when available so each call is O(1); falls back to the linear scan if a
    caller hands in a hand-rolled table without the lookup.
    """
    overall = pick.get("draft_slot") or pick.get("PickNumber") or pick.get("overall")
    if overall is None:
        return 0.0
    raw_offset = pick.get("YearOffset")
    year_offset = raw_offset if raw_offset is not None else (pick.get("year_offset") or 0)
    by_pick = pick_value_table.get("by_pick") if isinstance(pick_value_table, dict) else None
    if by_pick is not None:
        return by_pick.get((int(overall), int(year_offset) or 0), 0.0)
    sheet = pick_value_table["current"] if not year_offset else pick_value_table["future"]
    target = int(overall) - 1  # DraftPickValue.xlsx Pick column is 0-indexed
    for row in sheet:
        if row.get("Pick") == target:
            return float(row.get("Value") or 0)
    return 0.0


# Per-team complexity tiers — (max_offered, max_return). Smaller-package
# trades are tried first; if no valid combo exists at the rolled tier, the
# search escalates to the next tier. Biases the league toward 1-for-2 and
# 2-for-2 deals over 3-for-2 / 3-for-3 monstrosities.
_COMPLEXITY_TIERS: list[tuple[int, int]] = [(2, 1), (3, 1), (3, 2)]
_COMPLEXITY_TIER_CUMULATIVE: list[float] = [0.80, 0.90, 1.00]


def _roll_complexity_tier() -> int:
    """Return the starting tier index (0/1/2) for this team's offer."""
    r = random.random()
    for i, cum in enumerate(_COMPLEXITY_TIER_CUMULATIVE):
        if r < cum:
            return i
    return len(_COMPLEXITY_TIERS) - 1


# Selection mode weights — how the trade-up team picks one combo from all
# valid (offered, return) pairs. Mix of "cheap" / "generous" / "random"
# behaviors so different teams produce visibly different offers.
_SELECTION_MODE_WEIGHTS: list[tuple[str, float]] = [
    ("min_cost",    0.20),   # smallest offered_val − return_val
    ("min_ratio",   0.25),   # smallest offered_val / (target_val + return_val)
    ("max_cost",    0.075),  # largest offered_val − return_val (most generous outlay)
    ("max_ratio",   0.125),  # largest ratio (most generous per-unit)
    ("min_value",   0.30),   # smallest offered_val + return_val (small package)
    ("random_deal", 0.05),   # uniform random among valid combos
]


def _roll_selection_mode() -> str:
    """Return one of min_cost / min_ratio / max_cost / max_ratio / min_value /
    random_deal according to ``_SELECTION_MODE_WEIGHTS``."""
    r = random.random()
    cumulative = 0.0
    for mode, weight in _SELECTION_MODE_WEIGHTS:
        cumulative += weight
        if r < cumulative:
            return mode
    return _SELECTION_MODE_WEIGHTS[-1][0]


def _select_combo(combos: list[dict[str, Any]], mode: str) -> dict[str, Any]:
    """Pick one combo from the valid pool based on ``mode``.

    All deterministic modes tiebreak on fewer total picks; ``random_deal``
    skips the tiebreak entirely.
    """
    def picks(c: dict[str, Any]) -> int:
        return len(c["offered"]) + len(c["ret"])

    if mode == "random_deal":
        return random.choice(combos)
    if mode == "min_cost":
        return min(combos, key=lambda c: (c["offered_val"] - c["return_val"], picks(c)))
    if mode == "min_ratio":
        return min(combos, key=lambda c: (c["ratio"], picks(c)))
    if mode == "max_cost":
        return max(combos, key=lambda c: (c["offered_val"] - c["return_val"], -picks(c)))
    if mode == "max_ratio":
        return max(combos, key=lambda c: (c["ratio"], -picks(c)))
    if mode == "min_value":
        return min(combos, key=lambda c: (c["offered_val"] + c["return_val"], picks(c)))
    return combos[0]  # fallback


# Selection mode weights for the trade-DOWN side — how the on-clock CPU team
# picks which offer to accept. Different "personalities" produce visibly
# different acceptance patterns across the league.
_DOWN_SELECTION_MODE_WEIGHTS: list[tuple[str, float]] = [
    ("max_ratio",      0.40),   # highest offered/(target+return)
    ("max_value",      0.40),   # highest net value (offered − return)
    ("nearest_pick",   0.10),   # offer whose closest current-year pick is nearest the target
    ("furthest_pick",  0.10),   # offer whose closest current-year pick is furthest from target
]


def _roll_down_selection_mode() -> str:
    """Roll one of max_ratio / max_value / nearest_pick / furthest_pick."""
    r = random.random()
    cumulative = 0.0
    for mode, weight in _DOWN_SELECTION_MODE_WEIGHTS:
        cumulative += weight
        if r < cumulative:
            return mode
    return _DOWN_SELECTION_MODE_WEIGHTS[-1][0]


def select_trade_down_offer(offers: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick which offer the trade-down team accepts based on a rolled mode.

    Called by `DraftSession._best_qualifying_cpu_offer` to add personality
    to the on-clock team's acceptance behavior. The offers list itself is
    already pre-filtered to satisfy the ratio window; this just chooses
    among them by a randomly-rolled criterion (40/40/10/10 split).
    """
    if not offers:
        return None

    def ratio(o: dict[str, Any]) -> float:
        denom = o["target_value"] + o["return_value"]
        return (o["offer_value"] / denom) if denom > 0 else 0.0

    def net_value(o: dict[str, Any]) -> float:
        return o["offer_value"] - o["return_value"]

    def offered_distance(o: dict[str, Any]) -> float | None:
        """Distance (overall) from the on-clock pick to the closest current-
        year pick in the offered package. None if no current-year picks."""
        target_overall = o["target_pick"]["overall"]
        current_picks = [p["overall"] for p in o["offered_picks"]
                         if p.get("year_offset", 0) == 0]
        if not current_picks:
            return None
        return min(current_picks) - target_overall

    mode = _roll_down_selection_mode()
    if mode == "max_ratio":
        return max(offers, key=ratio)
    if mode == "max_value":
        return max(offers, key=net_value)
    if mode == "nearest_pick":
        valid = [o for o in offers if offered_distance(o) is not None]
        return min(valid, key=offered_distance) if valid else offers[0]
    if mode == "furthest_pick":
        valid = [o for o in offers if offered_distance(o) is not None]
        return max(valid, key=offered_distance) if valid else offers[0]
    return offers[0]  # fallback


def _best_offer_for_team(value_of: dict[int, float], anchors: list[dict[str, Any]],
                         team_picks: list[dict[str, Any]],
                         down_team_picks: list[dict[str, Any]],
                         m_up: float, m_down: float,
                         target_val: float) -> dict[str, Any] | None:
    """Find the trade-up team's chosen (offered, return) combo.

    Two layered rolls:
      1. Complexity tier (`_roll_complexity_tier`): caps max offered/return
         picks. Escalates to the next tier if no valid combo exists at the
         rolled tier (see `_COMPLEXITY_TIERS`).
      2. Selection mode (`_roll_selection_mode`): one of six modes
         (min_cost / min_ratio / max_cost / max_ratio / min_value /
         random_deal) — chosen once per offer, applied to the full pool
         of valid combos at the resolved tier.

    ``anchors`` is the list of mandatory-anchor picks (one or two): always
    includes the highest-value current-year pick; may also include the
    highest-value future-year pick (when the future-pick gate passed AND
    that pick's value is below `1.1 * target_val`).

    Subject to:
      - 1 ≤ |offered| ≤ 3, 0 ≤ |return| ≤ 2
      - net pick count for trade-down in [0, 2]
      - m_down ≤ offered_val / (target_val + return_val) ≤ m_up
      - each side capped at _MAX_FUTURE_PICKS_PER_SIDE future picks
      - no 1-for-1 same-year swaps

    Returns dict with offered_picks/return_picks/offer_value/return_value or
    None if no valid combination exists at any tier.
    """
    selection_mode = _roll_selection_mode()
    tier_start = _roll_complexity_tier()

    # Pre-compute the team's "next 3" eligible current-year picks (earliest
    # by overall). Any offer consisting of exactly these three is rejected
    # below — sending your next 3 actual upcoming picks for one current pick
    # is unrealistically aggressive.
    team_current_sorted = sorted(
        (p for p in team_picks if p.get("year_offset", 0) == 0),
        key=lambda p: p.get("overall", 0),
    )
    next_three_ids = {id(p) for p in team_current_sorted[:3]} if len(team_current_sorted) >= 3 else set()

    for tier_idx in range(tier_start, len(_COMPLEXITY_TIERS)):
        max_offered, max_return = _COMPLEXITY_TIERS[tier_idx]

        # Enumerate offered packages within tier cap; anchor mandatory.
        offered_candidates: list[list[dict[str, Any]]] = []
        for anchor in anchors:
            others = [p for p in team_picks if p is not anchor]
            for k in range(0, max_offered):
                for combo in itertools.combinations(others, k):
                    pkg = [anchor] + list(combo)
                    if sum(1 for p in pkg if p.get("year_offset", 0) > 0) > _MAX_FUTURE_PICKS_PER_SIDE:
                        continue
                    # Reject offers that consist of the team's next 3 current-
                    # year picks — too aggressive to surrender all near-term
                    # selections for one trade up.
                    if (len(pkg) == 3 and next_three_ids
                            and all(id(p) in next_three_ids for p in pkg)):
                        continue
                    offered_candidates.append(pkg)

        valid_combos: list[dict[str, Any]] = []
        for offered in offered_candidates:
            offered_val = sum(value_of[id(p)] for p in offered)
            n_offered = len(offered)

            for n_return in range(0, max_return + 1):
                net_pick_count = n_offered - 1 - n_return
                if net_pick_count < 0 or net_pick_count > 2:
                    continue
                return_combos: list[tuple[dict[str, Any], ...]] = (
                    [()] if n_return == 0
                    else list(itertools.combinations(down_team_picks, n_return))
                )
                for ret in return_combos:
                    if sum(1 for p in ret if p.get("year_offset", 0) > 0) > _MAX_FUTURE_PICKS_PER_SIDE:
                        continue
                    # Reject 1-for-1 same-year swaps: meaningless when pick
                    # values are near-equal (common late in the draft).
                    if (n_offered == 1 and n_return == 0
                            and offered[0].get("year_offset", 0) == 0):
                        continue
                    return_val = sum(value_of[id(p)] for p in ret)
                    denom = target_val + return_val
                    if denom <= 0:
                        continue
                    ratio = offered_val / denom
                    if ratio < m_down or ratio > m_up:
                        continue
                    valid_combos.append({
                        "offered": list(offered),
                        "ret": list(ret),
                        "offered_val": offered_val,
                        "return_val": return_val,
                        "ratio": ratio,
                    })

        if valid_combos:
            chosen = _select_combo(valid_combos, selection_mode)
            return {
                "offered_picks": chosen["offered"],
                "return_picks": chosen["ret"],
                "offer_value": chosen["offered_val"],
                "return_value": chosen["return_val"],
            }

    return None  # no valid combo even at the most permissive tier


def generate_trade_offers_for_pick(state: dict[str, Any], pick: dict[str, Any],
                                   m_down: float) -> list[dict[str, Any]]:
    """Return CPU trade-up offers for the given pick, ranked by ratio.

    Caller is responsible for the willingness roll AND for rolling ``m_down``
    once per pick; that result is cached on the session so CPU + user paths
    share it.

    Flow:
    1. Roll the trade-down team's future-pick gate (caps their return-pick
       pool at 0 or 1 future picks).
    2. For each other team that passes their trade-up willingness roll AND
       whose rolled M_up ≥ m_down, build a valid (offered, return) combo
       (50/50 between min-cost and min-ratio selection) subject to:
         - 1 ≤ |offered| ≤ 3 and 0 ≤ |return| ≤ 2
         - net pick count for trade-down team in [0, 2]
         - m_down ≤ offered_val / (target_val + return_val) ≤ M_up
         - offered package anchored on the team's highest-value current-year
           pick OR (if their future-pick gate passed) their highest-value
           future pick worth less than the target
         - each side respects _MAX_FUTURE_PICKS_PER_SIDE + future-pick gate
    3. Return offers sorted by ratio offered/(target+return) descending; tie-
       break on fewer total picks. The trade-down team picks the most
       efficient offer across teams (highest value-per-unit-sent).
    """
    if not pick:
        return []

    on_clock_team = pick.get("current_team")
    user_team = state.get("user_team")
    is_user_pick = on_clock_team == user_team
    round_1 = pick.get("round", 1)

    target_val = pick_value(pick, state["pick_values"])
    if target_val <= 0:
        return []

    target_overall = pick.get("overall", 0)
    all_picks = state.get("remaining_picks", []) + state.get("future_picks", [])

    # Precompute pick values keyed by id() (stable within this call only).
    value_of = {id(p): pick_value(p, state["pick_values"]) for p in all_picks}

    def _is_eligible(p: dict[str, Any]) -> bool:
        return (p.get("year_offset", 0) > 0
                or p.get("overall", 0) > target_overall)

    # Trade-down team's full return-pick pool (future filtering happens per
    # team inside the loop so each AI independently rolls whether they're
    # allowed to request a future pick back — matches the offered-side gate).
    down_team_picks_all = [p for p in all_picks
                           if p.get("current_team") == on_clock_team and _is_eligible(p)]

    offers: list[dict[str, Any]] = []
    for gm in state["gm_info"]:
        team = gm.get("TeamName")
        if not team or team == on_clock_team or team == user_team:
            continue
        if random.random() > _trade_up_probability(state, gm, pick):
            continue

        m_up = _roll_trade_threshold(round_1, is_trade_up=True)
        # When the user is on clock, derive a per-team floor from this AI's
        # m_up so the window stays at least _USER_TRADE_DOWN_FLOOR_OFFSET wide,
        # AND clamp the floor up to _USER_TRADE_DOWN_HARD_FLOOR to block
        # truly lowball offers from reaching the user.
        if is_user_pick:
            effective_m_down = max(_USER_TRADE_DOWN_HARD_FLOOR,
                                   m_up - _USER_TRADE_DOWN_FLOOR_OFFSET)
        else:
            effective_m_down = m_down
        if m_up < effective_m_down:
            continue

        team_picks = [p for p in all_picks
                      if p.get("current_team") == team and _is_eligible(p)]
        if random.random() > _FUTURE_PICK_GATE_UP:
            team_picks = [p for p in team_picks if p.get("year_offset", 0) == 0]

        # Future-pick round floor: when the trade-up team is offering a future
        # pick, that pick's round must be no earlier than (target_round - 1),
        # with a special case for round-2 targets (floor is round 2, not 1).
        # Round 1 targets have no floor (1 is already the earliest round).
        min_future_round = 1 if round_1 == 1 else max(2, round_1 - 1)
        team_picks = [p for p in team_picks
                      if p.get("year_offset", 0) == 0
                      or p.get("round", 1) >= min_future_round]

        # Independent gate: does this AI get to ask for a future return pick?
        down_team_picks = down_team_picks_all
        if random.random() > _FUTURE_PICK_GATE_DOWN:
            down_team_picks = [p for p in down_team_picks if p.get("year_offset", 0) == 0]

        current_year_picks = [p for p in team_picks if p.get("year_offset", 0) == 0]
        if not current_year_picks:
            continue
        p_high = max(current_year_picks, key=lambda p: value_of[id(p)])
        anchors = [p_high]

        # If the team's future-pick gate passed (future picks remain in
        # team_picks), they MAY anchor on their highest-value future pick
        # instead of P_high — allowing up to 1.15× the target's value (a
        # slight overshoot is OK since the trade-down team can send back
        # a small balancing pick). Much larger F_high values would require
        # impossibly large return packages, so they're filtered here.
        future_picks_eligible = [p for p in team_picks
                                 if p.get("year_offset", 0) > 0
                                 and value_of[id(p)] < 1.15 * target_val]
        if future_picks_eligible:
            f_high = max(future_picks_eligible, key=lambda p: value_of[id(p)])
            anchors.append(f_high)

        best = _best_offer_for_team(
            value_of, anchors, team_picks, down_team_picks,
            m_up, effective_m_down, target_val,
        )
        if best is None:
            continue

        offers.append({
            "from_team": team,
            "to_team": on_clock_team,
            "target_pick": pick,
            "offered_picks": best["offered_picks"],
            "return_picks": best["return_picks"],
            "offer_value": round(best["offer_value"], 1),
            "return_value": round(best["return_value"], 1),
            "target_value": round(target_val, 1),
            "m_up": round(m_up, 3),
            "m_down": round(effective_m_down, 3),
        })

    def _sort_key(o: dict[str, Any]) -> tuple[float, int]:
        # Ratio = value-received / value-sent, the same ratio used by the
        # m_down/m_up filter. Sorting by ratio (descending) rewards efficient
        # trades — a 1.10x deal beats a 1.05x deal even if the absolute net
        # of the 1.05x package is larger. Tiebreak: fewer total picks.
        denom = o["target_value"] + o["return_value"]
        ratio = (o["offer_value"] / denom) if denom > 0 else 0.0
        return (-ratio, len(o["offered_picks"]) + len(o["return_picks"]))

    offers.sort(key=_sort_key)
    return offers


def attempt_user_trade_up(state: dict[str, Any], target_pick: dict[str, Any],
                          offered_picks: list[dict[str, Any]]) -> dict[str, Any]:
    """Evaluate the value of the user's trade-up offer.

    Returns offer_value and target_value so the caller (draft_state) can
    compare against competing CPU offers and the threshold.  Acceptance
    is decided in ``DraftSession.submit_user_trade_up``, not here.
    """
    offer_val = sum(pick_value(p, state["pick_values"]) for p in offered_picks)
    target_val = pick_value(target_pick, state["pick_values"])
    return {
        "offer_value": round(offer_val, 1),
        "target_value": round(target_val, 1),
    }


def attempt_user_trade_down(state: dict[str, Any], m_down: float) -> list[dict[str, Any]]:
    """Return AI-generated trade-up offers targeted at the user's current pick.

    Caller must pass the cached ``m_down`` roll for the current pick.
    """
    current = state.get("current_pick")
    if not current:
        return []
    return generate_trade_offers_for_pick(state, current, m_down)


# -----------------------------------------------------------------------------
# RNG helpers
# -----------------------------------------------------------------------------

def seeded_rng(seed: int | None) -> random.Random:
    """Return a ``random.Random`` instance, optionally seeded."""
    return random.Random(seed)
