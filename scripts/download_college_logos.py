"""Best-effort college football logo downloader.

Reads the Madden college list, matches schools against ESPN's college-football
team index, downloads logo PNGs, and writes a manifest that records both
matches and misses.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


ESPN_TEAMS_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/football/"
    "college-football/teams?limit=1000"
)


ALIASES = {
    "appalachian state": "app state",
    "beth cookman": "bethune cookman",
    "bowling green state": "bowling green",
    "c connecticut state": "central connecticut",
    "cal poly slo": "cal poly",
    "central state oh": "central state",
    "charleston": "charleston wv",
    "citadel": "the citadel",
    "connecticut": "uconn",
    "grambling": "grambling state",
    "fort hays state": "fort hays",
    "houston baptist": "houston christian",
    "la tech": "louisiana tech",
    "louisiana lafayette": "louisiana",
    "ul lafayette": "louisiana",
    "ul monroe": "louisiana monroe",
    "miami": "miami hurricanes",
    "miami ohio": "miami oh",
    "mines": "colorado school of mines",
    "middle tennessee state": "middle tennessee",
    "mississippi": "ole miss",
    "missouri western state": "missouri western",
    "n carolina": "north carolina",
    "n carolina at": "north carolina a and t",
    "n colorado": "northern colorado",
    "n dakota": "north dakota",
    "n dakota state": "north dakota state",
    "n illinois": "northern illinois",
    "n iowa": "northern iowa",
    "n texas": "north texas",
    "nebraska omaha": "omaha",
    "nicholls state": "nicholls",
    "s carolina": "south carolina",
    "s dakota": "south dakota",
    "s dakota state": "south dakota state",
    "s illinois": "southern illinois",
    "s mississippi": "southern miss",
    "s utah": "southern utah",
    "se louisiana": "southeastern louisiana",
    "se missouri state": "southeast missouri state",
    "sw missouri state": "missouri state",
    "se oklahoma state": "southeastern oklahoma state",
    "sw oklahoma state": "southwestern oklahoma state",
    "tamu commerce": "east texas a and m",
    "tenn chattanooga": "chattanooga",
    "tenn martin": "ut martin",
    "texas am": "texas a and m",
    "texas a and m commerce": "east texas a and m",
    "texas am commerce": "east texas a and m",
    "texas am kingsville": "texas a and m kingsville",
    "texas permian basin": "ut permian basin",
    "uni arkansas monticello": "arkansas monticello",
    "univ british columbia": "british columbia",
    "univ of minnesota duluth": "minnesota duluth",
    "mcneese state": "mcneese",
    "nw missouri state": "northwest missouri state",
    "rensselaer poly": "rensselaer",
    "w carolina": "western carolina",
    "w illinois": "western illinois",
    "w kentucky": "western kentucky",
    "w michigan": "western michigan",
    "w new mexico": "western new mexico",
    "w texas am": "west texas a and m",
    "wisc whitewater": "wisconsin whitewater",
    "uw la crosse": "wisconsin la crosse",
    "uw stevens point": "wisconsin stevens point",
    "uw stout": "wisconsin stout",
}

PREFERRED_ESPN_IDS = {
    "illinois": "356",
    "texas": "251",
    "w texas a and m": "2704",
}

DIRECTIONAL_TOKENS = (
    frozenset(("east", "eastern", "e")),
    frozenset(("west", "western", "w")),
    frozenset(("north", "northern", "n")),
    frozenset(("south", "southern", "s")),
)


def normalize(value: str) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    text = text.lower().strip()
    text = text.replace("&", " and ")
    text = text.replace("@", " at ")
    text = re.sub(r"\bst[.]\s*", "saint ", text)
    text = re.sub(r"\buni(?:v)?\.\b", "university", text)
    text = re.sub(r"\bmt\.\b", "mount", text)
    text = re.sub(r"\ba&m\b", "a and m", text)
    text = re.sub(r"\bu of\b", "university of", text)
    text = re.sub(r"[^\w\s]", " ", text)
    text = re.sub(r"\b(?:college|university|univ|uni|of|the)\b", " ", text)
    text = re.sub(r"\bat\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = ALIASES.get(text, text)
    return text


def has_directional_conflict(left: str, right: str) -> bool:
    left_tokens = set(left.split())
    right_tokens = set(right.split())
    left_direction = next((index for index, group in enumerate(DIRECTIONAL_TOKENS) if left_tokens & group), None)
    right_direction = next((index for index, group in enumerate(DIRECTIONAL_TOKENS) if right_tokens & group), None)
    return left_direction is not None and right_direction is not None and left_direction != right_direction


def slugify(value: str) -> str:
    text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    text = text.lower().strip()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


@dataclass(frozen=True)
class EspnTeam:
    id: str
    display_name: str
    location: str
    abbreviation: str
    logo_url: str
    candidates: tuple[str, ...]


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def fetch_json(url: str, cache_path: Path | None) -> Any:
    if cache_path and cache_path.exists():
        return read_json(cache_path)

    request = urllib.request.Request(url, headers={"User-Agent": "MaddenDraftTool/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if cache_path:
        write_json(cache_path, payload)
    return payload


def logo_url(team: dict[str, Any]) -> str | None:
    for logo in team.get("logos", []):
        rel = set(logo.get("rel", []))
        href = logo.get("href")
        if href and "default" in rel:
            return href
    logos = team.get("logos", [])
    return logos[0].get("href") if logos else None


def build_espn_teams(payload: dict[str, Any]) -> list[EspnTeam]:
    raw_teams = payload["sports"][0]["leagues"][0]["teams"]
    teams: list[EspnTeam] = []

    for item in raw_teams:
        team = item["team"]
        href = logo_url(team)
        if not href:
            continue

        fields = [
            team.get("location", ""),
            team.get("displayName", ""),
            team.get("shortDisplayName", ""),
            team.get("nickname", ""),
            team.get("abbreviation", ""),
        ]
        candidates = {normalize(field) for field in fields if field}
        display_name = team.get("displayName", "")
        mascot = normalize(team.get("name", ""))
        display_norm = normalize(display_name)
        if mascot and display_norm.endswith(mascot):
            candidates.add(display_norm[: -len(mascot)].strip())

        teams.append(
            EspnTeam(
                id=str(team["id"]),
                display_name=display_name,
                location=team.get("location", ""),
                abbreviation=team.get("abbreviation", ""),
                logo_url=href,
                candidates=tuple(sorted(c for c in candidates if c)),
            )
        )
    return teams


def match_college(college_name: str, teams: list[EspnTeam]) -> tuple[EspnTeam | None, float, str]:
    target = normalize(college_name)
    preferred_id = PREFERRED_ESPN_IDS.get(target)

    exact = [team for team in teams if target in team.candidates]
    if preferred_id:
        for team in exact or teams:
            if team.id == preferred_id:
                return team, 1.0, target

    if len(exact) == 1:
        return exact[0], 1.0, target

    if len(exact) > 1:
        best = min(exact, key=lambda t: len(normalize(t.location)))
        return best, 0.99, target

    best_team: EspnTeam | None = None
    best_score = 0.0
    best_candidate = ""
    for team in teams:
        for candidate in team.candidates:
            if has_directional_conflict(target, candidate):
                continue
            score = SequenceMatcher(None, target, candidate).ratio()
            if target and candidate and (target in candidate or candidate in target):
                score = max(score, 0.9 if min(len(target), len(candidate)) >= 8 else 0.82)
            if score > best_score:
                best_team = team
                best_score = score
                best_candidate = candidate

    if best_team and best_score >= 0.92:
        return best_team, best_score, best_candidate
    return None, best_score, best_candidate


def download(url: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "MaddenDraftTool/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        output_path.write_bytes(response.read())


def normalize_image(path: Path) -> None:
    try:
        subprocess.run(
            ["sips", "-z", "500", "500", str(path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--colleges", default="Files/TestFiles/all_colleges.json")
    parser.add_argument("--out-dir", default="static/college_logos")
    parser.add_argument("--manifest", default="static/college_logos/manifest.json")
    parser.add_argument("--espn-cache", default="/private/tmp/espn_cfb_teams.json")
    parser.add_argument("--clean", action="store_true", help="Remove existing PNGs in the output directory first.")
    args = parser.parse_args()

    colleges = read_json(Path(args.colleges))
    espn_payload = fetch_json(ESPN_TEAMS_URL, Path(args.espn_cache) if args.espn_cache else None)
    teams = build_espn_teams(espn_payload)

    out_dir = Path(args.out_dir)
    manifest_path = Path(args.manifest)
    if args.clean and out_dir.exists():
        for path in out_dir.glob("*.png"):
            path.unlink()

    manifest: list[dict[str, Any]] = []
    matched = 0
    downloaded = 0

    for college in colleges:
        college_name = college["collegeName"].strip()
        team, score, candidate = match_college(college_name, teams)
        slug = slugify(college_name)

        if team is None:
            manifest.append(
                {
                    "collegeName": college_name,
                    "binaryReference": college.get("binaryReference"),
                    "status": "missing",
                    "bestScore": round(score, 3),
                    "bestCandidate": candidate,
                }
            )
            continue

        matched += 1
        output_path = out_dir / f"{slug}.png"
        status = "matched"
        error = None
        try:
            if not output_path.exists():
                download(team.logo_url, output_path)
                downloaded += 1
            normalize_image(output_path)
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
            status = "download_failed"
            error = str(exc)

        record = {
            "collegeName": college_name,
            "binaryReference": college.get("binaryReference"),
            "status": status,
            "path": str(output_path) if status == "matched" else None,
            "espnTeamId": team.id,
            "espnDisplayName": team.display_name,
            "espnLocation": team.location,
            "espnAbbreviation": team.abbreviation,
            "matchScore": round(score, 3),
            "matchedCandidate": candidate,
            "sourceUrl": team.logo_url,
        }
        if error:
            record["error"] = error
        manifest.append(record)

    write_json(manifest_path, manifest)

    missing = sum(1 for item in manifest if item["status"] == "missing")
    failed = sum(1 for item in manifest if item["status"] == "download_failed")
    print(f"Colleges: {len(colleges)}")
    print(f"Matched: {matched}")
    print(f"Downloaded: {downloaded}")
    print(f"Missing: {missing}")
    print(f"Download failed: {failed}")
    print(f"Manifest: {manifest_path}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
