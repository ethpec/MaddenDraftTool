"""Flask entry point for the Madden Draft Tool.

Run with ``python app.py`` and open http://localhost:5050 in any browser.
The server holds a single in-memory ``DraftSession`` and exposes a small
JSON API that the frontend (vanilla JS + Tailwind via CDN) talks to.
"""

from __future__ import annotations

from typing import Any

from flask import Flask, jsonify, render_template, request, send_file

from backend import data_loader, exporter, logic
from backend.draft_state import DraftSession, _pick_to_dict, USER_TEAM_NAME

app = Flask(__name__, static_folder="static", template_folder="templates")

_session: DraftSession | None = None
_session_year: str | None = None


# -----------------------------------------------------------------------------
# helpers
# -----------------------------------------------------------------------------

def _require_session():
    if _session is None:
        return None, (jsonify({"error": "no_session", "message": "Start a draft first."}), 400)
    return _session, None


def _portrait_url(player: dict[str, Any] | None, portrait_files: list[str]) -> str | None:
    """Resolve a player's portrait URL from /static/portraits/.

    Preferred: BigBoard's ``GenericHeadAssetName`` (e.g. ``gen_2_BMH_S_002``)
    maps directly to ``plpo_generic_2_BMH_S_002.png`` — Madden's actual
    assigned portrait for that prospect. This is exact, not a guess.

    Fallback: when no asset name is present (e.g. vets without a BigBoard
    entry), hash ``PLYR_PORTRAIT`` (or the player's name) into the
    sorted portraits list so the same player always gets the same image.
    """
    if not player or not portrait_files:
        return None
    # Direct mapping path — BigBoard prospects carry the asset name.
    asset = player.get("GenericHeadAssetName")
    if asset:
        fname = str(asset).replace("gen_", "plpo_generic_", 1) + ".png"
        # Validate the file actually exists before returning the URL;
        # if Madden ever ships an asset name we don't have on disk,
        # silently fall through to the hash fallback.
        if fname in _PORTRAIT_FILES_SET:
            return "/static/portraits/" + fname
    # Hash fallback for players without a known asset name.
    seed = player.get("PLYR_PORTRAIT")
    try:
        seed = int(seed) if seed else 0
    except (TypeError, ValueError):
        seed = 0
    if seed <= 0:
        seed = hash((player.get("FirstName") or "",
                     player.get("LastName") or "")) & 0xFFFFFFFF
    idx = seed % len(portrait_files)
    return "/static/portraits/" + portrait_files[idx]


# Cached set of available portrait filenames for O(1) existence checks
# inside _portrait_url. Refreshed lazily by _refresh_portrait_set when
# a new session is started.
_PORTRAIT_FILES_SET: set[str] = set()


def _refresh_portrait_set(portrait_files: list[str]) -> None:
    global _PORTRAIT_FILES_SET
    _PORTRAIT_FILES_SET = set(portrait_files)


def _serialize_session(session: DraftSession) -> dict[str, Any]:
    current = session.current_pick()
    nfl_logos = session.data.get("nfl_logo_map", {})
    cur = _pick_to_dict(current)
    if cur:
        cur["original_team_logo"] = nfl_logos.get(cur["original_team"])
        cur["current_team_logo"] = nfl_logos.get(cur["current_team"])
    last = next((p for p in reversed(session.board()) if p.selected_player_id), None)
    last_d = _pick_to_dict(last)
    if last_d:
        last_d["current_team_logo"] = nfl_logos.get(last_d["current_team"])
        # College logo for the drafted player. O(1) via the session's player
        # index instead of a linear big-board scan on every session fetch.
        match = session._player_by_id.get(last_d["selected_player_id"])
        if match:
            last_d["college"] = match.get("college")
            last_d["college_logo"] = match.get("college_logo")
            last_d["position"] = match.get("position")
            last_d["portrait_url"] = _portrait_url(
                match, session.data.get("portrait_files", []))
            last_d["ovr"] = match.get("ovr")
            last_d["development_trait"] = match.get("development_trait")
    return {
        "year": _session_year,
        "user_team": session.user_team,
        "user_team_logo": nfl_logos.get(session.user_team),
        "is_complete": session.is_complete,
        "total_picks": session.total_picks,
        "current_pick": cur,
        "last_pick": last_d,
        "picks_made": sum(1 for p in session.board() if p.selected_player_id),
    }


