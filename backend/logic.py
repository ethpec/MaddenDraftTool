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
    needs = compute_team_needs(team_name, int(gm_index), state["players"], state["position_needs"]) if gm_index is not None else []
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

# TradeDown trait (1–5) -> minimum offer/pick-value ratio for acceptance.
# Higher trait = more willing to trade down = accepts a lower ratio.
_TRADE_DOWN_THRESHOLD: dict[int, float] = {1: 1.10, 2: 1.05, 3: 1.00, 4: 0.95, 5: 0.90}

# TradeUp trait (1–5) -> probability a team makes a trade-up offer.
_TRADE_UP_PROB: dict[int, float] = {1: 0.05, 2: 0.15, 3: 0.25, 4: 0.35, 5: 0.45}


def _slide_prob(current_slot: int, rank: int | None) -> float:
    """Convert a board-slide ratio into a trade-down probability component."""
    effective_rank = rank or current_slot
    ratio = (current_slot - effective_rank) / current_slot
    if ratio >= 0.25:
        return 0.05
    if ratio >= 0.125:
        return 0.15
    return 0.25


def _trade_down_probability(state: dict[str, Any], pick: dict[str, Any]) -> float:
    """Return the probability (0–1) that the on-clock team is willing to trade down.

    Two components, each contributing 0.05 / 0.15 / 0.25:
      1. BPA slide: how far the team's #1 available player has slid vs. the pick.
      2. Need slide: how far the best board player that fills an eligible need
         has slid vs. the pick (75% if no eligible need match exists).
    The two are summed, then the GM TradeDown trait adds/subtracts ±5–10 pp,
    and the result is clamped to [5%, 95%].
    """
    on_clock_team = pick.get("current_team")
    current_slot = pick.get("draft_slot") or pick.get("overall") or 1
    round_1 = pick.get("round", 1)
    pick_in_round = pick.get("pick_in_round", 1)

    player_map = {p.get("Player_ID"): p for p in state["big_board"]["players"]}
    team_board = state.get("team_boards", {}).get(on_clock_team, [])
    available = [player_map[pid] for pid in team_board
                 if pid in player_map and not player_map[pid].get("drafted")]

    # Component 1: BPA slide.
    bpa = available[0] if available else None
    bpa_prob = _slide_prob(current_slot, bpa.get("BigBoardRank") if bpa else None)

    # Component 2: Best eligible need player slide.
    _, (win_min, win_max), _ = _round_bucket(round_1, pick_in_round)
    gm = next((g for g in state["gm_info"] if g.get("TeamName") == on_clock_team), {})
    gm_index = gm.get("TeamIndex")
    needs = (compute_team_needs(on_clock_team, int(gm_index), state["players"], state["position_needs"])
             if gm_index is not None else [])
    eligible = {n["position"] for n in needs if win_min < n["weight"] <= win_max}
    best_need = next(
        (p for p in available
         if POSITION_GROUPS.get(p.get("position"), p.get("position")) in eligible),
        None,
    )
    need_prob = _slide_prob(current_slot, best_need.get("BigBoardRank") if best_need else None)

    trait = max(1, min(5, int(gm.get("TradeDown") or 3)))
    adj = {1: -0.10, 2: -0.05, 3: 0.0, 4: 0.05, 5: 0.10}[trait]
    return max(0.05, min(0.95, bpa_prob + need_prob + adj))


def willing_to_trade_down(state: dict[str, Any], pick: dict[str, Any]) -> bool:
    """Roll to decide if the on-clock team considers trading down."""
    return random.random() <= _trade_down_probability(state, pick)


def trade_down_threshold(gm: dict[str, Any]) -> float:
    """Return the minimum offer/pick-value ratio the team will accept."""
    trait = max(1, min(5, int(gm.get("TradeDown") or 3)))
    return _TRADE_DOWN_THRESHOLD[trait]


def pick_value(pick: dict[str, Any], pick_value_table: dict[str, list[dict[str, Any]]]) -> float:
    """Return the Jimmy-Johnson-style value of a single pick.

    Accepts both raw DraftPicks.xlsx dicts (keys ``PickNumber``, ``YearOffset``)
    and the internal ``_pick_to_dict`` format (keys ``draft_slot``, ``year_offset``).
    Future-year picks use the ``Future`` sheet.
    """
    overall = pick.get("draft_slot") or pick.get("PickNumber") or pick.get("overall")
    if overall is None:
        return 0.0
    raw_offset = pick.get("YearOffset")
    year_offset = raw_offset if raw_offset is not None else (pick.get("year_offset") or 0)
    sheet = pick_value_table["current"] if not year_offset else pick_value_table["future"]
    target = int(overall) - 1  # DraftPickValue.xlsx Pick column is 0-indexed
    for row in sheet:
        if row.get("Pick") == target:
            return float(row.get("Value") or 0)
    return 0.0


