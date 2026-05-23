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
from backend.draft_state import DraftSession

# Seeds to compare. Add/remove as needed.
SEEDS = [42, 43, 100, 999, 12345]


def run_sim(seed: int) -> dict:
    # Fresh data copy + fresh session per seed. `load_all` returns a deepcopy
    # of its cached dict, so each call is independent.
    random.seed(seed)
    data = load_all(None)
    sess = DraftSession(data, user_team=None)

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

        records.append({
            "round": pick.round_1,
            "team": on_clock,
            "considered": willing,
            "offers": offer_count,
            "traded": trade_happened,
        })

    return {
        "seed": seed,
        "records": records,
        "picks": len(records),
        "considered": considered_total,
        "offers": offer_count_total,
        "trades": trade_total,
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