def _pick_point_value(overall: int, year_offset: int, pick_values: dict[str, Any]) -> int | None:
    """O(1) chart-value lookup for the board UI.

    Mirrors the original behavior: current-year picks read the Current sheet's
    ``Value``; future picks read the Current sheet's ``ValueNextYear`` column
    (a discounted display value, distinct from logic.pick_value which uses the
    Future sheet for actual trade math).
    """
    if year_offset:
        v = pick_values.get("next_year_by_slot", {}).get(overall)
    else:
        v = pick_values.get("by_pick", {}).get((overall, 0))
    if v is None:
        return None
    f = float(v)
    return int(f) if f == int(f) else round(f, 1)


def _annotate_pick(d: dict[str, Any], pick_slot: int, nfl_logos: dict, pick_values: dict) -> None:
    d["original_team_logo"] = nfl_logos.get(d["original_team"])
    d["current_team_logo"] = nfl_logos.get(d["current_team"])
    d["value"] = _pick_point_value(pick_slot, d.get("year_offset", 0), pick_values)


def _board_payload(session: DraftSession) -> list[dict[str, Any]]:
    nfl_logos = session.data.get("nfl_logo_map", {})
    pick_values = session.data.get("pick_values", {})
    out = []
    for p in session.board():
        d = _pick_to_dict(p)
        if d:
            _annotate_pick(d, p.draft_slot or p.overall, nfl_logos, pick_values)
        out.append(d)
    return out


def _future_picks_payload(session: DraftSession) -> list[dict[str, Any]]:
    nfl_logos = session.data.get("nfl_logo_map", {})
    pick_values = session.data.get("pick_values", {})
    out = []
    for p in session.future_picks():
        d = _pick_to_dict(p)
        if d:
            _annotate_pick(d, p.draft_slot, nfl_logos, pick_values)
        out.append(d)
    return out


def _public_big_board(session: DraftSession) -> list[dict[str, Any]]:
    """Mel Kiper view: rows in stored BigBoardRank order, no per-team rankings."""
    out = []
    for p in session.data["big_board"]["players"]:
        grades = p.get("grades") or {}
        out.append({
            "player_id": p.get("Player_ID"),
            "first_name": p.get("FirstName"),
            "last_name": p.get("LastName"),
            "rank": p.get("BigBoardRank"),
            "projected_round": p.get("PLYR_DRAFTROUND"),
            "projected_pick": p.get("PLYR_DRAFTPICK"),
            "drafted": bool(p.get("drafted")),
            "college": p.get("college"),
            "college_logo": p.get("college_logo"),
            "position": p.get("position"),
            "development_trait": p.get("development_trait"),
            "has_grades": "grades" in p,
            "star": grades.get("star"),
            "height": grades.get("height"),
            "weight": grades.get("weight"),
            "attributes": grades.get("attributes") or {},
            "personality_rating": p.get("PersonalityRating"),
        })
    out.sort(key=lambda r: r["rank"] or 9999)
    return out


def _team_big_board(session: DraftSession, team_name: str) -> list[dict[str, Any]]:
    player_map = session._player_by_id
    board_order = session._team_boards.get(team_name, [])
    result = []
    rank = 1
    for original_rank, pid in enumerate(board_order, 1):
        p = player_map.get(pid)
        if p is None or p.get("drafted"):
            continue
        grades = p.get("grades") or {}
        result.append({
            "player_id": pid,
            "first_name": p.get("FirstName"),
            "last_name": p.get("LastName"),
            "team_rank": rank,
            "original_rank": original_rank,
            "consensus_rank": p.get("BigBoardRank"),
            "drafted": False,
            "college": p.get("college"),
            "college_logo": p.get("college_logo"),
            "position": p.get("position"),
            "has_grades": "grades" in p,
            "star": grades.get("star"),
            "height": grades.get("height"),
            "weight": grades.get("weight"),
            "attributes": grades.get("attributes") or {},
            "personality_rating": p.get("PersonalityRating"),
        })
        rank += 1
    return result


