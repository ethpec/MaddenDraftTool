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
        # College logo for the drafted player.
        bb = session.data["big_board"]["players"]
        match = next((p for p in bb if p.get("Player_ID") == last_d["selected_player_id"]), None)
        if match:
            last_d["college"] = match.get("college")
            last_d["college_logo"] = match.get("college_logo")
            last_d["position"] = match.get("position")
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


def _board_payload(session: DraftSession) -> list[dict[str, Any]]:
    nfl_logos = session.data.get("nfl_logo_map", {})
    out = []
    for p in session.board():
        d = _pick_to_dict(p)
        if d:
            d["original_team_logo"] = nfl_logos.get(d["original_team"])
            d["current_team_logo"] = nfl_logos.get(d["current_team"])
        out.append(d)
    return out


def _public_big_board(session: DraftSession) -> list[dict[str, Any]]:
    """Mel Kiper view: rows in stored BigBoardRank order, no per-team rankings."""
    out = []
    for p in session.data["big_board"]["players"]:
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
        })
    out.sort(key=lambda r: r["rank"] or 9999)
    return out


def _team_big_board(session: DraftSession, team_name: str) -> list[dict[str, Any]]:
    player_map = {p.get("Player_ID"): p for p in session.data["big_board"]["players"]}
    board_order = session._team_boards.get(team_name, [])
    result = []
    rank = 1
    for original_rank, pid in enumerate(board_order, 1):
        p = player_map.get(pid)
        if p is None or p.get("drafted"):
            continue
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
        })
        rank += 1
    return result


def _team_needs(session: DraftSession, team_name: str) -> list[dict[str, Any]]:
    gm = next((g for g in session.data["gm_info"] if g.get("TeamName") == team_name), None)
    if gm is None:
        return []
    return logic.compute_team_needs(
        team_name,
        int(gm["TeamIndex"]),
        session.data["players"],
        session._weighted_needs,
    )


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


@app.post("/api/session/start")
def api_session_start():
    """Initialize a draft session for a given year."""
    global _session, _session_year
    body = request.get_json(force=True, silent=True) or {}
    year = body.get("year")
    data = data_loader.load_all(year)
    _session = DraftSession(data)
    _session_year = data.get("folder_name") or str(year)
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
    return jsonify({"picks": _board_payload(sess)})


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
    return jsonify({"gms": sess.data["gm_info"]})


@app.get("/api/trades")
def api_trades():
    sess, err = _require_session()
    if err:
        return err
    return jsonify({"trades": [t.__dict__ for t in sess.trade_log()]})


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
    return jsonify(sess.submit_user_trade_up(target, [int(x) for x in offered]))


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
    print("Madden Draft Tool — http://localhost:5050")
    app.run(host="127.0.0.1", port=5050, debug=True)
