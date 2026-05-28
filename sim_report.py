"""Run multiple draft sims (one per seed) and report distribution behavior.

Per-seed totals + averages across seeds, per-round breakdown averaged across
all runs, and top trade-down teams averaged. Throwaway script.
"""
from __future__ import annotations

import random
import sys
from pathlib import Path
from statistics import mean, stdev

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from backend.data_loader import load_all
from backend.draft_state import DraftSession, _pick_to_dict
from backend import logic

# Seeds to compare. Add/remove as needed.
SEEDS = [5, 60, 89, 207, 564, 997, 2091, 8726, 12347, 25002]

def run_sim(seed: int) -> dict:
    # Fresh data copy + fresh session per seed. `load_all` returns a deepcopy
    # of its cached dict, so each call is independent.
    random.seed(seed)
    data = load_all(None)
    sess = DraftSession(data, user_team=None)

    # Use position groups from DraftMaxPerPositionGroup.xlsx.
    pos_to_group: dict[str, str] = data.get("max_per_position_group", {}).get("pos_to_group", {})

    # Build player_id -> grouped position lookup for position-stack analysis.
    player_pos: dict = {
        p["Player_ID"]: pos_to_group.get(p.get("position", ""), p.get("position") or "UNK")
        for p in data["big_board"]["players"]
        if p.get("Player_ID") is not None
    }

    records: list[dict] = []
    trade_total = 0
    considered_total = 0
    offer_count_total = 0

    for _ in range(400):
        pick = sess.current_pick()
        if pick is None:
            break

        on_clock = pick.current_team
        is_user = on_clock == sess.user_team

        # Compute the raw willingness probabilities BEFORE simming this pick
        # so the snapshot reflects the moment-in-time decision state. These
        # are probabilities, not realizations — the actual roll happens
        # inside _ensure_pending_offers.
        td_prob = None
        tu_prob_avg = None
        if not is_user and pick.overall != sess._pick_must_select:
            snap = sess._snapshot_for_logic()
            pick_dict = _pick_to_dict(pick)
            td_prob = logic._trade_down_probability(snap, pick_dict)
            # Average trade-up probability across all OTHER eligible CPU teams
            # (mirrors the loop inside generate_trade_offers_for_pick).
            other_gms = [g for g in sess.data["gm_info"]
                         if g.get("TeamName")
                         and g["TeamName"] != on_clock
                         and g["TeamName"] != sess.user_team]
            tu_probs = [logic._trade_up_probability(snap, gm, pick_dict) for gm in other_gms]
            tu_prob_avg = mean(tu_probs) if tu_probs else 0.0

        willing = None
        offer_count = 0
        if not is_user and pick.overall != sess._pick_must_select:
            sess._ensure_pending_offers()
            willing = sess._trade_down_willing
            offer_count = len(sess._pending_trade_offers or [])

        result = sess._sim_one_locked()
        if not result.get("ok"):
            break

        trade_happened = result.get("trade") is not None
        if trade_happened:
            trade_total += 1
        if willing:
            considered_total += 1
        offer_count_total += offer_count

        drafting_team = result.get("pick", {}).get("current_team", on_clock)
        player_id = result.get("decision", {}).get("player_id")
        pos_grp = player_pos.get(player_id, "UNK")

        records.append({
            "round": pick.round_1,
            "team": on_clock,
            "drafting_team": drafting_team,
            "pos_group": pos_grp,
            "considered": willing,
            "offers": offer_count,
            "traded": trade_happened,
            "td_prob": td_prob,
            "tu_prob_avg": tu_prob_avg,
        })

    # Per-team position group pick counts (keyed by drafting team).
    team_pos_counts: dict[str, dict[str, int]] = {}
    for rec in records:
        dt = rec["drafting_team"]
        pg = rec["pos_group"]
        if pg == "UNK":
            continue
        grp = team_pos_counts.setdefault(dt, {})
        grp[pg] = grp.get(pg, 0) + 1

    return {
        "seed": seed,
        "records": records,
        "picks": len(records),
        "considered": considered_total,
        "offers": offer_count_total,
        "trades": trade_total,
        "team_pos_counts": team_pos_counts,
    }


results = [run_sim(s) for s in SEEDS]

# Per-seed summary
print(f"{'Seed':>6} | {'Picks':>5} | {'Considered':>10} | {'Offers':>6} | {'Trades':>6}")
print("-" * 50)
for r in results:
    print(f"{r['seed']:>6} | {r['picks']:>5} | {r['considered']:>10} | {r['offers']:>6} | {r['trades']:>6}")

# Averages across seeds
considered_vals = [r["considered"] for r in results]
offers_vals = [r["offers"] for r in results]
trades_vals = [r["trades"] for r in results]
print("-" * 50)
print(f"{'avg':>6} | {'':>5} | "
      f"{mean(considered_vals):>10.1f} | "
      f"{mean(offers_vals):>6.1f} | "
      f"{mean(trades_vals):>6.1f}")