def _team_needs(session: DraftSession, team_name: str) -> list[dict[str, Any]]:
    gm = next((g for g in session.data["gm_info"] if g.get("TeamName") == team_name), None)
    if gm is None:
        return []
    needs = logic.compute_team_needs(
        team_name,
        int(gm["TeamIndex"]),
        session.data["players"],
        session._weighted_needs,
    )
    # Filter to needs whose TrueWeight qualifies for the CURRENT pick's round
    # OR the NEXT round (so the UI surfaces only round-appropriate needs).
    # If the draft is complete, fall through and return the full list.
    current_pick = session.current_pick()
    if current_pick is None:
        return needs

    current_round = current_pick.round_1
    _, (win_min_cur, win_max_cur), _ = logic._round_bucket(current_round, 1)
    windows = [(win_min_cur, win_max_cur)]
    if current_round < 7:
        _, (win_min_next, win_max_next), _ = logic._round_bucket(current_round + 1, 1)
        windows.append((win_min_next, win_max_next))

    return [n for n in needs
            if any(lo < n["weight"] <= hi for lo, hi in windows)]


# -----------------------------------------------------------------------------
# routes - HTML
# -----------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# -----------------------------------------------------------------------------
# routes - API
# -----------------------------------------------------------------------------

@app.get("/api/years")
def api_years():
    return jsonify({"years": data_loader.list_available_years()})


@app.get("/api/teams")
def api_teams_for_year():
    """Return the list of team names for a given year folder.

    Cheap pre-flight call so the setup screen can populate its team
    dropdown without paying the cost of loading every xlsx. Only reads
    GMInfo.xlsx + the NFL logo map.
    """
    year = request.args.get("year")
    folder = data_loader.resolve_year_folder(year)
    gm_info = data_loader.load_gm_info(folder)
    nfl_logos = data_loader.build_nfl_logo_map()
    teams = [
        {"name": g["TeamName"], "logo": nfl_logos.get(g["TeamName"])}
        for g in gm_info if g.get("TeamName")
    ]
    return jsonify({"teams": teams, "folder": folder.name})


@app.post("/api/session/start")
def api_session_start():
    """Initialize a draft session for a given year and user-controlled team."""
    global _session, _session_year
    body = request.get_json(force=True, silent=True) or {}
    year = body.get("year")
    user_team = body.get("user_team")
    data = data_loader.load_all(year)
    _session = DraftSession(data, user_team=user_team)
    _session_year = data.get("folder_name") or str(year)
    _refresh_portrait_set(data.get("portrait_files", []))
    return jsonify({
        "ok": True,
        "session": _serialize_session(_session),
        "teams": [g["TeamName"] for g in data["gm_info"]],
        "user_team": _session.user_team,
    })


@app.get("/api/session")
def api_session_get():
    sess, err = _require_session()
    if err:
        return err
    return jsonify({"session": _serialize_session(sess)})


@app.get("/api/board")
def api_board():
    sess, err = _require_session()
    if err:
        return err
    return jsonify({"picks": _board_payload(sess), "future_picks": _future_picks_payload(sess)})


@app.get("/api/big-board/public")
def api_big_board_public():
    sess, err = _require_session()
    if err:
        return err
    return jsonify({"players": _public_big_board(sess)})


@app.get("/api/big-board/team/<team_name>")
def api_big_board_team(team_name: str):
    sess, err = _require_session()
    if err:
        return err
    return jsonify({"team": team_name, "players": _team_big_board(sess, team_name)})


