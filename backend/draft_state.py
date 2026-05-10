"""In-memory draft state for a single Madden Draft Tool session.

The Flask app holds one ``DraftSession`` at a time (keyed by year). The
state is intentionally not persisted to disk between server restarts —
the *outputs* of a finished draft are persisted via the exporter.

The user controls the Steelers; everything else is AI. UI controls map
1:1 onto methods on this class.
"""

from __future__ import annotations

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
    """
    overall: int            # 1-indexed pick number across all rounds
    round_1: int            # 1-indexed round
    pick_in_round_1: int    # 1-indexed pick within the round
    original_team: str
    current_team: str
    year_offset: int
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

    def __init__(self, data: dict[str, Any]):
        self.data = data
        self.lock = threading.Lock()
        self._pick_order: list[PickRecord] = self._build_initial_order(data)
        self._current_idx: int = 0
        self.trades: list[TradeRecord] = []
        self._next_trade_id: int = 1
        self.user_team: str = USER_TEAM_NAME

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
            ))
        return out

    # -- queries -------------------------------------------------------------

    @staticmethod
    def _build_team_name_map(data: dict[str, Any]) -> dict[int, str]:
        """Map decoded pick TeamIndex -> team name.

        GMInfo and DraftPicks use slightly different ID spaces: in our
        TestFiles, DraftPicks' indices range over [0..7, 10..17, 19, 21..23,
        25..36] — exactly 32 distinct values — while GMInfo uses [0..31].
        Five GMInfo teams (Chiefs, Colts, Lions, Panthers, Ravens at
        indices 8, 9, 18, 20, 24) are absent from DraftPicks' low range
        and appear at the high end (32..36). We patch this by aligning
        the two sorted lists of "missing" vs "extra" indices. If a
        future data drop has a documented mapping we can replace this.
        """
        gm_indices = sorted(int(t["TeamIndex"]) for t in data.get("gm_info", []))
        gm_name_by_idx = {int(t["TeamIndex"]): t["TeamName"]
                          for t in data.get("gm_info", []) if t.get("TeamIndex") is not None}
        pick_indices = sorted({p.get("OriginalTeamIndex") for p in data.get("draft_picks", [])
                               if p.get("OriginalTeamIndex") is not None})
        out: dict[int, str] = {}
        # Pass-through where indices match.
        for idx in pick_indices:
            if idx in gm_name_by_idx:
                out[idx] = gm_name_by_idx[idx]
        # Align the leftovers in sorted order.
        gm_only = [i for i in gm_indices if i not in pick_indices]
        pick_only = [i for i in pick_indices if i not in gm_name_by_idx]
        for pick_idx, gm_idx in zip(pick_only, gm_only):
            out[pick_idx] = gm_name_by_idx[gm_idx]
        return out

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
        """User attempts to trade up to ``target_overall`` by offering picks."""
        with self.lock:
            target = next((p for p in self._pick_order if p.overall == target_overall), None)
            if target is None:
                return {"ok": False, "error": "unknown_target_pick"}
            if target.current_team == self.user_team:
                return {"ok": False, "error": "already_own_pick"}
            offered = [p for p in self._pick_order if p.overall in set(offered_pick_overalls)
                       and p.current_team == self.user_team and p.selected_player_id is None]
            if len(offered) != len(offered_pick_overalls):
                return {"ok": False, "error": "invalid_offered_picks"}
            offer = {
                "from_team": self.user_team,
                "to_team": target.current_team,
                "from_picks": [_pick_to_dict(p) for p in offered],
                "to_picks": [_pick_to_dict(target)],
            }
            decision = logic.attempt_user_trade_up(
                self._snapshot_for_logic(), _pick_to_dict(target), offer["from_picks"])
            if decision.get("accepted"):
                self._apply_trade(target, offered, target.current_team, self.user_team, "USER")
            return {"ok": True, "decision": decision, "offer": offer}

    # -- internal ------------------------------------------------------------

    def _sim_one_locked(self) -> dict[str, Any]:
        """Caller MUST hold ``self.lock``. Simulates the current pick."""
        pick = self.current_pick()
        if pick is None:
            return {"ok": False, "error": "draft_complete"}
        team = pick.current_team
        decision = logic.sim_pick(self._snapshot_for_logic(), team)
        if decision.get("outcome") == "select":
            player = self._find_player(decision["player_id"])
            if player is None:
                return {"ok": False, "error": "logic_returned_unknown_player"}
            self._record_selection(pick, player)
            self._advance()
            return {"ok": True, "type": "select", "pick": _pick_to_dict(pick),
                    "decision": decision}
        if decision.get("outcome") == "trade":
            # Trades from sim_pick aren't wired up in placeholder logic;
            # when implemented this branch will look up the chosen offer
            # and call _apply_trade.
            return {"ok": True, "type": "trade_pending", "decision": decision}
        return {"ok": False, "error": "unknown_decision", "decision": decision}

    def _record_selection(self, pick: PickRecord, player: dict[str, Any]) -> None:
        player["drafted"] = True
        player["Drafted"] = True
        pick.selected_player_id = player.get("Player_ID")
        pick.selected_player_name = f"{player.get('FirstName','')} {player.get('LastName','')}".strip()

    def _advance(self) -> None:
        self._current_idx += 1

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
            "position_needs": self.data["position_needs"],
            "pick_values": self.data["pick_values"],
            "max_per_position": self.data["max_per_position"],
            "current_pick": _pick_to_dict(self.current_pick()) if self.current_pick() else None,
            "remaining_picks": [_pick_to_dict(p) for p in self._pick_order if p.selected_player_id is None],
        }


def _pick_to_dict(pick: PickRecord | None) -> dict[str, Any] | None:
    if pick is None:
        return None
    return {
        "overall": pick.overall,
        "round": pick.round_1,
        "pick_in_round": pick.pick_in_round_1,
        "original_team": pick.original_team,
        "current_team": pick.current_team,
        "year_offset": pick.year_offset,
        "selected_player_id": pick.selected_player_id,
        "selected_player_name": pick.selected_player_name,
    }