def generate_trade_offers_for_pick(state: dict[str, Any], pick: dict[str, Any]) -> list[dict[str, Any]]:
    """Return CPU trade-up offers for the current on-clock pick, or [] if the
    team isn't willing to trade down.

    Flow:
    1. Board-slide check: measure how far the team's BPA has slid relative
       to the current pick. A player right at or below the pick means the
       team can afford to slide; a top talent sitting at a late pick means
       they must take him now.
         ratio = (current_slot - bpa_consensus_rank) / current_slot
         ratio >= 0.25  → 25% trade-down probability
         0.125–0.25     → 50%
         < 0.125        → 75%
    2. For every other team, roll their TradeUp trait for interest.
    3. Interested teams build the cheapest pick package (≤ 3 picks, only
       picks after the target overall or future-year picks) that reaches
       at least 95% of the target pick's Jimmy-Johnson value.
    4. Return offers sorted by total offered value descending.
    """
    if not pick:
        return []

    on_clock_team = pick.get("current_team")

    target_val = pick_value(pick, state["pick_values"])
    if target_val <= 0:
        return []

    min_offer = target_val * 0.95
    target_overall = pick.get("overall", 0)
    all_picks = state.get("remaining_picks", []) + state.get("future_picks", [])

    offers: list[dict[str, Any]] = []
    for gm in state["gm_info"]:
        team = gm.get("TeamName")
        if not team or team == on_clock_team:
            continue
        trade_up_trait = max(1, min(5, int(gm.get("TradeUp") or 3)))
        if random.random() > _TRADE_UP_PROB[trade_up_trait]:
            continue

        # Picks this team can trade: future picks + current picks after the target.
        tradeable = [
            p for p in all_picks
            if p.get("current_team") == team
            and not p.get("selected_player_id")
            and (p.get("year_offset", 0) > 0 or p.get("overall", 0) > target_overall)
        ]
        if not tradeable:
            continue

        # Build cheapest package that reaches target_val, capped at 3 picks.
        valued = sorted(
            [(p, pick_value(p, state["pick_values"])) for p in tradeable],
            key=lambda x: x[1], reverse=True,
        )
        package: list[dict[str, Any]] = []
        total = 0.0
        for p, val in valued:
            if total >= target_val or len(package) >= 3:
                break
            if val > 0:
                package.append(p)
                total += val

        if total < min_offer or not package:
            continue

        offers.append({
            "from_team": team,
            "to_team": on_clock_team,
            "offered_picks": package,
            "target_pick": pick,
            "offer_value": round(total, 1),
            "target_value": round(target_val, 1),
        })

    offers.sort(key=lambda o: o["offer_value"], reverse=True)
    return offers


def evaluate_trade_offer(state: dict[str, Any], offer: dict[str, Any],
                         receiving_team: str) -> dict[str, Any]:
    """Decide whether ``receiving_team`` accepts a given trade offer.

    Compares total offered value against the pick's Jimmy-Johnson value
    scaled by the receiving GM's TradeDown threshold.
    """
    gm = next((g for g in state["gm_info"] if g.get("TeamName") == receiving_team), {})
    threshold = trade_down_threshold(gm)
    target_val = float(offer.get("target_value") or 0)
    offer_val = float(offer.get("offer_value") or 0)
    if target_val <= 0:
        return {"accepted": False, "counter": None, "reason": "no_pick_value"}
    ratio = offer_val / target_val
    if ratio >= threshold:
        return {"accepted": True, "counter": None, "reason": f"meets threshold ({ratio:.2f}x)"}
    return {"accepted": False, "counter": None,
            "reason": f"below threshold ({ratio:.2f}x, need {threshold:.2f}x)"}


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


def attempt_user_trade_down(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Return AI-generated trade-up offers targeted at the user's current pick.

    Delegates to ``generate_trade_offers_for_pick`` for the user's pick.
    Still a placeholder until the user-on-clock trade flow is wired up.
    """
    current = state.get("current_pick")
    if not current:
        return []
    return generate_trade_offers_for_pick(state, current)


# -----------------------------------------------------------------------------
# RNG helpers
# -----------------------------------------------------------------------------

def seeded_rng(seed: int | None) -> random.Random:
    """Return a ``random.Random`` instance, optionally seeded."""
    return random.Random(seed)