@app.get("/api/player/<player_id>")
def api_player(player_id: str):
    """Return one BigBoard player's full profile (bio, college, grades).

    Used by the player profile modal. Looks up against the BigBoard rows
    in session data; not all rookies have a Draft_LetterGrades entry
    (e.g. FBs are not graded), in which case ``grades`` will be None.
    """
    sess, err = _require_session()
    if err:
        return err
    p = sess._player_by_id.get(player_id)
    if p is None:
        return jsonify({"error": "player not found"}), 404
    drafted_pick = next((pk for pk in sess.board()
                         if pk.selected_player_id == player_id), None)
    nfl_logos = sess.data.get("nfl_logo_map", {})
    drafted_info = None
    if drafted_pick is not None:
        team_name = drafted_pick.current_team
        drafted_info = {
            "team": team_name,
            "team_logo": nfl_logos.get(team_name),
            "overall": drafted_pick.overall,
            "round": drafted_pick.round_1,
            "pick": drafted_pick.pick_in_round_1,
        }
    # Real OVR — use the BigBoard player's original `ovr` set at load
    # time, not the roster entry's value (which gets the rookie boost
    # from _record_selection after a draft). Matches what the Last
    # Selection card shows.
    real_ovr = p.get("ovr")
    dev_trait = p.get("development_trait")
    return jsonify({
        "player_id": p.get("Player_ID"),
        "first_name": p.get("FirstName"),
        "last_name": p.get("LastName"),
        "position": p.get("position"),
        "college": p.get("college"),
        "college_logo": p.get("college_logo"),
        "portrait_url": _portrait_url(p, sess.data.get("portrait_files", [])),
        "consensus_rank": p.get("BigBoardRank"),
        "prospect_type": p.get("ProspectType"),
        "projected_round": p.get("PLYR_DRAFTROUND"),
        "projected_pick": p.get("PLYR_DRAFTPICK"),
        "height": p.get("height"),
        "weight": p.get("weight"),
        "age": p.get("age"),
        "ovr": real_ovr,
        "development_trait": dev_trait,
        "drafted": bool(p.get("drafted")),
        "drafted_info": drafted_info,
        "grades": p.get("grades"),
        "combine_data": p.get("combine_data"),
    })


@app.get("/api/needs/<team_name>")
def api_needs(team_name: str):
    sess, err = _require_session()
    if err:
        return err
    return jsonify({"team": team_name, "needs": _team_needs(sess, team_name)})


@app.get("/api/gm-info")
def api_gm_info():
    sess, err = _require_session()
    if err:
        return err
    nfl_logos = sess.data.get("nfl_logo_map", {})
    gms = [dict(g, logo=nfl_logos.get(g.get("TeamName"))) for g in sess.data["gm_info"]]
    return jsonify({"gms": gms})


@app.get("/api/trades")
def api_trades():
    """Return the full trade log, enriched with logos and pick values.

    The frontend Trade History view renders the same kind of "what each
    side sent" panels the live trade-executed modal does, so we attach
    team logos and Jimmy-Johnson values per pick here instead of having
    the client recompute them.
    """
    sess, err = _require_session()
    if err:
        return err
    nfl_logos = sess.data.get("nfl_logo_map", {})
    pick_values = sess.data.get("pick_values", {})
    by_overall = sess._pick_by_overall

    def _annotate(p: dict[str, Any]) -> dict[str, Any]:
        out = dict(p)
        slot = p.get("draft_slot") or p.get("overall")
        out["value"] = _pick_point_value(slot, p.get("year_offset", 0), pick_values)
        # The pick record's selected player can change after the trade
        # (whoever ends up drafting). Reflect current state.
        rec = by_overall.get(p.get("overall"))
        if rec is not None:
            out["selected_player_id"] = rec.selected_player_id
            out["selected_player_name"] = rec.selected_player_name
            if rec.selected_player_id:
                player = sess._player_by_id.get(rec.selected_player_id)
                if player:
                    out["selected_position"] = player.get("position")
        return out

    trades = []
    for t in sess.trade_log():
        trades.append({
            "trade_id": t.trade_id,
            "overall_pick_traded": t.overall_pick_traded,
            "team_a": t.team_a,
            "team_b": t.team_b,
            "team_a_logo": nfl_logos.get(t.team_a),
            "team_b_logo": nfl_logos.get(t.team_b),
            "team_a_sends": [_annotate(p) for p in t.team_a_sends],
            "team_b_sends": [_annotate(p) for p in t.team_b_sends],
            "initiated_by": t.initiated_by,
        })
    return jsonify({"trades": trades})


