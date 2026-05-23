"""Run a full draft sim and report per-pick trade behavior.

For each pick: who's on the clock, did they consider trade offers, how many
offers they received, and did a trade actually execute. Throwaway script.
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from backend.data_loader import load_all
from backend.draft_state import DraftSession

random.seed(42)

data = load_all(None)
sess = DraftSession(data, user_team=None)

records: list[dict] = []
trade_total = 0
considered_total = 0
offer_count_total = 0

# Hard safety cap in case of infinite loop
for _ in range(400):
    pick = sess.current_pick()
    if pick is None:
        break

    overall = pick.overall
    round_1 = pick.round_1
    on_clock = pick.current_team
    is_user = on_clock == sess.user_team

    # Populate the offers cache before sim so we can peek
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
        "pick": overall,
        "round": round_1,
        "team": on_clock,
        "is_user": is_user,
        "considered": willing,
        "offers": offer_count,
        "traded": trade_happened,
    })

# Print a tidy table
print(f"{'Pick':>4} | {'Rd':>2} | {'Team':<24} | Considered | Offers | Traded")
print("-" * 75)
for r in records:
    user_mark = " *" if r["is_user"] else ""
    team_str = f"{r['team']}{user_mark}"
    considered = "—" if r["considered"] is None else ("Y" if r["considered"] else "N")
    traded = "Y" if r["traded"] else "N"
    print(f"{r['pick']:>4} | R{r['round']} | {team_str:<24} | {considered:>10} | {r['offers']:>6} | {traded:>6}")

print()
print(f"Total picks simmed: {len(records)}")
print(f"Picks where team considered (CPU only): {considered_total}")
print(f"Total offers generated: {offer_count_total}")
print(f"Trades executed: {trade_total}")

# Count trade-downs per team
trade_count_per_team: dict[str, int] = {}
for r in records:
    if r["traded"]:
        trade_count_per_team[r["team"]] = trade_count_per_team.get(r["team"], 0) + 1
if trade_count_per_team:
    print()
    print("Trade-downs by team:")
    for team, count in sorted(trade_count_per_team.items(), key=lambda x: -x[1]):
        print(f"  {team:<24} {count}")
