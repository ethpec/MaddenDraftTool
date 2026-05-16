"""In-memory draft state for a single Madden Draft Tool session.

The Flask app holds one ``DraftSession`` at a time (keyed by year). The
state is intentionally not persisted to disk between server restarts —
the *outputs* of a finished draft are persisted via the exporter.

The user controls the Steelers; everything else is AI. UI controls map
1:1 onto methods on this class.
"""

from __future__ import annotations

import random
import threading
from dataclasses import dataclass, field
from typing import Any

from . import logic


USER_TEAM_NAME = "Steelers"


@dataclass
class PickRecord:
    """A single pick on the draft board.

    The draft begins with one PickRecord per row of DraftPicks.xlsx
    where YearOffset == 0. Trades mutate ``current_team`` and append
    entries to the session's trade log; selections set
    ``selected_player_id``.

    ``draft_slot`` is the 1-indexed pick number within that pick's own
    draft year (used for Jimmy Johnson value lookup). For current-year
    picks it equals ``overall``; for future picks it is the projected
    slot from DraftPicks.xlsx, independent of the fake overall ID.
    """
    overall: int            # 1-indexed pick number across all rounds (unique ID)
    round_1: int            # 1-indexed round
    pick_in_round_1: int    # 1-indexed pick within the round
    original_team: str
    current_team: str
    year_offset: int
    draft_slot: int = 0     # slot within the pick's own draft year for value lookup
    selected_player_id: str | None = None
    selected_player_name: str | None = None


@dataclass
class TradeRecord:
    """One trade between two teams."""
    trade_id: int
    overall_pick_traded: int  # the headline pick that triggered the trade
    team_a: str
    team_b: str
    team_a_sends: list[dict[str, Any]] = field(default_factory=list)
    team_b_sends: list[dict[str, Any]] = field(default_factory=list)
    initiated_by: str = "AI"  # "AI" or "USER"