@app.get("/api/sim-report")
def api_sim_report():
    """Return BPA vs need pick counts and percentages broken down by round.

    Only counts picks that have been made. User picks (rationale='user')
    are counted separately. BPA = rationale starts with 'BPA'; need =
    rationale starts with 'need'.
    """
    sess, err = _require_session()
    if err:
        return err

    gm_trait_map = {
        g["TeamName"]: max(1, min(5, int(g.get("NeedvsBPA") or 3)))
        for g in sess.data["gm_info"] if g.get("TeamName")
    }

    by_round: dict[int, dict[str, int]] = {}
    by_trait: dict[int, dict[str, int]] = {}
    for pick in sess.board():
        if pick.selected_player_id is None:
            continue
        r = pick.round_1
        rat = pick.pick_rationale or ""
        if r not in by_round:
            by_round[r] = {"bpa": 0, "need": 0, "user": 0, "other": 0}
        if rat == "user":
            by_round[r]["user"] += 1
        elif rat.startswith("need"):
            by_round[r]["need"] += 1
        elif rat.startswith("BPA"):
            by_round[r]["bpa"] += 1
        else:
            by_round[r]["other"] += 1

        if rat != "user":
            trait = gm_trait_map.get(pick.current_team, 3)
            if trait not in by_trait:
                by_trait[trait] = {"bpa": 0, "need": 0, "other": 0}
            if rat.startswith("need"):
                by_trait[trait]["need"] += 1
            elif rat.startswith("BPA"):
                by_trait[trait]["bpa"] += 1
            else:
                by_trait[trait]["other"] += 1

    rounds = []
    for r in sorted(by_round):
        counts = by_round[r]
        total = sum(counts.values())
        cpu_total = total - counts["user"]
        rounds.append({
            "round": r,
            "total": total,
            "bpa": counts["bpa"],
            "need": counts["need"],
            "user": counts["user"],
            "other": counts["other"],
            "bpa_pct": round(counts["bpa"] / cpu_total * 100, 1) if cpu_total else 0,
            "need_pct": round(counts["need"] / cpu_total * 100, 1) if cpu_total else 0,
        })

    traits = []
    for t in sorted(by_trait):
        counts = by_trait[t]
        cpu_total = sum(counts.values())
        traits.append({
            "trait": t,
            "bpa": counts["bpa"],
            "need": counts["need"],
            "total": cpu_total,
            "bpa_pct": round(counts["bpa"] / cpu_total * 100, 1) if cpu_total else 0,
            "need_pct": round(counts["need"] / cpu_total * 100, 1) if cpu_total else 0,
        })

    return jsonify({"rounds": rounds, "traits": traits})