if len(results) > 1:
    print(f"{'stdev':>6} | {'':>5} | "
          f"{stdev(considered_vals):>10.1f} | "
          f"{stdev(offers_vals):>6.1f} | "
          f"{stdev(trades_vals):>6.1f}")

# Per-round averages across seeds
print()
print("Per-round averages across seeds:")
print(f"  {'Round':<6} | {'Considered':>10} | {'Offers':>6} | {'Trades':>6}")
print("  " + "-" * 45)
rounds = sorted({rec["round"] for r in results for rec in r["records"]})
for rd in rounds:
    cons = [sum(1 for rec in r["records"] if rec["round"] == rd and rec["considered"]) for r in results]
    offs = [sum(rec["offers"] for rec in r["records"] if rec["round"] == rd) for r in results]
    trd = [sum(1 for rec in r["records"] if rec["round"] == rd and rec["traded"]) for r in results]
    print(f"  R{rd:<5} | {mean(cons):>10.1f} | {mean(offs):>6.1f} | {mean(trd):>6.1f}")

# Per-round willingness probabilities (for tuning)
# Trade-down: the on-clock team's _trade_down_probability for each pick
# Trade-up: average of _trade_up_probability across all other CPU teams per pick
print()
print("Per-round willingness probabilities (averaged across all picks + seeds):")
print(f"  {'Round':<6} | {'Trade-down %':>13} | {'Trade-up % (avg per team)':>27}")
print("  " + "-" * 55)
for rd in rounds:
    td_vals: list[float] = []
    tu_vals: list[float] = []
    for r in results:
        for rec in r["records"]:
            if rec["round"] != rd:
                continue
            if rec["td_prob"] is not None:
                td_vals.append(rec["td_prob"])
            if rec["tu_prob_avg"] is not None:
                tu_vals.append(rec["tu_prob_avg"])
    td_pct = (mean(td_vals) * 100) if td_vals else 0.0
    tu_pct = (mean(tu_vals) * 100) if tu_vals else 0.0
    print(f"  R{rd:<5} | {td_pct:>12.1f}% | {tu_pct:>26.2f}%")

# Trade-down counts per team averaged across seeds
print()
print(f"Trade-downs per team (averaged across {len(results)} seeds, top 15):")
team_trades_per_seed: dict[str, list[int]] = {}
for r in results:
    counts: dict[str, int] = {}
    for rec in r["records"]:
        if rec["traded"]:
            counts[rec["team"]] = counts.get(rec["team"], 0) + 1
    for team in counts:
        team_trades_per_seed.setdefault(team, [0] * len(results))
    for team, c in counts.items():
        # Record this seed's count for this team
        idx = SEEDS.index(r["seed"])
        team_trades_per_seed[team][idx] = c

team_avgs = [(team, mean(counts)) for team, counts in team_trades_per_seed.items()]
for team, avg in sorted(team_avgs, key=lambda x: -x[1])[:15]:
    counts = team_trades_per_seed[team]
    counts_str = ",".join(str(c) for c in counts)
    print(f"  {team:<24} avg {avg:.1f}   (per-seed: {counts_str})")

# Position group stacking — max same-group picks by a single team in one draft
print()
print(f"Position group stacking (max picks of same group by any one team, averaged across {len(results)} seeds):")

# Distribution: how many teams hit each max level, averaged across seeds
print()
print("  Stack distribution (avg teams with max >= N):")
print(f"  {'Max':>4} | {'Avg teams':>10} | {'% of league':>12}")
print("  " + "-" * 33)
for level in range(2, 8):
    team_counts_at_level = [
        sum(1 for counts in r["team_pos_counts"].values() if max(counts.values(), default=0) >= level)
        for r in results
    ]
    avg_teams = mean(team_counts_at_level)
    pct = avg_teams / 32 * 100
    print(f"  {level:>4} | {avg_teams:>10.1f} | {pct:>11.1f}%")

# Top position groups that get stacked (2+ of same group in one draft, per team)
print()
print("  Most stacked position groups (avg occurrences of 2+ picks per team per draft):")
pos_stack_counts: dict[str, list[int]] = {}
for r in results:
    pg_doubles: dict[str, int] = {}
    for counts in r["team_pos_counts"].values():
        for pg, n in counts.items():
            if n >= 2:
                pg_doubles[pg] = pg_doubles.get(pg, 0) + 1
    for pg, n in pg_doubles.items():
        pos_stack_counts.setdefault(pg, [0] * len(results))
        pos_stack_counts[pg][SEEDS.index(r["seed"])] = n

pos_avgs = [(pg, mean(vals)) for pg, vals in pos_stack_counts.items()]
print(f"  {'Position':<8} | {'Avg teams 2+':>13}")
print("  " + "-" * 26)
for pg, avg in sorted(pos_avgs, key=lambda x: -x[1]):
    print(f"  {pg:<8} | {avg:>13.1f}")