class DraftSession:
    """One end-to-end draft, owning all mutable state."""

    def __init__(self, data: dict[str, Any], user_team: str | None = None):
        self.data = data
        self.lock = threading.Lock()
        self._pick_order: list[PickRecord] = self._build_initial_order(data)
        self._future_picks: list[PickRecord] = self._build_future_picks(data)
        self._team_boards: dict[str, list[str]] = self._build_team_boards(data)
        self._weighted_needs: list[dict[str, Any]] = self._build_weighted_needs(data)
        self._gm_index_map: dict[str, int] = {
            g["TeamName"]: int(g["TeamIndex"])
            for g in data.get("gm_info", [])
            if g.get("TeamName") and g.get("TeamIndex") is not None
        }
        self._roster_lookup: dict[tuple[str, str, str, str], dict[str, Any]] = {
            (p.get("FirstName"), p.get("LastName"),
             p.get("PLYR_DRAFTROUND"), p.get("PLYR_DRAFTPICK")): p
            for p in data.get("players", [])
            if p.get("FirstName") and p.get("LastName")
        }
        self._current_idx: int = 0
        self.trades: list[TradeRecord] = []
        self._next_trade_id: int = 1
        # CPU trade-up offers for the current on-clock pick. Generated lazily
        # on first access per pick and cleared when the pick resolves.
        self._pending_trade_offers: list[dict[str, Any]] | None = None
        self._pending_offers_for_overall: int | None = None
        # Default to Steelers if no team is specified (legacy behavior).
        # Validate against GMInfo so we don't accept arbitrary strings.
        valid_teams = {g["TeamName"] for g in data.get("gm_info", []) if g.get("TeamName")}
        chosen = user_team if user_team in valid_teams else USER_TEAM_NAME
        self.user_team: str = chosen if chosen in valid_teams else (next(iter(valid_teams), USER_TEAM_NAME))

    # -- setup ---------------------------------------------------------------

    def _build_initial_order(self, data: dict[str, Any]) -> list[PickRecord]:
        """Build the ordered list of picks for the upcoming draft.

        Filters to YearOffset == 0 picks (current draft only) and orders
        by Round then PickNumber. Resolves team IDs via the decoded
        TeamIndex byte. The DraftPicks file uses a slightly different
        team-id space than GMInfo (5 teams from GMInfo are missing from
        DraftPicks' lower indices and appear at indices 32-36 instead);
        we patch that with a heuristic alignment so all 32 teams display
        with proper names.
        """
        name_by_idx = self._build_team_name_map(data)
        raw = [p for p in data["draft_picks"] if (p.get("YearOffset") or 0) == 0]
        raw.sort(key=lambda p: (p.get("Round") or 0, p.get("PickNumber") or 0))
        out: list[PickRecord] = []
        for i, row in enumerate(raw, start=1):
            orig_idx = row.get("OriginalTeamIndex")
            curr_idx = row.get("CurrentTeamIndex")
            orig = name_by_idx.get(orig_idx, f"Team {orig_idx}" if orig_idx is not None else "?")
            curr = name_by_idx.get(curr_idx, orig)
            out.append(PickRecord(
                overall=i,
                round_1=row["round_1"],
                pick_in_round_1=row["pick_1"],
                original_team=orig,
                current_team=curr,
                year_offset=row.get("YearOffset") or 0,
                draft_slot=i,
            ))
        return out

    def _build_future_picks(self, data: dict[str, Any]) -> list[PickRecord]:
        """Year-offset-1 picks that can be traded but never come on the clock.

        These are given unique overall IDs starting after all current picks
        so they don't collide with the pick order. ``draft_slot`` preserves
        the actual 1-indexed slot within the future draft for value lookup.
        """
        name_by_idx = self._build_team_name_map(data)
        raw = [p for p in data["draft_picks"] if (p.get("YearOffset") or 0) == 1]
        raw.sort(key=lambda p: (p.get("Round") or 0, p.get("PickNumber") or 0))
        base = len(self._pick_order)
        out: list[PickRecord] = []
        for i, row in enumerate(raw, start=1):
            orig_idx = row.get("OriginalTeamIndex")
            curr_idx = row.get("CurrentTeamIndex")
            orig = name_by_idx.get(orig_idx, f"Team {orig_idx}" if orig_idx is not None else "?")
            curr = name_by_idx.get(curr_idx, orig)
            out.append(PickRecord(
                overall=base + i,
                round_1=row["round_1"],
                pick_in_round_1=row["pick_1"],
                original_team=orig,
                current_team=curr,
                year_offset=1,
                draft_slot=i,
            ))
        return out

    def future_picks(self) -> list[PickRecord]:
        return list(self._future_picks)

    def _build_weighted_needs(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        """Pre-compute TrueWeight for every PositionNeeds row once at session start.

        Returns a copy of position_needs with a TrueWeight key added to each
        row. compute_team_needs uses this value directly so weights stay fixed
        for the whole draft.
        """
        out = []
        for row in data.get("position_needs", []):
            default_weight = float(row.get("DefaultWeight") or 0)
            true_weight = default_weight + random.uniform(
                -default_weight * 0.25, default_weight * 0.25
            )
            out.append({**row, "TrueWeight": round(true_weight, 3)})
        return out

    def _build_team_boards(self, data: dict[str, Any]) -> dict[str, list[str]]:
        """Pre-compute each team's noise-adjusted big board once at session start.

        Stores an ordered list of Player_IDs per team. Drafted players are
        filtered out at serve time; the order itself never changes mid-draft.
        """
        all_players = data["big_board"]["players"]
        boards: dict[str, list[str]] = {}
        for team_name in data["team_info"].values():
            gm = next((g for g in data["gm_info"] if g.get("TeamName") == team_name), {})
            ordered = logic.compute_team_big_board(team_name, all_players, gm)
            boards[team_name] = [p["Player_ID"] for p in ordered if p.get("Player_ID")]
        return boards

    # -- queries -------------------------------------------------------------

    @staticmethod
    def _build_team_name_map(data: dict[str, Any]) -> dict[int, str]:
        """Map decoded pick TeamNumber -> team name using TeamInfo.xlsx.

        DraftPicks binary strings decode to a TeamNumber that maps
        directly to TeamInfo.xlsx. No heuristic needed.
        """
        return dict(data.get("team_info", {}))

    @property
    def total_picks(self) -> int:
        return len(self._pick_order)

    @property
    def is_complete(self) -> bool:
        return self._current_idx >= len(self._pick_order)

    def current_pick(self) -> PickRecord | None:
        if self.is_complete:
            return None
        return self._pick_order[self._current_idx]

    def board(self) -> list[PickRecord]:
        return list(self._pick_order)

    def trade_log(self) -> list[TradeRecord]:
        return list(self.trades)

    def remaining_players(self) -> list[dict[str, Any]]:
        return [p for p in self.data["big_board"]["players"] if not p.get("drafted")]

    # -- actions -------------------------------------------------------------

    def make_user_pick(self, player_id: str) -> dict[str, Any]:
        """User selects a specific player at the current pick.

        Refuses if it isn't the user's pick, the player is already
        drafted, or the draft is complete.
        """
        with self.lock:
            pick = self.current_pick()
            if pick is None:
                return {"ok": False, "error": "draft_complete"}
            if pick.current_team != self.user_team:
                return {"ok": False, "error": "not_user_pick",
                        "current_team": pick.current_team}
            player = self._find_player(player_id)
            if player is None:
                return {"ok": False, "error": "unknown_player"}
            if player.get("drafted"):
                return {"ok": False, "error": "already_drafted"}
            self._record_selection(pick, player)
            self._advance()
            return {"ok": True, "pick": _pick_to_dict(pick)}

    def force_make_pick(self, player_id: str) -> dict[str, Any]:
        """Manually select ``player_id`` for whichever team is on the clock.

        Used when the user wants to override AI for another team (drafting
        on someone else's behalf). Bypasses the user-team restriction in
        ``make_user_pick`` but otherwise behaves identically: same selection
        recording, same roster mutation, same advance. Returns the team the
        pick was attributed to so the UI can label the toast.
        """
        with self.lock:
            pick = self.current_pick()
            if pick is None:
                return {"ok": False, "error": "draft_complete"}
            player = self._find_player(player_id)
            if player is None:
                return {"ok": False, "error": "unknown_player"}
            if player.get("drafted"):
                return {"ok": False, "error": "already_drafted"}
            self._record_selection(pick, player)
            self._advance()
            return {"ok": True, "pick": _pick_to_dict(pick),
                    "drafted_for": pick.current_team}

    def sim_one_pick(self) -> dict[str, Any]:
        """Run logic.sim_pick for the team currently on the clock.

        If that team is the user's, refuses (UI should disable the
        button or prompt the user).
        """
        with self.lock:
            pick = self.current_pick()
            if pick is None:
                return {"ok": False, "error": "draft_complete"}
            if pick.current_team == self.user_team:
                return {"ok": False, "error": "user_on_the_clock"}
            return self._sim_one_locked()

    def sim_until_user(self) -> dict[str, Any]:
        """Sim repeatedly until the user is on the clock or the draft ends."""
        results: list[dict[str, Any]] = []
        with self.lock:
            while True:
                pick = self.current_pick()
                if pick is None:
                    break
                if pick.current_team == self.user_team:
                    break
                step = self._sim_one_locked()
                results.append(step)
                if not step.get("ok"):
                    break
        return {"ok": True, "events": results, "stopped_at": _pick_to_dict(self.current_pick()) if self.current_pick() else None}

    def sim_until_round(self, target_round_1: int) -> dict[str, Any]:
        """Sim repeatedly until reaching the start of ``target_round_1``."""
        results: list[dict[str, Any]] = []
        with self.lock:
            while True:
                pick = self.current_pick()
                if pick is None:
                    break
                if pick.round_1 >= target_round_1 and pick.current_team == self.user_team:
                    break
                if pick.round_1 >= target_round_1:
                    # Reached new round; if user is not on the clock, keep simming
                    # only if user has no pick this round at all. Simpler rule:
                    # stop at the first pick of the target round.
                    break
                step = self._sim_one_locked()
                results.append(step)
                if not step.get("ok"):
                    break
        return {"ok": True, "events": results,
                "stopped_at": _pick_to_dict(self.current_pick()) if self.current_pick() else None}

    def sim_until_end(self) -> dict[str, Any]:
        """Sim every remaining pick until the draft is complete.

        Unlike sim_until_user / sim_until_round, this does NOT stop on
        the user's picks — it AI-fills the entire remainder of the
        draft, including the user team. Used when the user wants to
        burn through the rest of the draft.
        """
        results: list[dict[str, Any]] = []
        with self.lock:
            while True:
                pick = self.current_pick()
                if pick is None:
                    break
                step = self._sim_one_locked()
                results.append(step)
                if not step.get("ok"):
                    break
        return {"ok": True, "events": results,
                "stopped_at": _pick_to_dict(self.current_pick()) if self.current_pick() else None,
                "is_complete": self.is_complete}

    def sim_until_overall(self, target_overall: int) -> dict[str, Any]:
        """Sim until the pick whose ``overall`` number == ``target_overall`` is on the clock."""
        results: list[dict[str, Any]] = []
        with self.lock:
            while True:
                pick = self.current_pick()
                if pick is None or pick.overall >= target_overall:
                    break
                step = self._sim_one_locked()
                results.append(step)
                if not step.get("ok"):
                    break
        return {"ok": True, "events": results,
                "stopped_at": _pick_to_dict(self.current_pick()) if self.current_pick() else None}

    def get_trade_down_offers(self) -> dict[str, Any]:
        """Return AI offers to trade up for the user's current pick."""
        with self.lock:
            pick = self.current_pick()
            if pick is None or pick.current_team != self.user_team:
                return {"ok": False, "error": "not_user_pick"}
            offers = logic.attempt_user_trade_down(self._snapshot_for_logic())
            return {"ok": True, "offers": offers}

    def submit_user_trade_up(self, target_overall: int,
                             offered_pick_overalls: list[int]) -> dict[str, Any]:
        """User attempts to trade up to ``target_overall`` by offering picks.

        Accepted when the user's offer value:
        1. Meets the target team's TradeDown threshold (based on GM trait).
        2. Is at least as high as the best competing CPU offer (if the
           target is the current on-clock pick with pending CPU offers).
        """
        with self.lock:
            target = next((p for p in self._pick_order if p.overall == target_overall), None)
            if target is None:
                return {"ok": False, "error": "unknown_target_pick"}
            if target.current_team == self.user_team:
                return {"ok": False, "error": "already_own_pick"}
            all_picks = self._pick_order + list(self._future_picks)
            offered = [p for p in all_picks if p.overall in set(offered_pick_overalls)
                       and p.current_team == self.user_team and p.selected_player_id is None]
            if len(offered) != len(offered_pick_overalls):
                return {"ok": False, "error": "invalid_offered_picks"}

            target_dict = _pick_to_dict(target)
            offered_dicts = [_pick_to_dict(p) for p in offered]
            evaluated = logic.attempt_user_trade_up(
                self._snapshot_for_logic(), target_dict, offered_dicts)
            offer_val = evaluated["offer_value"]
            target_val = evaluated["target_value"]

            gm = next((g for g in self.data["gm_info"]
                       if g.get("TeamName") == target.current_team), {})
            threshold = logic.trade_down_threshold(gm)
            meets_threshold = target_val > 0 and offer_val >= target_val * threshold

            # Compare against competing CPU offers only for the current on-clock pick.
            is_current = (self.current_pick() is not None
                          and self.current_pick().overall == target_overall)
            if is_current:
                self._ensure_pending_offers()
            best_cpu_val = max(
                (o["offer_value"] for o in (self._pending_trade_offers or []) if is_current),
                default=0.0,
            )
            beats_cpu = offer_val >= best_cpu_val

            offer_summary = {
                "from_team": self.user_team,
                "to_team": target.current_team,
                "offered_picks": offered_dicts,
                "target_pick": target_dict,
                "offer_value": offer_val,
                "target_value": target_val,
            }

            if meets_threshold and beats_cpu:
                self._apply_trade(target, offered, target.current_team, self.user_team, "USER")
                return {
                    "ok": True,
                    "decision": {"accepted": True, "reason": "offer accepted"},
                    "offer": offer_summary,
                    "trade": {
                        "trading_up": self.user_team,
                        "trading_down": target.current_team,
                        "offered_picks": offered_dicts,
                        "target_pick": target_dict,
                    },
                }

            if not meets_threshold:
                reason = (f"offer value ({offer_val:.0f}) below threshold "
                          f"({target_val * threshold:.0f} needed)")
            else:
                reason = "a competing offer was better"
            return {
                "ok": True,
                "decision": {
                    "accepted": False,
                    "reason": reason,
                    "offer_value": offer_val,
                    "target_value": target_val,
                    "threshold": threshold,
                },
                "offer": offer_summary,
            }

    # -- internal ------------------------------------------------------------

    def _ensure_pending_offers(self) -> None:
        """Generate CPU trade-up offers for the current pick if not yet done."""
        pick = self.current_pick()
        if pick is None:
            self._pending_trade_offers = []
            return
        if (self._pending_trade_offers is not None
                and self._pending_offers_for_overall == pick.overall):
            return
        self._pending_trade_offers = logic.generate_trade_offers_for_pick(
            self._snapshot_for_logic(), _pick_to_dict(pick)
        )
        self._pending_offers_for_overall = pick.overall

    def _best_qualifying_cpu_offer(self) -> dict[str, Any] | None:
        """Return the highest-value CPU offer that clears the threshold, or None."""
        if not self._pending_trade_offers:
            return None
        pick = self.current_pick()
        if pick is None:
            return None
        gm = next((g for g in self.data["gm_info"]
                   if g.get("TeamName") == pick.current_team), {})
        threshold = logic.trade_down_threshold(gm)
        target_val = logic.pick_value(_pick_to_dict(pick), self.data["pick_values"])
        if target_val <= 0:
            return None
        for offer in self._pending_trade_offers:  # already sorted by value desc
            if offer["offer_value"] >= target_val * threshold:
                return offer
        return None

    def _execute_cpu_trade(self, offer: dict[str, Any]) -> dict[str, Any]:
        """Apply a CPU-to-CPU trade offer, returning a summary dict for the UI."""
        pick = self.current_pick()
        trading_down = pick.current_team
        trading_up = offer["from_team"]
        offered_overalls = {p["overall"] for p in offer["offered_picks"]}
        offered_records = [
            p for p in self._pick_order + list(self._future_picks)
            if p.overall in offered_overalls
        ]
        self._apply_trade(pick, offered_records, trading_down, trading_up, "AI")
        return {
            "trading_up": trading_up,
            "trading_down": trading_down,
            "offered_picks": offer["offered_picks"],
            "target_pick": offer["target_pick"],
            "offer_value": offer["offer_value"],
            "target_value": offer["target_value"],
        }

    def _sim_one_locked(self) -> dict[str, Any]:
        """Caller MUST hold ``self.lock``. Simulates the current pick.

        Before making the selection, checks for a qualifying CPU trade-up
        offer. If one exists, executes the trade (ownership swap) first,
        then sims the pick for whichever team now owns it.
        """
        pick = self.current_pick()
        if pick is None:
            return {"ok": False, "error": "draft_complete"}

        self._ensure_pending_offers()
        trade_event: dict[str, Any] | None = None
        best_offer = self._best_qualifying_cpu_offer()
        if best_offer:
            trade_event = self._execute_cpu_trade(best_offer)

        team = pick.current_team  # may have changed after trade
        decision = logic.sim_pick(self._snapshot_for_logic(), team)
        if decision.get("outcome") == "select":
            player = self._find_player(decision["player_id"])
            if player is None:
                return {"ok": False, "error": "logic_returned_unknown_player"}
            self._record_selection(pick, player)
            self._advance()
            return {"ok": True, "type": "select", "pick": _pick_to_dict(pick),
                    "decision": decision, "trade": trade_event}
        return {"ok": False, "error": "unknown_decision", "decision": decision}

    def _record_selection(self, pick: PickRecord, player: dict[str, Any]) -> None:
        player["drafted"] = True
        player["Drafted"] = True
        pick.selected_player_id = player.get("Player_ID")
        pick.selected_player_name = f"{player.get('FirstName','')} {player.get('LastName','')}".strip()
        key = (player.get("FirstName"), player.get("LastName"),
               player.get("PLYR_DRAFTROUND"), player.get("PLYR_DRAFTPICK"))
        roster_entry = self._roster_lookup.get(key)
        if roster_entry is not None:
            team_index = self._gm_index_map.get(pick.current_team)
            if team_index is not None:
                roster_entry["TeamIndex"] = team_index
                roster_entry["ContractStatus"] = "Signed"

    def _advance(self) -> None:
        self._current_idx += 1
        self._pending_trade_offers = None
        self._pending_offers_for_overall = None

    def _find_player(self, player_id: str | None) -> dict[str, Any] | None:
        if not player_id:
            return None
        for p in self.data["big_board"]["players"]:
            if p.get("Player_ID") == player_id:
                return p
        return None

    def _apply_trade(self, headline_pick: PickRecord, picks_from_user: list[PickRecord],
                     team_a: str, team_b: str, initiator: str) -> TradeRecord:
        """Move ownership of every involved pick and append a TradeRecord."""
        for p in picks_from_user:
            p.current_team = team_a
        headline_pick.current_team = team_b
        rec = TradeRecord(
            trade_id=self._next_trade_id,
            overall_pick_traded=headline_pick.overall,
            team_a=team_a,
            team_b=team_b,
            team_a_sends=[_pick_to_dict(headline_pick)],
            team_b_sends=[_pick_to_dict(p) for p in picks_from_user],
            initiated_by=initiator,
        )
        self._next_trade_id += 1
        self.trades.append(rec)
        return rec

    def _snapshot_for_logic(self) -> dict[str, Any]:
        """Build a read-only-ish view of state for the logic functions."""
        return {
            "big_board": self.data["big_board"],
            "players": self.data["players"],
            "gm_info": self.data["gm_info"],
            "position_needs": self._weighted_needs,
            "pick_values": self.data["pick_values"],
            "max_per_position": self.data["max_per_position"],
            "team_boards": self._team_boards,
            "current_pick": _pick_to_dict(self.current_pick()) if self.current_pick() else None,
            "remaining_picks": [_pick_to_dict(p) for p in self._pick_order if p.selected_player_id is None],
            "future_picks": [_pick_to_dict(p) for p in self._future_picks],
        }


def _pick_to_dict(pick: PickRecord | None) -> dict[str, Any] | None:
    if pick is None:
        return None
    return {
        "overall": pick.overall,
        "draft_slot": pick.draft_slot,
        "round": pick.round_1,
        "pick_in_round": pick.pick_in_round_1,
        "original_team": pick.original_team,
        "current_team": pick.current_team,
        "year_offset": pick.year_offset,
        "selected_player_id": pick.selected_player_id,
        "selected_player_name": pick.selected_player_name,
    }