@app.get("/api/rosters")
def api_rosters():
    """Return every team's current roster grouped by position.

    Reads from the in-memory ``data["players"]`` table (which is mutated
    as picks are made — see ``_record_selection``) so newly-drafted
    rookies show up under their drafting team immediately.
    """
    sess, err = _require_session()
    if err:
        return err
    nfl_logos = sess.data.get("nfl_logo_map", {})
    college_logos = sess.data.get("college_logo_map", {})
    college_id_to_name = data_loader.build_college_id_to_name(
        sess.data.get("colleges", []))
    # Map GMInfo TeamIndex -> TeamName for the active 32 teams.
    idx_to_team = {int(g["TeamIndex"]): g["TeamName"]
                   for g in sess.data.get("gm_info", [])
                   if g.get("TeamName") and g.get("TeamIndex") is not None}
    # Pick records carry round/pick info for any drafted rookie; bucket
    # them by (FirstName, LastName, draft_round, draft_pick) so the per-
    # player join below is O(1).
    bigboard_by_key: dict[tuple, dict[str, Any]] = {
        (bp.get("FirstName"), bp.get("LastName"),
         bp.get("PLYR_DRAFTROUND"), bp.get("PLYR_DRAFTPICK")): bp
        for bp in sess.data.get("big_board", {}).get("players", [])
    }
    rookie_pick_by_id: dict[str, Any] = {}
    rookie_ids: set[str] = set()
    for p in sess.board():
        if p.selected_player_id:
            rookie_ids.add(p.selected_player_id)
            rookie_pick_by_id[p.selected_player_id] = {
                "round": p.round_1,
                "pick": p.pick_in_round_1,
                "overall": p.overall,
            }

    teams: dict[str, dict[str, Any]] = {
        name: {"team": name, "logo": nfl_logos.get(name), "by_position": {}}
        for name in idx_to_team.values()
    }

    for player in sess.data.get("players", []):
        team_idx = player.get("TeamIndex")
        if team_idx is None:
            continue
        try:
            team_idx = int(team_idx)
        except (TypeError, ValueError):
            continue
        team_name = idx_to_team.get(team_idx)
        if not team_name:
            continue
        # Player.xlsx contains placeholder rows (e.g. ~300 "Trey Trey" rows
        # tagged to the Bears in the test data) with OVR 0 — Madden-side
        # template slots, not real players. Filter them out so the roster
        # view shows only actual rostered players + drafted rookies.
        ovr = player.get("OverallRating")
        try:
            ovr_int = int(ovr) if ovr is not None else 0
        except (TypeError, ValueError):
            ovr_int = 0
        if ovr_int <= 0:
            continue
        pos = player.get("Position") or "—"
        college_id = player.get("College")
        college_name = college_id_to_name.get(college_id) if college_id else None
        key = (player.get("FirstName"), player.get("LastName"),
               player.get("PLYR_DRAFTROUND"), player.get("PLYR_DRAFTPICK"))
        bp = bigboard_by_key.get(key)
        big_id = bp.get("Player_ID") if bp else None
        entry = {
            "first_name": player.get("FirstName"),
            "last_name": player.get("LastName"),
            "ovr": player.get("OverallRating"),
            "age": player.get("Age"),
            "college": college_name,
            "college_logo": college_logos.get(college_name) if college_name else None,
            "player_id": big_id,
            "is_rookie": big_id in rookie_ids if big_id else False,
            "rookie_pick": rookie_pick_by_id.get(big_id) if big_id else None,
        }
        teams[team_name]["by_position"].setdefault(pos, []).append(entry)

    # Sort each position bucket by OVR desc (None last).
    for t in teams.values():
        for pos, players in t["by_position"].items():
            players.sort(key=lambda x: (-(x.get("ovr") or -1), x.get("last_name") or ""))

    # Return teams sorted alphabetically for stable display.
    out = sorted(teams.values(), key=lambda t: t["team"])
    return jsonify({"teams": out})


@app.post("/api/pick/make")
def api_pick_make():
    """User selects a player at their current pick."""
    sess, err = _require_session()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("player_id")
    if not pid:
        return jsonify({"ok": False, "error": "missing_player_id"}), 400
    result = sess.make_user_pick(pid)
    code = 200 if result.get("ok") else 400
    return jsonify(result), code


@app.post("/api/pick/force-make")
def api_pick_force_make():
    """Force a pick for whichever team is currently on the clock.

    Used by the user to override an AI team's selection. The body is the
    same as /api/pick/make ({player_id}); the difference is the backend
    doesn't restrict to the user's team.
    """
    sess, err = _require_session()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("player_id")
    if not pid:
        return jsonify({"ok": False, "error": "missing_player_id"}), 400
    result = sess.force_make_pick(pid)
    code = 200 if result.get("ok") else 400
    return jsonify(result), code


@app.post("/api/pick/sim")
def api_pick_sim():
    sess, err = _require_session()
    if err:
        return err
    return jsonify(sess.sim_one_pick())


@app.post("/api/pick/sim-until-user")
def api_pick_sim_until_user():
    sess, err = _require_session()
    if err:
        return err
    return jsonify(sess.sim_until_user())


@app.post("/api/pick/sim-until-round")
def api_pick_sim_until_round():
    sess, err = _require_session()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    target = int(body.get("round", 0))
    if target < 1:
        return jsonify({"ok": False, "error": "invalid_round"}), 400
    return jsonify(sess.sim_until_round(target))


@app.post("/api/pick/sim-until-end")
def api_pick_sim_until_end():
    """Sim all remaining picks. Stops if the user (Steelers) comes up."""
    sess, err = _require_session()
    if err:
        return err
    return jsonify(sess.sim_until_end())


@app.post("/api/pick/sim-until-overall")
def api_pick_sim_until_overall():
    sess, err = _require_session()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    target = int(body.get("overall", 0))
    if target < 1:
        return jsonify({"ok": False, "error": "invalid_overall"}), 400
    return jsonify(sess.sim_until_overall(target))


@app.get("/api/trade/down-offers")
def api_trade_down():
    sess, err = _require_session()
    if err:
        return err
    return jsonify(sess.get_trade_down_offers())


@app.post("/api/trade/up")
def api_trade_up():
    sess, err = _require_session()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    target = int(body.get("target_overall", 0))
    offered = body.get("offered_overalls") or []
    target_also_sends = body.get("target_also_sends") or []
    return jsonify(sess.submit_user_trade_up(
        target,
        [int(x) for x in offered],
        [int(x) for x in target_also_sends],
    ))


@app.post("/api/trade/manual")
def api_trade_manual():
    """Execute a manual trade between any two teams.

    Body: ``{team_a, team_b, team_a_overalls, team_b_overalls,
    force_override}``. When ``force_override`` is true, willingness /
    value checks are skipped.
    """
    sess, err = _require_session()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    team_a = body.get("team_a")
    team_b = body.get("team_b")
    a_overalls = [int(x) for x in (body.get("team_a_overalls") or [])]
    b_overalls = [int(x) for x in (body.get("team_b_overalls") or [])]
    force = bool(body.get("force_override"))
    return jsonify(sess.submit_manual_trade(
        str(team_a), str(team_b), a_overalls, b_overalls, force_override=force,
    ))


@app.post("/api/trade/accept-offer")
def api_trade_accept_offer():
    sess, err = _require_session()
    if err:
        return err
    body = request.get_json(force=True, silent=True) or {}
    from_team = body.get("from_team")
    if not from_team:
        return jsonify({"ok": False, "error": "missing_from_team"}), 400
    return jsonify(sess.accept_trade_down_offer(str(from_team)))


@app.post("/api/trade/force-qb")
def api_force_qb_trade():
    sess, err = _require_session()
    if err:
        return err
    result = sess.force_qb_trade()
    if not result.get("ok"):
        return jsonify(result), 400
    return jsonify(result)


@app.post("/api/trade/force")
def api_force_trade_preview():
    """Force the on-clock CPU team to shop their pick. Applies nothing —
    the resulting deal is previewed and must be accepted separately."""
    sess, err = _require_session()
    if err:
        return err
    result = sess.force_trade_preview()
    if not result.get("ok"):
        return jsonify(result), 400
    return jsonify(result)


@app.post("/api/trade/force/accept")
def api_force_trade_accept():
    sess, err = _require_session()
    if err:
        return err
    result = sess.accept_force_trade()
    if not result.get("ok"):
        return jsonify(result), 400
    return jsonify(result)


@app.post("/api/trade/force/decline")
def api_force_trade_decline():
    sess, err = _require_session()
    if err:
        return err
    return jsonify(sess.decline_force_trade())


@app.post("/api/export")
def api_export():
    sess, err = _require_session()
    if err:
        return err
    paths = exporter.export_session_zip(sess, _session_year)
    return jsonify({"ok": True, "paths": paths})


@app.get("/api/export/download/<kind>")
def api_export_download(kind: str):
    """Download an exported file by kind=outcome|picks|trades|zip.

    Forces a fresh export each call so the file is up to date.
    """
    sess, err = _require_session()
    if err:
        return err
    if kind == "zip":
        paths = exporter.export_session_zip(sess, _session_year)
    else:
        paths = exporter.export_session(sess, _session_year)
    target = paths.get(kind)
    if not target:
        return jsonify({"error": "unknown_kind"}), 400
    return send_file(target, as_attachment=True)


if __name__ == "__main__":
    # Bind to the IPv6 wildcard so both IPv6 and IPv4 loopback work.
    # Windows' hosts file maps `localhost` to ::1 first, and browsers try
    # IPv6 before falling back to IPv4 — if Flask only listens on
    # 127.0.0.1 that fallback waits ~2s per request, making every UI
    # click feel laggy. Dual-stacking removes the timeout.
    print("Madden Draft Tool — http://localhost:5050")
    app.run(host="::", port=5050, debug=True)
