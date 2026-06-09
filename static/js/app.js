// Madden Draft Tool — frontend controller.
//
// One file because the whole UI is small and synchronous: load year ->
// session -> board+boards -> render. State lives in the `state` object;
// every render() call rebuilds the relevant DOM subtree from state.

const api = {
  get: (p) => fetch(p).then(r => r.json()),
  post: (p, body) => fetch(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(r => r.json()),
};

const state = {
  session: null,
  teams: [],
  userTeam: null,
  board: [],
  publicBoard: [],
  teamBoard: [],
  selectedTeamForBoard: null,
  needs: [],
  selectedRound: 1,
  lastPick: null,
  needsFilterPos: null,
};

// Position taxonomy used by `compute_team_needs` (PositionNeeds.xlsx). The
// frontend's POSITION_ORDER groups things differently for the Big Board
// modal (e.g. END collapses LE/RE) but needs match by the backend's
// canonical group names — EDGE, LB, OT, OG — so this list mirrors those.
const NEEDS_FILTER_POSITIONS = [
  'QB','HB','FB','WR','TE','OG','OT','C',
  'EDGE','DT','LB','CB','SS','FS','K','P',
];

const PICK_SELECTION_SOUND_SRC = '/static/sounds/selection.mp3';
const TRADE_SOUND_SRC = '/static/sounds/trade.mp3';
const USER_ON_CLOCK_CHIME_SRC = '/static/sounds/chime.mp3';

function playSound(src, volume = 0.7) {
  const audio = new Audio(src);
  audio.volume = volume;
  audio.play().catch(() => {
    // Browsers may block sound if the action was not user-initiated.
  });
}

function playPickSelectionSound() {
  playSound(PICK_SELECTION_SOUND_SRC, 0.65);
}

function playTradeSound() {
  playSound(TRADE_SOUND_SRC, 0.75);
}

function playUserOnClockChime() {
  playSound(USER_ON_CLOCK_CHIME_SRC, 0.7);
}

function maybePlayUserOnClockChime(previousSession, nextSession) {
  const previousTeam = previousSession?.current_pick?.current_team;
  const nextTeam = nextSession?.current_pick?.current_team;
  if (previousTeam && previousTeam !== state.userTeam && nextTeam === state.userTeam) {
    playUserOnClockChime();
  }
}

// ---------- bootstrap ----------

const setupState = { selectedTeam: null };

window.addEventListener('DOMContentLoaded', async () => {
  await populateYears();
  document.getElementById('year-select').addEventListener('change', populateTeamsForYear);
  await populateTeamsForYear();
  document.getElementById('start-btn').addEventListener('click', startDraft);
  bindHeaderActions();
  bindModal();
});

async function populateYears() {
  const res = await api.get('/api/years');
  const sel = document.getElementById('year-select');
  sel.innerHTML = '';
  const options = res.years.length
    ? res.years.map(y => ({ label: y.is_test ? `${y.year} (test data)` : y.year, value: y.year }))
    : [{ label: 'TestFiles (default)', value: 'TestFiles' }];
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}

async function populateTeamsForYear() {
  const year = document.getElementById('year-select').value;
  const grid = document.getElementById('team-grid');
  grid.innerHTML = '<div class="col-span-8 text-xs text-slate-500 text-center py-2">Loading teams…</div>';
  try {
    const res = await api.get('/api/teams?year=' + encodeURIComponent(year));
    const teams = (res.teams || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    // Pick a sensible default — Steelers if present, else first team.
    const previous = setupState.selectedTeam;
    const teamNames = teams.map(t => t.name);
    if (!previous || !teamNames.includes(previous)) {
      setupState.selectedTeam = teamNames.includes('Steelers') ? 'Steelers' : teamNames[0] || null;
    }
    renderTeamGrid(teams);
  } catch (e) {
    grid.innerHTML = '<div class="col-span-8 text-xs text-rose-400 text-center py-2">Failed to load teams.</div>';
  }
}

function renderTeamGrid(teams) {
  const grid = document.getElementById('team-grid');
  grid.innerHTML = teams.map(t => {
    const sel = t.name === setupState.selectedTeam ? ' selected' : '';
    const img = t.logo
      ? `<img src="${t.logo}" alt="${escapeHtml(t.name)}">`
      : `<div class="text-slate-500 text-lg font-bold">${escapeHtml(t.name[0] || '?')}</div>`;
    return `<button type="button" class="team-tile${sel}" data-team="${escapeHtml(t.name)}">${img}<span class="team-tile-name">${escapeHtml(t.name)}</span></button>`;
  }).join('');
  grid.querySelectorAll('[data-team]').forEach(tile => {
    tile.addEventListener('click', () => {
      setupState.selectedTeam = tile.dataset.team;
      grid.querySelectorAll('.team-tile').forEach(t => t.classList.toggle('selected', t.dataset.team === setupState.selectedTeam));
    });
  });
}

async function startDraft() {
  const btn = document.getElementById('start-btn');
  const status = document.getElementById('setup-status');
  if (!setupState.selectedTeam) {
    status.textContent = 'Pick a team to control.';
    return;
  }
  btn.disabled = true;
  status.textContent = 'Loading data… (Player.xlsx is large, this can take 5–10s)';
  const year = document.getElementById('year-select').value;
  try {
    const res = await api.post('/api/session/start', { year, user_team: setupState.selectedTeam });
    if (!res.ok) throw new Error('Failed to start');
    state.session = res.session;
    state.teams = res.teams;
    state.userTeam = res.user_team;
    state.selectedTeamForBoard = res.user_team;
    document.getElementById('header-year').textContent = res.session.year || year;
    document.getElementById('setup').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    await refreshAll();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    btn.disabled = false;
  }
}

// ---------- data refresh ----------

async function refreshAll() {
  const [board, pub, gms] = await Promise.all([
    api.get('/api/board'),
    api.get('/api/big-board/public'),
    api.get('/api/gm-info'),
  ]);
  state.board = board.picks;
  state.futurePicks = board.future_picks || [];
  state.publicBoard = pub.players;
  invalidatePositionLookup();

  // Populate team-pickers if not already done.
  populateTeamPickers(gms.gms.map(g => g.TeamName));

  // Round tabs — clickable 1..maxRound. One click to switch rounds.
  const maxRound = Math.max(...state.board.map(p => p.round));
  const rp = document.getElementById('round-picker');
  if (!rp.dataset.bound) {
    rp.innerHTML = '';
    for (let r = 1; r <= maxRound; r++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'round-tab';
      btn.dataset.round = String(r);
      btn.textContent = String(r);
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-label', `Round ${r}`);
      btn.addEventListener('click', () => {
        state.selectedRound = r;
        renderRoundTitle();
        renderRoundGrid();
        updateRoundTabsActive();
      });
      rp.appendChild(btn);
    }
    rp.dataset.bound = '1';
  }

  // Auto-snap selected round to the round of the current pick.
  if (state.session.current_pick) {
    state.selectedRound = state.session.current_pick.round;
  }
  updateRoundTabsActive();

  await refreshContextual();
  renderAll();
}

function updateRoundTabsActive() {
  const tabs = document.querySelectorAll('#round-picker .round-tab');
  tabs.forEach(b => {
    const r = parseInt(b.dataset.round, 10);
    b.classList.toggle('active', r === state.selectedRound);
    b.setAttribute('aria-selected', r === state.selectedRound ? 'true' : 'false');
  });
}

async function refreshContextual() {
  // Things that depend on which team is on the clock or selected.
  const onClockTeam = state.session.current_pick?.current_team || state.userTeam;
  const [needs, teamBoard] = await Promise.all([
    api.get('/api/needs/' + encodeURIComponent(onClockTeam)),
    api.get('/api/big-board/team/' + encodeURIComponent(state.selectedTeamForBoard || state.userTeam)),
  ]);
  state.needs = needs.needs;
  state.teamBoard = teamBoard.players;
  // Most recent selection.
  const completed = state.board.filter(p => p.selected_player_id);
  state.lastPick = completed[completed.length - 1] || null;
}

// ---------- rendering ----------

function renderAll() {
  renderOnTheClock();
  renderLastPick();
  renderTeamNeeds();
  renderPreviousSelections();
  renderRoundTitle();
  renderRoundGrid();
  renderUserPicksSnapshot();
  renderNeedsFilter();
  renderTeamBoard();
  renderSimRoundSelect();
  updateTradeHistoryCount();
  // If the user had a needs filter active, the cache was cleared in
  // reloadSessionAndRender; re-fetch in the background and update the
  // highlight when the data lands.
  if (state.needsFilterPos) refreshNeedsFilterAfterReload();
}

async function refreshNeedsFilterAfterReload() {
  const pos = state.needsFilterPos;
  if (!pos) return;
  const teams = new Set();
  for (const p of state.board) {
    if (p.current_team && !_teamNeedsCache[p.current_team]) teams.add(p.current_team);
  }
  if (teams.size) {
    setNeedsFilterStatus('Loading needs…');
    await Promise.all([...teams].map(t => fetchTeamNeedsCached(t)));
  }
  if (state.needsFilterPos === pos) applyNeedsFilterHighlight();
}

async function updateTradeHistoryCount() {
  const badge = document.getElementById('trade-history-count');
  if (!badge) return;
  try {
    const res = await api.get('/api/trades');
    const n = (res.trades || []).length;
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n === 0);
  } catch (e) {
    badge.classList.add('hidden');
  }
}

function renderOnTheClock() {
  const c = state.session.current_pick;
  const teamEl = document.getElementById('on-the-clock-team');
  const metaEl = document.getElementById('on-the-clock-meta');
  const logoEl = document.getElementById('on-the-clock-logo');
  const progressBar = document.getElementById('draft-progress-bar');
  const progressMeta = document.getElementById('draft-progress-meta');
  const made = state.session.picks_made || 0;
  const total = state.session.total_picks || 0;
  if (progressBar) {
    const pct = total ? Math.min(100, Math.max(0, (made / total) * 100)) : 0;
    progressBar.style.width = pct + '%';
  }
  if (progressMeta) {
    progressMeta.textContent = total ? `${made} of ${total} selections made` : '';
  }
  if (!c) {
    teamEl.textContent = 'Draft Complete';
    metaEl.textContent = `${state.session.picks_made} of ${state.session.total_picks} picks`;
    if (logoEl) logoEl.innerHTML = '';
    return;
  }
  teamEl.textContent = c.current_team;
  metaEl.textContent = `${roundPickText(c)} (Overall ${c.overall})` +
    (c.original_team !== c.current_team ? ` · via ${c.original_team}` : '');
  if (logoEl) {
    logoEl.innerHTML = c.current_team_logo
      ? `<img src="${c.current_team_logo}" alt="${escapeHtml(c.current_team)}" class="h-16 w-16 object-contain">`
      : `<div class="h-16 w-16 rounded-full bg-ink-700 grid place-items-center text-2xl font-bold text-slate-500">${escapeHtml(c.current_team[0] || '?')}</div>`;
  }
  updateTradeHubBadge();
}

async function updateTradeHubBadge() {
  // Show offer count next to the Trade Hub header button when user is on clock.
  const badge = document.getElementById('trade-hub-header-badge');
  if (!badge) return;
  const c = state.session?.current_pick;
  if (!c || c.current_team !== state.userTeam) {
    badge.classList.add('hidden');
    return;
  }
  try {
    const res = await api.get('/api/trade/down-offers');
    const n = (res.ok && res.offers) ? res.offers.length : 0;
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n === 0);
  } catch (e) {
    badge.classList.add('hidden');
  }
}

function renderLastPick() {
  const el = document.getElementById('last-pick');
  const p = state.session.last_pick || state.lastPick;
  if (!p) {
    el.innerHTML = '<div class="text-xs text-slate-500">No picks yet.</div>';
    return;
  }
  // Portrait is the primary visual; college logo overlays the corner.
  // Both fall back gracefully — silhouette tile if no portrait, blank
  // corner if no college logo.
  const portraitInner = p.portrait_url
    ? `<img src="${p.portrait_url}" alt="${escapeHtml(p.selected_player_name || '')}" class="last-pick-portrait-img">`
    : `<div class="last-pick-portrait-fallback">${escapeHtml((p.selected_player_name || '?')[0])}</div>`;
  const collegeChip = p.college_logo
    ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="last-pick-college-chip">`
    : '';
  const teamLogo = p.current_team_logo
    ? `<img src="${p.current_team_logo}" alt="${escapeHtml(p.current_team)}" class="h-4 w-4 object-contain">`
    : '';
  const clickable = p.selected_player_id ? ' clickable' : '';
  const attr = p.selected_player_id
    ? ` data-player-id="${escapeHtml(p.selected_player_id)}" role="button" tabindex="0" title="View ${escapeHtml(p.selected_player_name || 'player')}"`
    : '';
  el.innerHTML = `
    <div class="last-pick-card${clickable}"${attr}>
      <div class="last-pick-portrait-wrap">
        ${portraitInner}
        ${collegeChip}
      </div>
      <div class="text-xs text-slate-500 flex items-center gap-1.5 justify-center mt-2">${teamLogo}<span>${roundPickLabel(p)} · ${escapeHtml(p.current_team)}</span></div>
      <div class="mt-1 text-base font-semibold text-center last-pick-name">${escapeHtml(p.selected_player_name || '')}</div>
      ${p.position ? `<div class="text-xs text-slate-400 text-center">${escapeHtml(p.position)}${p.college ? ' · ' + escapeHtml(p.college) : ''}</div>` : ''}
      ${(p.ovr != null || p.development_trait != null) ? `<div class="text-xs text-slate-400 text-center mt-0.5">${p.ovr != null ? `<span class="text-accent-gold font-semibold">OVR: ${escapeHtml(String(p.ovr))}</span>` : ''}${p.ovr != null && p.development_trait != null ? ' · ' : ''}${p.development_trait != null ? renderDevTraitBadge(p.development_trait) : ''}</div>` : ''}
    </div>
  `;
  const card = el.querySelector('.last-pick-card.clickable');
  if (card) {
    const trigger = () => openPlayerProfile(card.dataset.playerId);
    card.addEventListener('click', trigger);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
    });
  }
}

function renderDevTraitBadge(trait) {
  // Renders the dev trait with a per-tier icon. Star tier gets a gold
  // five-point star; Superstar gets a cool blue four-point sparkle
  // (visually distinct + reads as "more elite"); X-Factor gets a
  // magenta sparkle. Normal stays plain text in slate.
  const t = String(trait || '').toLowerCase().replace(/[^a-z]/g, '');
  const label = escapeHtml(String(trait));
  if (t.includes('xfactor')) {
    return `<span class="dev-trait-badge dev-xfactor"><span class="dev-icon">✦</span>${label}</span>`;
  }
  if (t.includes('superstar')) {
    return `<span class="dev-trait-badge dev-superstar"><span class="dev-icon">✦</span>${label}</span>`;
  }
  if (t.includes('star')) {
    return `<span class="dev-trait-badge dev-star"><span class="dev-icon">★</span>${label}</span>`;
  }
  return `<span class="dev-trait-badge dev-normal">${label}</span>`;
}

function renderTeamNeeds() {
  const el = document.getElementById('team-needs');
  if (!state.needs.length) {
    el.innerHTML = '<div class="text-xs text-slate-500">No needs computed.</div>';
    return;
  }
  const top = state.needs.slice(0, 8);
  for (let i = top.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [top[i], top[j]] = [top[j], top[i]];
  }
  // Save the shuffled order so the hover popover can show the same sequence
  // for the on-clock team instead of re-shuffling independently.
  const onClockTeam = state.session?.current_pick?.current_team || state.userTeam;
  state.needsDisplayed = { team: onClockTeam, needs: top };
  el.innerHTML = top.map(n => `
    <div class="need-row">
      <span class="pos">${n.label}</span>
    </div>
  `).join('');
}

function renderPreviousSelections() {
  const el = document.getElementById('previous-selections');
  if (!el) return;
  const onClockTeam = state.session?.current_pick?.current_team || state.userTeam;
  const playerMap = Object.fromEntries(state.publicBoard.map(p => [p.player_id, p]));
  const picks = state.board.filter(p => p.current_team === onClockTeam && p.selected_player_id);
  if (!picks.length) {
    el.innerHTML = '<div class="text-xs text-slate-500">No picks yet.</div>';
    return;
  }
  el.innerHTML = picks.map(p => {
    const player = playerMap[p.selected_player_id] || {};
    const pos = player.position ?? '—';
    const logo = player.college_logo
      ? `<img src="${player.college_logo}" alt="${escapeHtml(player.college || '')}" class="ps-logo">`
      : `<div class="ps-logo-placeholder"></div>`;
    return `<div class="ps-row clickable" data-player-id="${escapeHtml(p.selected_player_id)}" role="button" tabindex="0" title="View ${escapeHtml(p.selected_player_name)}">
      <span class="ps-pos">${escapeHtml(pos)}</span>
      ${logo}
      <span class="ps-meta">${escapeHtml(p.selected_player_name)} <span class="ps-rd">R${p.round} P${roundPickNumber(p)}</span></span>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-player-id]').forEach(row => {
    const trigger = () => openPlayerProfile(row.dataset.playerId);
    row.addEventListener('click', trigger);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
    });
  });
}

function renderRoundTitle() {
  document.getElementById('round-title').textContent = `Round ${state.selectedRound}`;
}

function renderRoundGrid(target = 'round-grid') {
  hideNeedsPopover();
  const el = document.getElementById(target);
  const picks = state.board.filter(p => p.round === state.selectedRound);
  el.innerHTML = picks.map(p => renderPickCell(p)).join('');
  bindOpenTeamRosterClicks(el);
  bindNeedsHover(el);
  if (target === 'round-grid') applyNeedsFilterHighlight();
}

// ---------- Pick cell hover → team needs popover ----------
// One shared popover element appended to <body>. Needs are fetched on
// first hover per team and cached for the session; the cache is cleared
// in reloadSessionAndRender since picks shift the need list.
let _teamNeedsCache = {};
let _needsPopoverEl = null;
let _needsHoverTimer = null;
let _needsActiveTeam = null;

function invalidateTeamNeedsCache() {
  _teamNeedsCache = {};
  rostersState.needsDisplayed = null;
  state.needsDisplayed = null;
}

function getNeedsPopoverEl() {
  if (_needsPopoverEl) return _needsPopoverEl;
  const el = document.createElement('div');
  el.className = 'pick-needs-popover';
  el.style.display = 'none';
  document.body.appendChild(el);
  _needsPopoverEl = el;
  return el;
}

async function fetchTeamNeedsCached(teamName) {
  if (_teamNeedsCache[teamName]) return _teamNeedsCache[teamName];
  try {
    const res = await api.get('/api/needs/' + encodeURIComponent(teamName));
    _teamNeedsCache[teamName] = res.needs || [];
  } catch (e) {
    _teamNeedsCache[teamName] = [];
  }
  return _teamNeedsCache[teamName];
}

function hideNeedsPopover() {
  if (_needsHoverTimer) { clearTimeout(_needsHoverTimer); _needsHoverTimer = null; }
  _needsActiveTeam = null;
  if (_needsPopoverEl) _needsPopoverEl.style.display = 'none';
}

function positionNeedsPopover(cellEl) {
  const pop = _needsPopoverEl;
  if (!pop) return;
  const cellRect = cellEl.getBoundingClientRect();
  pop.style.left = '0px';
  pop.style.top = '0px';
  pop.style.display = 'block';
  const popRect = pop.getBoundingClientRect();
  const margin = 8;
  let left = cellRect.right + margin;
  if (left + popRect.width > window.innerWidth - 4) {
    left = cellRect.left - popRect.width - margin;
  }
  if (left < 4) left = 4;
  let top = cellRect.top;
  if (top + popRect.height > window.innerHeight - 4) {
    top = window.innerHeight - popRect.height - 4;
  }
  if (top < 4) top = 4;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

async function showNeedsPopover(cellEl, teamName) {
  _needsActiveTeam = teamName;
  const pop = getNeedsPopoverEl();

  // Reuse an already-shuffled order if available — left-rail takes priority
  // (on-clock team), then the Rosters modal (any team currently displayed).
  const preShuffled = (state.needsDisplayed?.team === teamName && state.needsDisplayed.needs)
    || (rostersState.needsDisplayed?.team === teamName && rostersState.needsDisplayed.needs)
    || null;
  if (preShuffled) {
    const top = preShuffled;
    pop.innerHTML = `
      <div class="pick-needs-pop-head">${escapeHtml(teamName)} Needs</div>
      ${top.length
        ? `<div class="pick-needs-pop-list">${top.map(n => `<div class="pick-needs-pop-row">${escapeHtml(n.label)}</div>`).join('')}</div>`
        : `<div class="pick-needs-pop-empty">No needs computed.</div>`}
    `;
    positionNeedsPopover(cellEl);
    return;
  }

  pop.innerHTML = `
    <div class="pick-needs-pop-head">${escapeHtml(teamName)} Needs</div>
    <div class="pick-needs-pop-loading">Loading…</div>
  `;
  positionNeedsPopover(cellEl);
  const needs = await fetchTeamNeedsCached(teamName);
  // Bail if hover ended or moved to another team during the fetch.
  if (_needsActiveTeam !== teamName) return;
  if (!needs.length) {
    pop.innerHTML = `
      <div class="pick-needs-pop-head">${escapeHtml(teamName)} Needs</div>
      <div class="pick-needs-pop-empty">No needs computed.</div>
    `;
  } else {
    const top = needs.slice(0, 8);
    // Shuffle so the popover doesn't reveal weight-order for other teams.
    for (let i = top.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [top[i], top[j]] = [top[j], top[i]];
    }
    pop.innerHTML = `
      <div class="pick-needs-pop-head">${escapeHtml(teamName)} Needs</div>
      <div class="pick-needs-pop-list">
        ${top.map(n => `<div class="pick-needs-pop-row">${escapeHtml(n.label)}</div>`).join('')}
      </div>
    `;
  }
  positionNeedsPopover(cellEl);
}

function bindNeedsHover(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.pick-cell').forEach(cell => {
    const overall = parseInt(cell.dataset.overall, 10);
    const pick = state.board.find(p => p.overall === overall);
    if (!pick || !pick.current_team) return;
    const teamName = pick.current_team;
    cell.addEventListener('mouseenter', () => {
      if (_needsHoverTimer) clearTimeout(_needsHoverTimer);
      _needsHoverTimer = setTimeout(() => showNeedsPopover(cell, teamName), 250);
    });
    cell.addEventListener('mouseleave', () => hideNeedsPopover());
  });
}

// ---------- "Find Teams by Need" filter ----------
// Single-select pill grid in the right rail. Picking a position bulk-
// fetches every team's current needs and highlights matching pick cells
// in the round grid. Selection persists across round switches.
function renderNeedsFilter() {
  const el = document.getElementById('needs-filter-pills');
  if (!el) return;
  el.innerHTML = NEEDS_FILTER_POSITIONS.map(pos => {
    const active = state.needsFilterPos === pos;
    return `<button class="needs-filter-pill${active ? ' active' : ''}" data-pos="${pos}">${pos}</button>`;
  }).join('');
  el.querySelectorAll('.needs-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => onNeedsFilterClick(btn.dataset.pos));
  });
  setNeedsFilterStatus('');
}

function setNeedsFilterStatus(text) {
  const el = document.getElementById('needs-filter-status');
  if (el) el.textContent = text || '';
}

async function onNeedsFilterClick(pos) {
  state.needsFilterPos = state.needsFilterPos === pos ? null : pos;
  renderNeedsFilter();
  if (!state.needsFilterPos) {
    applyNeedsFilterHighlight();
    return;
  }
  // Bulk-fetch any uncached team needs so the highlight reflects every
  // team on the board, not just ones the user happened to hover.
  const needsToFetch = new Set();
  for (const p of state.board) {
    if (p.current_team && !_teamNeedsCache[p.current_team]) {
      needsToFetch.add(p.current_team);
    }
  }
  if (needsToFetch.size) {
    setNeedsFilterStatus('Loading needs…');
    await Promise.all([...needsToFetch].map(t => fetchTeamNeedsCached(t)));
  }
  applyNeedsFilterHighlight();
}

function applyNeedsFilterHighlight() {
  const grid = document.getElementById('round-grid');
  if (!grid) return;
  const pos = state.needsFilterPos;
  let matchCount = 0;
  grid.querySelectorAll('.pick-cell').forEach(cell => {
    cell.classList.remove('needs-match');
    if (!pos) return;
    const overall = parseInt(cell.dataset.overall, 10);
    const pick = state.board.find(p => p.overall === overall);
    if (!pick) return;
    const teamNeeds = _teamNeedsCache[pick.current_team];
    if (!teamNeeds) return;
    if (teamNeeds.some(n => n.position === pos)) {
      cell.classList.add('needs-match');
      matchCount += 1;
    }
  });
  if (!pos) {
    setNeedsFilterStatus('');
  } else {
    const teamsWithNeed = new Set();
    for (const p of state.board) {
      const ns = _teamNeedsCache[p.current_team];
      if (ns && ns.some(n => n.position === pos)) {
        teamsWithNeed.add(p.current_team);
      }
    }
    setNeedsFilterStatus(`${teamsWithNeed.size} team${teamsWithNeed.size === 1 ? '' : 's'} need ${pos} · ${matchCount} pick${matchCount === 1 ? '' : 's'} this round`);
  }
}

function bindSimToPickClicks(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.pick-cell.simmable').forEach(cell => {
    const trigger = () => promptSimUntilOverall(parseInt(cell.dataset.overall, 10));
    cell.addEventListener('click', trigger);
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
    });
  });
}

function bindOpenTeamRosterClicks(rootEl) {
  // Main-board pick cells:
  //   - Completed pick (player drafted) → opens that player's profile
  //   - Future / on-clock pick           → opens the owning team's roster
  // (The Full Draft Order modal keeps the older "click to sim" behavior
  // via bindSimToPickClicks.)
  if (!rootEl) return;
  rootEl.querySelectorAll('.pick-cell').forEach(cell => {
    const overall = parseInt(cell.dataset.overall, 10);
    const pick = state.board.find(p => p.overall === overall);
    if (!pick) return;
    const trigger = pick.selected_player_id
      ? () => openPlayerProfile(pick.selected_player_id)
      : () => openRosterForTeam(pick.current_team);
    cell.style.cursor = 'pointer';
    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.addEventListener('click', trigger);
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
    });
  });
}

function openRosterForTeam(teamName) {
  if (!teamName) return;
  // Preset rostersState so openRosters picks the right team on load.
  rostersState.team = teamName;
  openRosters();
}

function promptSimUntilOverall(overall) {
  if (!overall) return;
  const c = state.session?.current_pick;
  if (c && overall <= c.overall) return;
  const target = state.board.find(p => p.overall === overall);
  if (!target) return;
  confirmAction({
    title: `Sim to ${roundPickLabel(target)}?`,
    message: `Sim through every pick before overall #${overall}, stopping with the ${target.current_team} on the clock.`,
    confirmLabel: 'Sim',
    onConfirm: () => simUntilOverall(overall),
  });
}

async function simUntilOverall(overall) {
  await api.post('/api/pick/sim-until-overall', { overall });
  await reloadSessionAndRender();
  toast(`Sim'd to overall #${overall}.`);
}

// Built lazily by getPositionByPlayerId() and invalidated when the
// public board changes (handled in reloadSessionAndRender). Avoids
// O(n*m) scans when rendering many pick cells at once.
let _positionByPlayerId = null;
let _devTraitByPlayerId = null;
function getPositionByPlayerId() {
  if (_positionByPlayerId === null) {
    _positionByPlayerId = {};
    for (const pl of state.publicBoard) {
      if (pl.player_id) _positionByPlayerId[pl.player_id] = pl.position;
    }
  }
  return _positionByPlayerId;
}
function getDevTraitByPlayerId() {
  if (_devTraitByPlayerId === null) {
    _devTraitByPlayerId = {};
    for (const pl of state.publicBoard) {
      if (pl.player_id) _devTraitByPlayerId[pl.player_id] = pl.development_trait;
    }
  }
  return _devTraitByPlayerId;
}
function invalidatePositionLookup() {
  _positionByPlayerId = null;
  _devTraitByPlayerId = null;
}

function knownPicksForDisplay() {
  return [...(state.board || []), ...(state.futurePicks || [])];
}

function pickDisplayKey(p) {
  return p?.draft_slot ?? p?.overall ?? p?.pick_in_round ?? 0;
}

function roundPickNumber(p, picks = knownPicksForDisplay()) {
  if (!p?.round) return p?.pick_in_round ?? '?';
  const round = Number(p.round);
  const yearOffset = Number(p.year_offset || 0);
  const pool = (picks || [])
    .filter(q => q
      && Number(q.round) === round
      && Number(q.year_offset || 0) === yearOffset)
    .slice()
    .sort((a, b) => pickDisplayKey(a) - pickDisplayKey(b));
  if (pool.length) {
    const idx = pool.findIndex(q =>
      (p.overall != null && q.overall === p.overall)
      || (p.draft_slot != null && q.draft_slot === p.draft_slot));
    if (idx >= 0) return idx + 1;
  }
  return p.pick_in_round ?? '?';
}

function roundPickLabel(p) {
  return `R${p.round}.${roundPickNumber(p)}`;
}

function roundPickText(p) {
  return `Round ${p.round}, Pick ${roundPickNumber(p)}`;
}

function renderUserPicksSnapshot() {
  const el = document.getElementById('user-picks-snapshot');
  if (!el) return;
  const current = (state.board || [])
    .filter(p => p.current_team === state.userTeam && !p.selected_player_id)
    .slice()
    .sort((a, b) => (a.overall || 9999) - (b.overall || 9999));
  const next = (state.futurePicks || [])
    .filter(p => p.current_team === state.userTeam)
    .slice()
    .sort((a, b) => (a.draft_slot || a.overall || 9999) - (b.draft_slot || b.overall || 9999));
  const line = (label, picks, jumpable) => {
    const chips = picks.length
      ? picks.map(p => renderUserPickChip(p, jumpable)).join('')
      : '<span class="user-picks-empty">none</span>';
    return `<div class="user-picks-line">
      <div class="user-picks-label">${label}</div>
      <div class="user-picks-chips">${chips}</div>
    </div>`;
  };
  el.innerHTML = `
    ${line('This', current, true)}
    ${line('Next', next, false)}
  `;
  el.querySelectorAll('[data-jump-round]').forEach(chip => {
    chip.addEventListener('click', () => {
      const r = parseInt(chip.dataset.jumpRound, 10);
      if (!r) return;
      state.selectedRound = r;
      renderRoundTitle();
      renderRoundGrid();
      updateRoundTabsActive();
      // If the round card is off-screen, scroll it into view so the
      // click feels like a "jump" instead of a silent state change.
      const card = document.getElementById('round-title')?.closest('.card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

function renderUserPickChip(p, jumpable) {
  const slot = p.draft_slot ?? p.overall;
  const via = p.original_team && p.original_team !== p.current_team
    ? ` via ${p.original_team}`
    : '';
  const cls = 'user-pick-chip' + (jumpable ? ' jumpable' : '');
  const jumpAttr = jumpable ? ` data-jump-round="${p.round}"` : '';
  const titleSuffix = jumpable ? ' — click to view Round ' + p.round : '';
  return `<span class="${cls}"${jumpAttr} title="${roundPickLabel(p)} · #${slot}${escapeHtml(via)}${titleSuffix}">
    ${roundPickLabel(p)}<span>#${slot}</span>
  </span>`;
}

function renderPickCell(p) {
  const onClock = state.session.current_pick && state.session.current_pick.overall === p.overall;
  const isUser = p.current_team === state.userTeam;
  const completed = !!p.selected_player_id;
  const currentOverall = state.session.current_pick?.overall ?? 0;
  const simmable = !completed && !onClock && p.overall > currentOverall;
  const cls = ['pick-cell'];
  if (isUser) cls.push('user-pick');
  if (onClock) cls.push('on-clock');
  if (completed) cls.push('completed');
  if (simmable) cls.push('simmable');
  let playerLine;
  let devBadge = '';
  if (completed) {
    const pos = getPositionByPlayerId()[p.selected_player_id];
    const posTag = pos ? `<span class="pick-pos">${escapeHtml(displayPosition(pos))}</span>` : '';
    playerLine = `<div class="pick-player">${posTag}${escapeHtml(p.selected_player_name)}</div>`;
    // Small dev-trait badge top-right — only for Star / Superstar /
    // X-Factor, so the cell stays clean for the 90%+ of Normal picks.
    const trait = getDevTraitByPlayerId()[p.selected_player_id];
    devBadge = renderPickCellDevTraitIcon(trait);
  } else {
    playerLine = `<div class="pick-player placeholder">${onClock ? 'On the clock…' : 'TBD'}</div>`;
  }
  const trade = p.original_team !== p.current_team
    ? `<div class="text-[9px] uppercase tracking-wider text-accent-500 mt-0.5">via ${escapeHtml(p.original_team)}</div>`
    : '';
  const logo = p.current_team_logo
    ? `<img src="${p.current_team_logo}" alt="${escapeHtml(p.current_team)}" class="pick-logo">`
    : '';
  return `
    <div class="${cls.join(' ')}" data-overall="${p.overall}"${simmable ? ' role="button" tabindex="0"' : ''}>
      ${devBadge}
      <div class="pick-num">${roundPickLabel(p)} · #${p.overall}</div>
      <div class="pick-header">${logo}<div class="pick-team">${escapeHtml(p.current_team)}</div></div>
      ${playerLine}
      ${trade}
    </div>
  `;
}

function renderPickCellDevTraitIcon(trait) {
  // Compact corner badge for the round-grid / full-board pick cells.
  // Skips Normal so cells stay uncluttered; matches the symbol+color
  // language of the Last Selection dev trait badge.
  const t = String(trait || '').toLowerCase().replace(/[^a-z]/g, '');
  if (t.includes('xfactor')) {
    return '<span class="pick-dev-badge dev-xfactor" title="X-Factor">✦</span>';
  }
  if (t.includes('superstar')) {
    return '<span class="pick-dev-badge dev-superstar" title="Superstar">✦</span>';
  }
  if (t.includes('star')) {
    return '<span class="pick-dev-badge dev-star" title="Star">★</span>';
  }
  return '';
}

function renderTeamBoard() {
  const picker = document.getElementById('team-board-picker');
  if (picker.value !== state.selectedTeamForBoard) {
    picker.value = state.selectedTeamForBoard || state.userTeam;
  }
  const drafted = new Set(state.board.filter(p => p.selected_player_id).map(p => p.selected_player_id));
  const draftableEnabled = !!state.session.current_pick;
  const rows = state.teamBoard.slice(0, 100).map(p => {
    const isDrafted = drafted.has(p.player_id) || p.drafted;
    const cls = ['bb-row', 'bb-row-team'];
    if (isDrafted) cls.push('drafted');
    else if (draftableEnabled) cls.push('draftable');
    const logo = p.college_logo
      ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="bb-logo">`
      : `<div class="bb-logo-placeholder"></div>`;
    const sub = [p.position, p.college].filter(Boolean).map(escapeHtml).join(' · ');
    const action = !isDrafted
      ? `<button class="bb-action" data-draft-id="${escapeHtml(p.player_id)}">Draft</button>`
      : '';
    return `
      <div class="${cls.join(' ')}" data-player-id="${escapeHtml(p.player_id)}">
        <div class="bb-rank">${p.team_rank ?? '—'}${p.original_rank != null && p.original_rank !== p.team_rank ? `<span class="bb-orig-rank">(${p.original_rank})</span>` : ''}</div>
        ${logo}
        <div class="bb-info">
          <div class="bb-name">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div>
          ${sub ? `<div class="bb-sub">${sub}</div>` : ''}
        </div>
        <div class="bb-consensus">${renderConsensusDelta(p)}</div>
        ${action}
      </div>
    `;
  }).join('');
  const el = document.getElementById('team-board');
  el.innerHTML = rows || '<div class="text-xs text-slate-500 py-2">No available players.</div>';
  el.querySelectorAll('[data-draft-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitPick(btn.dataset.draftId);
    });
  });
  el.querySelectorAll('[data-player-id]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-draft-id]')) return;
      openPlayerProfile(row.dataset.playerId);
    });
  });
}

function populateTeamPickers(teamNames) {
  const picker = document.getElementById('team-board-picker');
  if (picker.options.length) return;
  for (const t of teamNames) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    picker.appendChild(o);
  }
  picker.value = state.userTeam;
  picker.addEventListener('change', async () => {
    state.selectedTeamForBoard = picker.value;
    const res = await api.get('/api/big-board/team/' + encodeURIComponent(picker.value));
    state.teamBoard = res.players;
    renderTeamBoard();
  });
}

// ---------- actions ----------

function bindHeaderActions() {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => onAction(btn.dataset.action));
  });
}

async function onAction(action) {
  switch (action) {
    case 'sim-pick': return simPick();
    case 'sim-until-user': return simUntilUser();
    case 'open-board-zoom': return openFullBoard();
    case 'export': return doExport();
    case 'trade-down': return showTradeDownOffers();
    case 'trade-up': return openTradeUpModal();
    case 'trade-hub': return openTradeHub();
    case 'trade-history': return openTradeHistory();
    case 'rosters': return openRosters();
    case 'gm-info': return openGMInfo();
    case 'sim-report': return openSimReport();
    case 'open-big-board': return openBigBoardModal();
  }
}

async function simPick() {
  const c = state.session.current_pick;
  if (!c) return toast('Draft complete.');
  if (c.current_team === state.userTeam) {
    return toast("You are on the clock — pick or trade.");
  }
  const res = await api.post('/api/pick/sim');
  if (!res.ok) return toast('Sim failed: ' + (res.error || 'unknown'));
  if (res.trade) {
    playTradeSound();
  } else if (res.pick) {
    playPickSelectionSound();
  }
  await reloadSessionAndRender();
  if (res.trade) {
    showTradeModal(res.trade, res.pick);
  } else if (res.pick) {
    toast(`${roundPickLabel(res.pick)}: ${res.pick.current_team} → ${res.pick.selected_player_name}`);
  }
}

function buildTeamLogoMap() {
  const map = {};
  for (const p of [...state.board, ...(state.futurePicks || [])]) {
    if (p.current_team && p.current_team_logo) map[p.current_team] = p.current_team_logo;
    if (p.original_team && p.original_team_logo) map[p.original_team] = p.original_team_logo;
  }
  return map;
}

function showTradeModal(trade, pick) {
  const allPicks = [...state.board, ...(state.futurePicks || [])];
  const logoMap = buildTeamLogoMap();
  const getVal = overall => allPicks.find(p => p.overall === overall)?.value ?? null;

  const formatPickRow = p => {
    const val = getVal(p.overall);
    const nyBadge = p.year_offset
      ? ' <span class="text-[10px] font-semibold text-amber-400 border border-amber-700 rounded px-1 leading-tight">NY</span>'
      : '';
    const valStr = val != null
      ? `<span class="font-mono text-accent-400">${val.toLocaleString()}</span>`
      : '<span class="text-slate-600">—</span>';
    return `<div class="flex items-center justify-between py-1 text-sm">
      <span>${roundPickLabel(p)}${nyBadge} <span class="text-slate-500 text-xs">#${p.draft_slot ?? p.overall}</span></span>
      <span class="ml-3">${valStr} pts</span>
    </div>`;
  };

  const teamPanel = (teamName, sends, totalVal, direction) => {
    const logo = logoMap[teamName];
    const logoEl = logo
      ? `<img src="${logo}" class="w-10 h-10 object-contain flex-shrink-0" onerror="this.style.display='none'">`
      : `<div class="w-10 h-10 rounded-full bg-ink-700 flex-shrink-0"></div>`;
    const dirColor = direction === 'up' ? 'text-emerald-400' : 'text-amber-400';
    const dirLabel = direction === 'up' ? '▲ Trades Up' : '▼ Trades Down';
    return `
      <div class="flex-1 min-w-0 space-y-2">
        <div class="flex items-center gap-2">
          ${logoEl}
          <div>
            <div class="font-semibold text-sm">${escapeHtml(teamName)}</div>
            <div class="text-xs ${dirColor}">${dirLabel}</div>
          </div>
        </div>
        <div class="text-xs uppercase text-slate-400">Sends</div>
        <div class="border border-ink-700 rounded p-2 bg-ink-900 divide-y divide-ink-800">
          ${sends.map(formatPickRow).join('')}
        </div>
        <div class="text-xs text-right text-slate-400">
          Total: <span class="text-accent-400 font-mono font-semibold">${totalVal.toLocaleString()} pts</span>
        </div>
      </div>`;
  };

  const player = pick?.selected_player_id
    ? state.publicBoard.find(p => p.player_id === pick.selected_player_id)
    : null;
  const selectionLine = pick?.selected_player_name
    ? `<div class="mt-4 pt-3 border-t border-ink-700 text-sm text-center text-slate-300">
        ${escapeHtml(trade.trading_up)} selected
        <span class="text-white font-semibold">${escapeHtml(pick.selected_player_name)}</span>${player?.position ? ` <span class="text-slate-500">· ${player.position}</span>` : ''}
      </div>`
    : '';

  const returnPicks = trade.return_picks || [];
  const returnValue = trade.return_value || 0;
  const downSends = [trade.target_pick, ...returnPicks];
  const downTotal = trade.target_value + returnValue;
  const body = `
    <div class="space-y-4">
      <div class="flex gap-3 items-start">
        ${teamPanel(trade.trading_down, downSends, downTotal, 'down')}
        <div class="pt-10 text-slate-500 text-lg flex-shrink-0">⇄</div>
        ${teamPanel(trade.trading_up, trade.offered_picks, trade.offer_value, 'up')}
      </div>
      ${selectionLine}
    </div>`;

  openModal('Trade Executed', `${escapeHtml(trade.trading_up)} acquires pick #${trade.target_pick?.draft_slot ?? trade.target_pick?.overall}`, body);
}

async function simUntilUser() {
  const res = await api.post('/api/pick/sim-until-user');
  await reloadSessionAndRender();
  const tradeCount = (res.events || []).filter(e => e.trade).length;
  toast('Sim complete.' + (tradeCount ? ` ${tradeCount} trade${tradeCount > 1 ? 's' : ''} occurred.` : ''));
}

function renderSimRoundSelect() {
  const sel = document.getElementById('sim-round-select');
  if (!sel) return;
  const currentRound = state.session?.current_pick?.round ?? 1;
  const totalRounds = state.board.length ? Math.max(...state.board.map(p => p.round)) : 7;
  sel.innerHTML = '<option value="" disabled selected>Sim to Round…</option>';
  for (let r = currentRound + 1; r <= totalRounds; r++) {
    const opt = document.createElement('option');
    opt.value = String(r);
    opt.textContent = `Round ${r}`;
    sel.appendChild(opt);
  }
  if (!state.session?.is_complete) {
    const endOpt = document.createElement('option');
    endOpt.value = 'end';
    endOpt.textContent = 'End of Draft';
    sel.appendChild(endOpt);
  }
  sel.disabled = sel.options.length <= 1;
  if (!sel.dataset.bound) {
    sel.addEventListener('change', simUntilRoundFromSelect);
    sel.dataset.bound = '1';
  }
}

function simUntilRoundFromSelect() {
  const sel = document.getElementById('sim-round-select');
  if (!sel) return;
  const v = sel.value;
  // Always reset to placeholder so re-picking the same option fires again.
  sel.value = '';
  if (!v) return;
  if (v === 'end') {
    confirmAction({
      title: 'Sim to End of Draft?',
      message: 'AI will fill every remaining pick — including your team. This cannot be undone in this session.',
      confirmLabel: 'Sim to End',
      onConfirm: async () => {
        await api.post('/api/pick/sim-until-end');
        await reloadSessionAndRender();
        toast('Draft complete.');
      },
    });
    return;
  }
  const r = parseInt(v, 10);
  if (!r || isNaN(r)) return;
  confirmAction({
    title: `Sim to Round ${r}?`,
    message: `Sim every pick until the first pick of Round ${r} is on the clock.`,
    confirmLabel: `Sim to R${r}`,
    onConfirm: async () => {
      await api.post('/api/pick/sim-until-round', { round: r });
      await reloadSessionAndRender();
    },
  });
}

async function submitPick(playerId) {
  // Universal pick handler: drafts the player for whichever team is on
  // the clock. The user controls every team's pick button — there's no
  // separate "force pick" mode anymore.
  const c = state.session.current_pick;
  if (!c) return toast('Draft complete.');

  // Confirmation dialog — guards against accidental Draft clicks.
  const player = (state.publicBoard || []).find(p => p.player_id === playerId);
  const name = player ? `${player.first_name} ${player.last_name}` : 'this player';
  const ok = await confirmAction({
    title: 'Confirm Draft',
    message: `Are you sure you want to draft ${name}?`,
    confirmLabel: 'Yes',
    cancelLabel: 'No',
  });
  if (!ok) return;

  const res = await api.post('/api/pick/force-make', { player_id: playerId });
  if (!res.ok) return toast('Pick failed: ' + res.error);
  playPickSelectionSound();
  await reloadSessionAndRender();
  toast(`${res.drafted_for || c.current_team} drafted.`);
}

async function reloadSessionAndRender() {
  const previousSession = state.session;
  const [s, b, pub] = await Promise.all([
    api.get('/api/session'),
    api.get('/api/board'),
    api.get('/api/big-board/public'),
  ]);
  state.session = s.session;
  state.board = b.picks;
  state.futurePicks = b.future_picks || [];
  state.publicBoard = pub.players;
  invalidatePositionLookup();
  invalidateTeamNeedsCache();
  maybePlayUserOnClockChime(previousSession, state.session);
  if (state.session.current_pick) {
    state.selectedRound = state.session.current_pick.round;
    updateRoundTabsActive();
  }
  await refreshContextual();
  renderAll();
}

async function doExport() {
  try {
    const res = await fetch('/api/export/download/zip');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return toast('Export failed: ' + (body.message || body.error || res.status));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'DraftExport.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Export downloaded.');
  } catch (e) {
    toast('Export failed: ' + e.message);
  }
}

async function showTradeDownOffers() {
  const res = await api.get('/api/trade/down-offers');
  openModal('Trade-Down Offers', 'Teams that would trade up to this pick',
    !res.ok ? '<div class="text-xs text-rose-400">' + (res.error || 'error') + '</div>'
    : (res.offers && res.offers.length
        ? renderOffersTable(res.offers)
        : '<div class="text-sm text-slate-400">No teams are interested in trading up right now.</div>'));
  wireAcceptOfferButtons();
}

function openTradeUpModal(opts = {}) {
  const myUnpickedPicks = state.board.filter(p => p.current_team === state.userTeam && !p.selected_player_id);
  const targets = state.board.filter(p => p.current_team !== state.userTeam && !p.selected_player_id)
    .slice(0, 64);
  const preselect = opts.targetCurrent && state.session.current_pick
    ? state.session.current_pick.overall : null;
  const targetOpts = targets.map(p => {
    const sel = preselect === p.overall ? ' selected' : '';
    return `<option value="${p.overall}"${sel}>${roundPickLabel(p)} · ${escapeHtml(p.current_team)} (overall ${p.overall})</option>`;
  }).join('');
  const offerCheckboxes = myUnpickedPicks.map(p => `
    <label class="flex items-center gap-2 text-sm py-1">
      <input type="checkbox" class="trade-up-offer" value="${p.overall}">
      <span>${roundPickLabel(p)} (overall ${p.overall})</span>
    </label>
  `).join('');
  const subtitle = opts.targetCurrent && state.session.current_pick
    ? `Trade up to the ${state.session.current_pick.current_team}'s current pick`
    : 'Send picks to move up the board';
  const body = `
    <div class="space-y-3">
      <div>
        <label class="text-xs uppercase text-slate-400">Target Pick</label>
        <select id="trade-up-target" class="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-sm">${targetOpts}</select>
      </div>
      <div>
        <label class="text-xs uppercase text-slate-400">Picks You Offer</label>
        <div class="mt-1 max-h-48 overflow-y-auto pretty-scroll border border-ink-700 rounded p-2">${offerCheckboxes || '<div class="text-xs text-slate-500">No picks left to offer.</div>'}</div>
      </div>
      <button id="submit-trade-up" class="primary-btn w-full">Submit Offer</button>
      <div id="trade-up-result" class="text-sm text-slate-400"></div>
    </div>
  `;
  openModal('Offer Trade Up', subtitle, body);
  document.getElementById('submit-trade-up').addEventListener('click', submitTradeUp);
}

// Persists which tab was last open between Trade Hub re-renders.
const tradeHubState = { tab: 'user' };

async function openTradeHub() {
  // Trade Hub modal. Has two tabs:
  //  - "Your Trade": user-centric flow (incoming offers + propose trade).
  //    Behavior matches the old single-purpose Trade Hub.
  //  - "Two-Team Trade": craft a trade between any two teams (CPU-CPU,
  //    user-CPU, etc.) with an optional Force Override checkbox that
  //    bypasses willingness + value checks.
  const c = state.session?.current_pick;
  const isUserPick = c?.current_team === state.userTeam;

  const subtitle = c
    ? (isUserPick
        ? 'Review incoming offers, propose a trade, or set up a custom trade'
        : `Propose a trade for ${c.current_team}'s pick, or set up a custom trade`)
    : 'Draft complete — set up a hypothetical trade';

  const tabs = `
    <div class="trade-hub-tabs">
      <button class="trade-hub-tab${tradeHubState.tab === 'user' ? ' active' : ''}" data-th-tab="user">
        ${isUserPick ? 'Incoming Offers' : `${escapeHtml(state.userTeam)} Trade`}
      </button>
      <button class="trade-hub-tab${tradeHubState.tab === 'manual' ? ' active' : ''}" data-th-tab="manual">
        Two-Team Trade
      </button>
    </div>
    <div id="trade-hub-body" class="mt-3"></div>
  `;
  document.getElementById('modal-root').classList.add('trade-hub-modal');
  openModal('Trade Hub', subtitle, tabs);
  renderTradeHubTab();
  document.querySelectorAll('[data-th-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      tradeHubState.tab = btn.dataset.thTab;
      document.querySelectorAll('[data-th-tab]').forEach(b =>
        b.classList.toggle('active', b.dataset.thTab === tradeHubState.tab));
      renderTradeHubTab();
    });
  });
}

async function renderTradeHubTab() {
  const body = document.getElementById('trade-hub-body');
  if (!body) return;
  if (tradeHubState.tab === 'manual') {
    body.innerHTML = renderManualTradeForm();
    wireManualTradeForm();
    return;
  }
  // 'user' tab — original behavior.
  const c = state.session?.current_pick;
  const isUserPick = c?.current_team === state.userTeam;
  if (!c) {
    body.innerHTML = '<div class="text-sm text-slate-400">Draft is complete — no live picks. Switch to Two-Team Trade for hypotheticals.</div>';
    return;
  }
  if (isUserPick) {
    const res = await api.get('/api/trade/down-offers').catch(() => ({ ok: false }));
    const offers = (res.ok && res.offers) || [];
    const targetLabel = `${roundPickLabel(c)} · pick #${c.draft_slot ?? c.overall}`;
    const offersBlock = offers.length
      ? renderOffersTable(offers)
      : '<div class="text-sm text-slate-400">No incoming trade-up offers right now.</div>';
    body.innerHTML = `
      <div class="space-y-5">
        <div>
          <div class="card-eyebrow mb-2">Incoming Offers</div>
          <div class="text-xs text-slate-400 mb-2">
            Each offer is to acquire your on-clock pick
            <span class="text-accent-400 font-mono">${targetLabel}</span>.
          </div>
          ${offersBlock}
        </div>
        <div class="border-t border-ink-700 pt-4">
          <div class="card-eyebrow mb-2">Offer Manual Trade</div>
          ${buildTradeForm(c, isUserPick)}
        </div>
      </div>
    `;
  } else {
    body.innerHTML = `
      <div class="space-y-3">
        <div class="card-eyebrow">Trade Up to ${escapeHtml(c.current_team)}'s Pick</div>
        <div class="text-xs text-slate-500">${roundPickLabel(c)} · pick #${c.draft_slot ?? c.overall}</div>
        ${buildTradeForm(c, isUserPick)}
      </div>
    `;
  }
  const targetSel = document.getElementById('trade-up-target');
  if (targetSel) {
    updateTargetTeamPicks(targetSel.value);
    targetSel.addEventListener('change', e => updateTargetTeamPicks(e.target.value));
  }
  const submitBtn = document.getElementById('submit-trade-up');
  if (submitBtn) submitBtn.addEventListener('click', submitTradeUp);
  wireAcceptOfferButtons();
}

function buildTradeForm(currentPick, isUserPick) {
  const sortPicks = picks => [...picks].sort((a, b) => (a.year_offset || 0) - (b.year_offset || 0) || a.overall - b.overall);
  const nyBadge = '<span class="text-[10px] font-semibold text-amber-400 border border-amber-700 rounded px-1 leading-tight">NY</span>';

  const allPicks = [...state.board, ...(state.futurePicks || [])];
  const myUnpickedPicks = sortPicks(allPicks.filter(p => p.current_team === state.userTeam && !p.selected_player_id));
  const targets = sortPicks(allPicks.filter(p => p.current_team !== state.userTeam && !p.selected_player_id)).slice(0, 200);
  const preselectOverall = (currentPick && !isUserPick) ? currentPick.overall : null;

  const targetOpts = targets.map(p => {
    const sel = preselectOverall === p.overall ? ' selected' : '';
    const valStr = p.value != null ? ` · ${p.value.toLocaleString()} pts` : '';
    const nyStr = p.year_offset ? ' [NY]' : '';
    return `<option value="${p.overall}"${sel}>${roundPickLabel(p)}${nyStr} · ${escapeHtml(p.current_team)} (#${p.draft_slot ?? p.overall}${valStr})</option>`;
  }).join('');

  const myPicksHtml = myUnpickedPicks.length
    ? myUnpickedPicks.map(p => {
        const valStr = p.value != null ? ` <span class="text-slate-500">${p.value.toLocaleString()} pts</span>` : '';
        const badge = p.year_offset ? ' ' + nyBadge : '';
        return `<label class="flex items-center justify-between gap-2 text-sm py-1 cursor-pointer">
          <span class="flex items-center gap-2">
            <input type="checkbox" class="trade-up-offer" value="${p.overall}" data-value="${p.value ?? 0}" onchange="updateTradeTotals()">
            ${roundPickLabel(p)}${badge} <span class="text-slate-500">#${p.draft_slot ?? p.overall}</span>
          </span>
          ${valStr}
        </label>`;
      }).join('')
    : '<div class="text-xs text-slate-500">No picks left to offer.</div>';

  return `
    <div class="space-y-3">
      <div>
        <label class="text-xs uppercase text-slate-400">Target Pick</label>
        <select id="trade-up-target" class="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-sm">
          ${targetOpts || '<option disabled>No targets available</option>'}
        </select>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <div class="text-xs uppercase text-slate-400">${escapeHtml(state.userTeam)} Sends</div>
          <div class="max-h-44 overflow-y-auto pretty-scroll border border-ink-700 rounded p-2 space-y-0.5">
            ${myPicksHtml}
          </div>
          <div class="text-xs text-right text-slate-400 pt-0.5">Total: <span id="trade-my-total" class="text-accent-400 font-mono">0 pts</span></div>
        </div>
        <div class="space-y-1">
          <div id="trade-target-label" class="text-xs uppercase text-slate-400">— Sends</div>
          <div id="trade-target-picks" class="max-h-44 overflow-y-auto pretty-scroll border border-ink-700 rounded p-2 space-y-0.5">
            <div class="text-xs text-slate-500">Select a target pick.</div>
          </div>
          <div class="text-xs text-right text-slate-400 pt-0.5">Total: <span id="trade-their-total" class="text-accent-400 font-mono">0 pts</span></div>
        </div>
      </div>
      <button id="submit-trade-up" class="primary-btn w-full">Submit Offer</button>
      <div id="trade-up-result" class="text-sm text-slate-400"></div>
    </div>
  `;
}

function updateTargetTeamPicks(targetOverall) {
  const overall = parseInt(targetOverall, 10);
  const allPicks = [...state.board, ...(state.futurePicks || [])];
  const targetPick = allPicks.find(p => p.overall === overall);
  if (!targetPick) return;
  const teamName = targetPick.current_team;

  document.getElementById('trade-target-label').textContent = `${teamName} Sends`;

  const nyBadge = '<span class="text-[10px] font-semibold text-amber-400 border border-amber-700 rounded px-1 leading-tight">NY</span>';
  const teamPicks = [...allPicks.filter(p => p.current_team === teamName && !p.selected_player_id)]
    .sort((a, b) => (a.year_offset || 0) - (b.year_offset || 0) || a.overall - b.overall);

  const html = teamPicks.map(p => {
    const isTarget = p.overall === overall;
    const valStr = p.value != null ? ` <span class="text-slate-500">${p.value.toLocaleString()} pts</span>` : '';
    const badge = p.year_offset ? ' ' + nyBadge : '';
    if (isTarget) {
      return `<label class="flex items-center justify-between gap-2 text-sm py-1 text-slate-300">
        <span class="flex items-center gap-2">
          <input type="checkbox" class="trade-their-pick" value="${p.overall}" data-value="${p.value ?? 0}" checked disabled>
          ${roundPickLabel(p)}${badge} <span class="text-slate-500">#${p.draft_slot ?? p.overall}</span>
          <span class="text-xs text-accent-400">(target)</span>
        </span>
        ${valStr}
      </label>`;
    }
    return `<label class="flex items-center justify-between gap-2 text-sm py-1 cursor-pointer">
      <span class="flex items-center gap-2">
        <input type="checkbox" class="trade-their-pick" value="${p.overall}" data-value="${p.value ?? 0}" onchange="updateTradeTotals()">
        ${roundPickLabel(p)}${badge} <span class="text-slate-500">#${p.draft_slot ?? p.overall}</span>
      </span>
      ${valStr}
    </label>`;
  }).join('');

  document.getElementById('trade-target-picks').innerHTML = html || '<div class="text-xs text-slate-500">No picks available.</div>';
  updateTradeTotals();
}

function updateTradeTotals() {
  const myTotal = Array.from(document.querySelectorAll('.trade-up-offer:checked'))
    .reduce((sum, cb) => sum + (parseInt(cb.dataset.value, 10) || 0), 0);
  const theirTotal = Array.from(document.querySelectorAll('.trade-their-pick:checked'))
    .reduce((sum, cb) => sum + (parseInt(cb.dataset.value, 10) || 0), 0);
  const myEl = document.getElementById('trade-my-total');
  const theirEl = document.getElementById('trade-their-total');
  if (myEl) myEl.textContent = myTotal.toLocaleString() + ' pts';
  if (theirEl) theirEl.textContent = theirTotal.toLocaleString() + ' pts';
}

async function submitTradeUp() {
  const target = parseInt(document.getElementById('trade-up-target').value, 10);
  const offered = Array.from(document.querySelectorAll('.trade-up-offer:checked')).map(c => parseInt(c.value, 10));
  const theirExtra = Array.from(document.querySelectorAll('.trade-their-pick:checked:not([disabled])')).map(c => parseInt(c.value, 10));
  const result = document.getElementById('trade-up-result');
  if (!offered.length) { result.textContent = 'Select at least one pick to offer.'; return; }
  const res = await api.post('/api/trade/up', { target_overall: target, offered_overalls: offered, target_also_sends: theirExtra });
  if (!res.ok) { result.textContent = 'Error: ' + res.error; return; }
  if (res.decision.accepted) {
    playTradeSound();
    result.innerHTML = '<span class="text-emerald-400">Offer accepted!</span> Refreshing…';
    await reloadSessionAndRender();
    setTimeout(closeModal, 800);
  } else {
    const reason = res.decision?.reason;
    const msg = reason === 'below_threshold'
      ? "Offer Refused: We're looking to get more value for this pick."
      : reason === 'competing_offer'
        ? "Offer Refused: We have a better offer on the table."
        : 'Offer Refused: ' + (reason || 'no reason given');
    result.textContent = msg;
  }
}

// ---------- Two-Team (manual) trade form ----------

// Persists selections across re-renders within the same Trade Hub session.
// teamA / teamB default lazily to the user team and the on-clock team (or a
// sensible non-user fallback) the first time the form opens.
const manualTradeState = {
  teamA: null,
  teamB: null,
  selectedA: new Set(),
  selectedB: new Set(),
  forceOverride: false,
};

function renderManualTradeForm() {
  const teams = (state.teams || []).slice().sort((a, b) => a.localeCompare(b));
  if (!teams.length) {
    return '<div class="text-sm text-slate-400">No teams loaded.</div>';
  }
  if (!manualTradeState.teamA || !teams.includes(manualTradeState.teamA)) {
    manualTradeState.teamA = state.userTeam || teams[0];
  }
  if (!manualTradeState.teamB || !teams.includes(manualTradeState.teamB)
      || manualTradeState.teamB === manualTradeState.teamA) {
    const onClock = state.session?.current_pick?.current_team;
    manualTradeState.teamB =
      (onClock && onClock !== manualTradeState.teamA) ? onClock
      : teams.find(t => t !== manualTradeState.teamA) || teams[0];
  }
  const optsHtml = (selected) => teams.map(t =>
    `<option value="${escapeHtml(t)}"${t === selected ? ' selected' : ''}>${escapeHtml(t)}</option>`
  ).join('');
  const forceChecked = manualTradeState.forceOverride ? ' checked' : '';
  return `
    <div class="space-y-3">
      <div class="text-xs text-slate-400">
        Build a trade between any two teams — including two non-user teams.
        With <strong class="text-accent-400">Force override</strong> checked, the
        trade executes regardless of willingness or value.
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <label class="text-xs uppercase text-slate-400">Team A</label>
          <select id="mt-team-a" class="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-sm">${optsHtml(manualTradeState.teamA)}</select>
        </div>
        <div class="space-y-1">
          <label class="text-xs uppercase text-slate-400">Team B</label>
          <select id="mt-team-b" class="w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-sm">${optsHtml(manualTradeState.teamB)}</select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1">
          <div id="mt-a-label" class="text-xs uppercase text-slate-400">${escapeHtml(manualTradeState.teamA)} Sends</div>
          <div id="mt-a-picks" class="max-h-52 overflow-y-auto pretty-scroll border border-ink-700 rounded p-2 space-y-0.5"></div>
          <div class="text-xs text-right text-slate-400 pt-0.5">Total: <span id="mt-a-total" class="text-accent-400 font-mono">0 pts</span></div>
        </div>
        <div class="space-y-1">
          <div id="mt-b-label" class="text-xs uppercase text-slate-400">${escapeHtml(manualTradeState.teamB)} Sends</div>
          <div id="mt-b-picks" class="max-h-52 overflow-y-auto pretty-scroll border border-ink-700 rounded p-2 space-y-0.5"></div>
          <div class="text-xs text-right text-slate-400 pt-0.5">Total: <span id="mt-b-total" class="text-accent-400 font-mono">0 pts</span></div>
        </div>
      </div>
      <label class="manual-trade-force">
        <input id="mt-force" type="checkbox"${forceChecked}>
        <span>Force override <span class="text-slate-500">(skip willingness + value checks)</span></span>
      </label>
      <button id="mt-submit" class="primary-btn w-full">Execute Trade</button>
      <div id="mt-result" class="text-sm text-slate-400"></div>
    </div>
  `;
}

function wireManualTradeForm() {
  const teamA = document.getElementById('mt-team-a');
  const teamB = document.getElementById('mt-team-b');
  if (!teamA || !teamB) return;
  renderManualPickColumn('A');
  renderManualPickColumn('B');
  teamA.addEventListener('change', () => {
    manualTradeState.teamA = teamA.value;
    manualTradeState.selectedA.clear();
    // Keep teams distinct: if B == new A, swap B to something else.
    if (teamB.value === teamA.value) {
      const alt = (state.teams || []).find(t => t !== teamA.value);
      if (alt) {
        manualTradeState.teamB = alt;
        teamB.value = alt;
        manualTradeState.selectedB.clear();
        document.getElementById('mt-b-label').textContent = `${alt} Sends`;
        renderManualPickColumn('B');
      }
    }
    document.getElementById('mt-a-label').textContent = `${teamA.value} Sends`;
    renderManualPickColumn('A');
  });
  teamB.addEventListener('change', () => {
    if (teamB.value === teamA.value) {
      const alt = (state.teams || []).find(t => t !== teamA.value);
      teamB.value = alt || teamB.value;
    }
    manualTradeState.teamB = teamB.value;
    manualTradeState.selectedB.clear();
    document.getElementById('mt-b-label').textContent = `${teamB.value} Sends`;
    renderManualPickColumn('B');
  });
  document.getElementById('mt-force').addEventListener('change', e => {
    manualTradeState.forceOverride = e.target.checked;
  });
  document.getElementById('mt-submit').addEventListener('click', submitManualTrade);
}

function renderManualPickColumn(side) {
  const team = side === 'A' ? manualTradeState.teamA : manualTradeState.teamB;
  const selected = side === 'A' ? manualTradeState.selectedA : manualTradeState.selectedB;
  const el = document.getElementById(side === 'A' ? 'mt-a-picks' : 'mt-b-picks');
  if (!el) return;
  const allPicks = [...state.board, ...(state.futurePicks || [])];
  const teamPicks = allPicks
    .filter(p => p.current_team === team && !p.selected_player_id)
    .sort((a, b) => (a.year_offset || 0) - (b.year_offset || 0) || a.overall - b.overall);
  if (!teamPicks.length) {
    el.innerHTML = '<div class="text-xs text-slate-500">No tradable picks.</div>';
    updateManualTradeTotals();
    return;
  }
  const nyBadge = '<span class="text-[10px] font-semibold text-amber-400 border border-amber-700 rounded px-1 leading-tight">NY</span>';
  el.innerHTML = teamPicks.map(p => {
    const checked = selected.has(p.overall) ? ' checked' : '';
    const valStr = p.value != null ? ` <span class="text-slate-500">${p.value.toLocaleString()} pts</span>` : '';
    const badge = p.year_offset ? ' ' + nyBadge : '';
    return `<label class="flex items-center justify-between gap-2 text-sm py-1 cursor-pointer">
      <span class="flex items-center gap-2">
        <input type="checkbox" class="mt-pick mt-pick-${side.toLowerCase()}"
               data-side="${side}" data-value="${p.value ?? 0}" value="${p.overall}"${checked}>
        ${roundPickLabel(p)}${badge} <span class="text-slate-500">#${p.draft_slot ?? p.overall}</span>
      </span>
      ${valStr}
    </label>`;
  }).join('');
  el.querySelectorAll('.mt-pick').forEach(cb => {
    cb.addEventListener('change', () => {
      const overall = parseInt(cb.value, 10);
      const set = cb.dataset.side === 'A' ? manualTradeState.selectedA : manualTradeState.selectedB;
      if (cb.checked) set.add(overall);
      else set.delete(overall);
      updateManualTradeTotals();
    });
  });
  updateManualTradeTotals();
}

function updateManualTradeTotals() {
  const sumChecked = sel => Array.from(document.querySelectorAll(sel))
    .reduce((s, cb) => s + (parseInt(cb.dataset.value, 10) || 0), 0);
  const a = document.getElementById('mt-a-total');
  const b = document.getElementById('mt-b-total');
  if (a) a.textContent = sumChecked('.mt-pick-a:checked').toLocaleString() + ' pts';
  if (b) b.textContent = sumChecked('.mt-pick-b:checked').toLocaleString() + ' pts';
}

async function submitManualTrade() {
  const result = document.getElementById('mt-result');
  const aOveralls = Array.from(manualTradeState.selectedA);
  const bOveralls = Array.from(manualTradeState.selectedB);
  if (!aOveralls.length || !bOveralls.length) {
    result.textContent = 'Pick at least one pick on each side.';
    return;
  }
  if (manualTradeState.teamA === manualTradeState.teamB) {
    result.textContent = 'Pick two different teams.';
    return;
  }
  const res = await api.post('/api/trade/manual', {
    team_a: manualTradeState.teamA,
    team_b: manualTradeState.teamB,
    team_a_overalls: aOveralls,
    team_b_overalls: bOveralls,
    force_override: manualTradeState.forceOverride,
  });
  if (!res.ok) {
    const msg = res.error === 'pick_already_made'
      ? `Pick #${res.overall} has already been used.`
      : res.error === 'team_a_does_not_own'
        ? `${manualTradeState.teamA} no longer owns pick #${res.overall}.`
        : res.error === 'team_b_does_not_own'
          ? `${manualTradeState.teamB} no longer owns pick #${res.overall}.`
          : res.error === 'both_sides_must_send' ? 'Both sides must send at least one pick.'
          : res.error === 'same_team' ? 'Pick two different teams.'
          : 'Error: ' + (res.error || 'unknown');
    result.textContent = msg;
    return;
  }
  if (!res.decision?.accepted) {
    result.textContent = 'Trade refused: ' + (res.decision?.reason || 'unknown')
      + ' — tick Force override to ignore the check.';
    return;
  }
  playTradeSound();
  const tag = res.decision.reason === 'forced'
    ? '<span class="text-amber-400">Forced.</span>'
    : '<span class="text-emerald-400">Accepted.</span>';
  result.innerHTML = `${tag} Refreshing…`;
  manualTradeState.selectedA.clear();
  manualTradeState.selectedB.clear();
  await reloadSessionAndRender();
  // Stay on the manual tab so the user can run more trades.
  if (document.getElementById('trade-hub-body')) {
    renderTradeHubTab();
  }
}

// ---------- Trade History modal ----------

async function openTradeHistory() {
  document.getElementById('modal-root').classList.add('trade-history-modal');
  openModal('Trade History', 'Every trade executed in this draft, in order', '<div class="text-sm text-slate-400">Loading…</div>');
  const res = await api.get('/api/trades').catch(() => ({ trades: [] }));
  const trades = res.trades || [];
  if (!trades.length) {
    document.getElementById('modal-body').innerHTML = '<div class="text-sm text-slate-400 py-6 text-center">No trades have happened yet.</div>';
    return;
  }
  document.getElementById('modal-body').innerHTML = `
    <div class="trade-history-list pretty-scroll">
      ${trades.map(renderTradeHistoryCard).join('')}
    </div>
  `;
}

function renderTradeHistoryCard(t) {
  const fmtPick = p => {
    const nyBadge = p.year_offset
      ? ' <span class="text-[10px] font-semibold text-amber-400 border border-amber-700 rounded px-1 leading-tight">NY</span>'
      : '';
    const slot = p.draft_slot ?? p.overall;
    const valStr = p.value != null
      ? `<span class="font-mono text-accent-400">${p.value.toLocaleString()}</span> pts`
      : '<span class="text-slate-600">—</span>';
    const playerLine = p.selected_player_name
      ? `<div class="th-pick-player">→ ${escapeHtml(p.selected_player_name)}${p.selected_position ? ` <span class="text-slate-500">· ${escapeHtml(p.selected_position)}</span>` : ''}</div>`
      : '';
    return `<div class="th-pick-row">
      <span class="th-pick-label">${roundPickLabel(p)}${nyBadge} <span class="text-slate-500 text-xs">#${slot}</span></span>
      <span class="th-pick-val">${valStr}</span>
      ${playerLine}
    </div>`;
  };
  // Show each team's "haul" — what they RECEIVED — rather than what they
  // sent. team_a's column → team_b_sends (everything A received); same
  // pattern flipped for team_b.
  const aReceived = t.team_b_sends || [];
  const bReceived = t.team_a_sends || [];
  const totalA = aReceived.reduce((s, p) => s + (p.value || 0), 0);
  const totalB = bReceived.reduce((s, p) => s + (p.value || 0), 0);
  const teamPanel = (name, logo, received, total, fromLabel) => {
    const logoEl = logo
      ? `<img src="${logo}" class="w-9 h-9 object-contain flex-shrink-0">`
      : `<div class="w-9 h-9 rounded-full bg-ink-700 flex-shrink-0"></div>`;
    return `
      <div class="th-team-col">
        <div class="th-team-head">
          ${logoEl}
          <div>
            <div class="th-team-name">${escapeHtml(name)}</div>
            <div class="th-team-sub">receives from ${escapeHtml(fromLabel)}</div>
          </div>
        </div>
        <div class="th-picks">${received.map(fmtPick).join('') || '<div class="text-xs text-slate-500">—</div>'}</div>
        <div class="th-total">Total: <span class="font-mono text-accent-400">${total.toLocaleString()} pts</span></div>
      </div>`;
  };
  const tag = t.initiated_by === 'USER'
    ? '<span class="th-tag th-tag-user">User-initiated</span>'
    : '<span class="th-tag th-tag-ai">AI-initiated</span>';
  return `
    <div class="th-card">
      <div class="th-card-header">
        <div class="th-card-id">Trade #${t.trade_id}</div>
        ${tag}
      </div>
      <div class="th-card-body">
        ${teamPanel(t.team_b, t.team_b_logo, bReceived, totalB, t.team_a)}
        <div class="th-arrow">⇄</div>
        ${teamPanel(t.team_a, t.team_a_logo, aReceived, totalA, t.team_b)}
      </div>
    </div>
  `;
}

// ---------- Rosters modal ----------

const rostersState = { team: null, data: null, needs: [], board: [] };

async function openRosters() {
  document.getElementById('modal-root').classList.add('rosters-modal');
  openModal('Rosters/Draft Picks', 'Each team’s current roster and live draft-pick ownership', '<div class="text-sm text-slate-400">Loading rosters…</div>');
  let res;
  let boardRes;
  try {
    [res, boardRes] = await Promise.all([
      api.get('/api/rosters'),
      api.get('/api/board'),
    ]);
  } catch (e) {
    document.getElementById('modal-body').innerHTML = '<div class="text-sm text-rose-400">Failed to load rosters.</div>';
    return;
  }
  // Stored in alphabetical order by the backend; preserve that for the
  // logo grid below.
  rostersState.data = res.teams || [];
  rostersState.board = boardRes.picks || state.board || [];
  state.board = rostersState.board;
  state.futurePicks = boardRes.future_picks || state.futurePicks || [];
  const names = rostersState.data.map(t => t.team);
  if (!rostersState.team || !names.includes(rostersState.team)) {
    rostersState.team = names.includes(state.userTeam) ? state.userTeam : names[0];
  }
  document.getElementById('modal-body').innerHTML = `
    <div class="rosters-modal-inner">
      <div class="rosters-team-grid pretty-scroll" id="rosters-team-grid">
        ${rostersState.data.map(t => {
          const sel = t.team === rostersState.team ? ' selected' : '';
          const img = t.logo
            ? `<img src="${t.logo}" alt="${escapeHtml(t.team)}">`
            : `<div class="rosters-team-tile-fallback">${escapeHtml(t.team[0] || '?')}</div>`;
          return `<button type="button" class="rosters-team-tile${sel}" data-roster-team="${escapeHtml(t.team)}">${img}<span class="rosters-team-tile-name">${escapeHtml(t.team)}</span></button>`;
        }).join('')}
      </div>
      <div id="rosters-body" class="rosters-body pretty-scroll"></div>
    </div>
  `;
  document.querySelectorAll('[data-roster-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      rostersState.team = btn.dataset.rosterTeam;
      document.querySelectorAll('[data-roster-team]').forEach(b =>
        b.classList.toggle('selected', b.dataset.rosterTeam === rostersState.team));
      renderRostersBody();
    });
  });
  await renderRostersBody();
}

// Position groups for the Rosters layout. Order chosen to read like a
// standard depth chart: offense top-down, then defense, then special teams.
const ROSTER_POSITION_GROUPS = [
  { label: 'Offense', positions: ['QB', 'HB', 'FB', 'WR', 'TE'] },
  { label: 'Offensive Line', positions: ['LT', 'LG', 'C', 'RG', 'RT'] },
  { label: 'Defensive Line', positions: ['LE', 'DT', 'RE'] },
  { label: 'Linebackers', positions: ['LOLB', 'MLB', 'ROLB'] },
  { label: 'Defensive Backs', positions: ['CB', 'FS', 'SS'] },
  { label: 'Special Teams', positions: ['K', 'P'] },
];

async function renderRostersBody() {
  const body = document.getElementById('rosters-body');
  if (!body) return;
  const team = (rostersState.data || []).find(t => t.team === rostersState.team);
  if (!team) {
    body.innerHTML = '<div class="text-sm text-slate-400">Pick a team.</div>';
    return;
  }
  // Fetch needs for the selected team — same endpoint + same on-clock-
  // round filtering the left-rail Team Needs card uses, so the output
  // matches what the user sees when the team is actually picking.
  body.innerHTML = '<div class="text-sm text-slate-500">Loading needs…</div>';
  try {
    const res = await api.get('/api/needs/' + encodeURIComponent(team.team));
    rostersState.needs = res.needs || [];
  } catch (e) {
    rostersState.needs = [];
  }
  const byPos = team.by_position || {};
  // Render each group as a row of position columns. Empty positions still
  // show as placeholder so missing depth is visible.
  const groupHtml = ROSTER_POSITION_GROUPS.map(g => {
    const cols = g.positions.map(pos => {
      const players = byPos[pos] || [];
      const rows = players.length
        ? players.map(renderRosterPlayer).join('')
        : '<div class="roster-empty">—</div>';
      return `<div class="roster-pos-col">
        <div class="roster-pos-label">${escapeHtml(pos)} <span class="text-slate-600 font-normal">(${players.length})</span></div>
        <div class="roster-pos-players">${rows}</div>
      </div>`;
    }).join('');
    return `<div class="roster-group">
      <div class="roster-group-label">${escapeHtml(g.label)}</div>
      <div class="roster-group-grid" style="--roster-cols:${g.positions.length}">${cols}</div>
    </div>`;
  }).join('');
  // Also surface any positions on the roster that aren't in our predefined
  // groups (rare, but possible for unmapped Madden codes) so nothing hides.
  const known = new Set(ROSTER_POSITION_GROUPS.flatMap(g => g.positions));
  const extras = Object.keys(byPos).filter(p => !known.has(p)).sort();
  const extraHtml = extras.length ? `
    <div class="roster-group">
      <div class="roster-group-label">Other</div>
      <div class="roster-group-grid" style="--roster-cols:${extras.length}">
        ${extras.map(pos => {
          const players = byPos[pos] || [];
          return `<div class="roster-pos-col">
            <div class="roster-pos-label">${escapeHtml(pos)} <span class="text-slate-600 font-normal">(${players.length})</span></div>
            <div class="roster-pos-players">${players.map(renderRosterPlayer).join('')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';
  // Use the left-rail's already-shuffled order for the on-clock team so
  // both panels always agree. For other teams, shuffle once and cache it
  // so clicking in/out doesn't re-randomize.
  let needs;
  if (state.needsDisplayed?.team === team.team && state.needsDisplayed.needs) {
    needs = state.needsDisplayed.needs;
  } else if (rostersState.needsDisplayed?.team === team.team) {
    needs = rostersState.needsDisplayed.needs;
  } else {
    needs = rostersState.needs.slice(0, 8);
    for (let i = needs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [needs[i], needs[j]] = [needs[j], needs[i]];
    }
    rostersState.needsDisplayed = { team: team.team, needs };
  }
  const needsHtml = needs.length
    ? needs.map(n => `
        <div class="need-row">
          <span class="pos">${escapeHtml(n.label)}</span>
        </div>`).join('')
    : '<div class="text-xs text-slate-500">No needs computed.</div>';
  const draftPicks = getRosterCurrentDraftPicks(team.team);
  const remainingPickCount = draftPicks.filter(p => !p.selected_player_id).length;
  const picksSummary = draftPicks.length
    ? `${remainingPickCount} left · ${draftPicks.length} total`
    : 'No current picks';
  const picksHtml = draftPicks.length
    ? draftPicks.map(renderRosterDraftPick).join('')
    : '<div class="rosters-picks-empty">No current-year picks owned.</div>';
  const teamLogo = team.logo
    ? `<img src="${team.logo}" alt="${escapeHtml(team.team)}" class="rosters-needs-logo">`
    : '';
  const needsPanel = `
    <div class="rosters-needs-card">
      <div class="rosters-needs-head">
        ${teamLogo}
        <div>
          <div class="card-eyebrow">Team Needs</div>
          <div class="rosters-needs-team">${escapeHtml(team.team)}</div>
        </div>
      </div>
      <div class="rosters-needs-list">${needsHtml}</div>
      <div class="rosters-picks-head">
        <div class="card-eyebrow">Current Draft Picks</div>
        <div class="rosters-picks-summary">${escapeHtml(picksSummary)}</div>
      </div>
      <div class="rosters-picks-list">${picksHtml}</div>
    </div>`;

  body.innerHTML = `
    <div class="rosters-content">
      ${needsPanel}
      <div class="rosters-roster">${groupHtml}${extraHtml}</div>
    </div>
  `;
  body.querySelectorAll('[data-roster-pid]').forEach(row => {
    row.addEventListener('click', () =>
      openPlayerProfile(row.dataset.rosterPid, { returnTo: openRosters }));
  });
}

function getRosterCurrentDraftPicks(teamName) {
  return (rostersState.board || state.board || [])
    .filter(p => p && !p.year_offset && p.current_team === teamName)
    .slice()
    .sort((a, b) => (a.overall || 9999) - (b.overall || 9999));
}

function renderRosterDraftPick(p) {
  const slot = p.draft_slot ?? p.overall;
  const via = p.original_team && p.original_team !== p.current_team
    ? `<span class="rosters-pick-via">via ${escapeHtml(p.original_team)}</span>`
    : '';
  const selected = p.selected_player_name
    ? `<div class="rosters-pick-player">${escapeHtml(p.selected_player_name)}</div>`
    : '<div class="rosters-pick-player is-open">Available</div>';
  // Rows for picks that have already been made are clickable — they
  // open the drafted player's profile via the same `data-roster-pid`
  // binding the position-grouped roster rows use.
  const isMade = !!p.selected_player_id;
  const clsParts = ['rosters-pick-row'];
  if (isMade) clsParts.push('is-made', 'clickable');
  const attrs = isMade
    ? ` data-roster-pid="${escapeHtml(p.selected_player_id)}" role="button" tabindex="0" title="View ${escapeHtml(p.selected_player_name)}"`
    : '';
  return `<div class="${clsParts.join(' ')}"${attrs}>
    <div class="rosters-pick-main">
      <span class="rosters-pick-round">${roundPickLabel(p)}</span>
      <span class="rosters-pick-slot">#${slot}</span>
      ${via}
    </div>
    ${selected}
  </div>`;
}

function renderRosterPlayer(pl) {
  const ovr = pl.is_rookie ? `<span class="roster-ovr text-slate-500">?</span>` : (pl.ovr != null ? `<span class="roster-ovr">${pl.ovr}</span>` : '');
  const college = pl.college_logo
    ? `<img src="${pl.college_logo}" alt="${escapeHtml(pl.college || '')}" class="roster-college-logo">`
    : '<div class="roster-college-placeholder"></div>';
  const rookiePickLabel = pl.is_rookie && pl.rookie_pick
    ? roundPickLabel({ round: pl.rookie_pick.round, overall: pl.rookie_pick.overall })
    : '';
  const rookieBadge = pl.is_rookie && pl.rookie_pick
    ? `<div class="roster-rookie-badge" title="Drafted ${rookiePickLabel}">${rookiePickLabel}</div>`
    : '';
  const clickable = pl.player_id ? ` data-roster-pid="${escapeHtml(pl.player_id)}"` : '';
  const cls = 'roster-player' + (pl.is_rookie ? ' is-rookie' : '') + (pl.player_id ? ' clickable' : '');
  return `<div class="${cls}"${clickable}>
    ${ovr}
    ${college}
    <div class="roster-player-info">
      <div class="roster-player-name">${escapeHtml(pl.first_name || '')} ${escapeHtml(pl.last_name || '')}</div>
      <div class="roster-player-sub">${pl.age != null ? 'Age ' + pl.age : ''}${pl.college ? (pl.age != null ? ' · ' : '') + escapeHtml(pl.college) : ''}</div>
    </div>
    ${rookieBadge}
  </div>`;
}

// ---------- GM Info modal ----------

const GM_TRAITS = [
  { key: 'NeedvsBPA',                     label: 'Need v BPA',  low: 'BPA Philosophy',    high: 'Reaches for Need' },
  { key: 'BigBoardSkill',                 label: 'Scout',       low: 'Tendency to Reach', high: 'Sharp Evaluator'  },
  { key: 'TradeUp',                       label: 'Trade Up',    low: 'Low',               high: 'High'             },
  { key: 'TradeDown',                     label: 'Trade Down',  low: 'Low',               high: 'High'             },
  { key: 'Non-Premium Positions 1st Rnd', label: 'Non-Prem R1', low: 'Tends to Avoid',   high: 'Values Normally'  },
  { key: 'AvoidPoorCharacter',            label: 'Character',   low: 'No Impact',         high: 'Off-Board'        },
];

async function openGMInfo() {
  document.getElementById('modal-root').classList.add('gm-info-modal');
  openModal('GM Info', 'Draft tendencies for all 32 front offices', '<div class="text-sm text-slate-400">Loading…</div>');
  let res;
  try {
    res = await api.get('/api/gm-info');
  } catch (e) {
    document.getElementById('modal-body').innerHTML = '<div class="text-sm text-rose-400">Failed to load GM info.</div>';
    return;
  }
  const gms = (res.gms || []).slice().sort((a, b) => (a.TeamName || '').localeCompare(b.TeamName || ''));
  const headerCols = GM_TRAITS.map(t => `
    <th class="gm-th">
      <div>${escapeHtml(t.label)}</div>
      <div class="gm-th-sub">1 = ${escapeHtml(t.low)}</div>
      <div class="gm-th-sub">5 = ${escapeHtml(t.high)}</div>
    </th>`
  ).join('');
  const rows = gms.map(gm => {
    const logo = gm.logo
      ? `<img src="${escapeHtml(gm.logo)}" class="w-7 h-7 object-contain flex-shrink-0" alt="">`
      : `<div class="w-7 h-7 rounded bg-ink-700 flex-shrink-0"></div>`;
    const traitCols = GM_TRAITS.map(t => {
      const val = Math.max(1, Math.min(5, parseInt(gm[t.key]) || 3));
      const pips = Array.from({length: 5}, (_, i) =>
        `<span class="gm-pip${i < val ? ' filled' : ''}"></span>`
      ).join('');
      return `<td class="gm-td"><div class="gm-pips">${pips}</div></td>`;
    }).join('');
    return `<tr class="gm-row">
      <td class="gm-team-cell">${logo}<span class="gm-team-name">${escapeHtml(gm.TeamName || '')}</span></td>
      ${traitCols}
    </tr>`;
  }).join('');
  document.getElementById('modal-body').innerHTML = `
    <div class="gm-table-wrap pretty-scroll">
      <table class="gm-table">
        <thead><tr><th class="gm-th gm-th-team">Team</th>${headerCols}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function openSimReport() {
  document.getElementById('modal-root').classList.add('sim-report-modal');
  openModal('Sim Report', 'BPA vs need pick breakdown by round (CPU picks only)', '<div class="text-sm text-slate-400">Loading…</div>');
  let res;
  try {
    res = await api.get('/api/sim-report');
  } catch (e) {
    document.getElementById('modal-body').innerHTML = '<div class="text-sm text-rose-400">Failed to load sim report.</div>';
    return;
  }
  const rounds = res.rounds || [];
  if (!rounds.length) {
    document.getElementById('modal-body').innerHTML = '<div class="text-sm text-slate-400">No picks made yet.</div>';
    return;
  }

  const totalCpu = rounds.reduce((s, r) => s + r.bpa + r.need + r.other, 0);
  const totalBpa = rounds.reduce((s, r) => s + r.bpa, 0);
  const totalNeed = rounds.reduce((s, r) => s + r.need, 0);
  const totalUser = rounds.reduce((s, r) => s + r.user, 0);
  const totalAll = rounds.reduce((s, r) => s + r.total, 0);

  const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '—';
  const bar = (p, cls) => {
    const w = Math.round(Math.min(100, parseFloat(p) || 0));
    return `<div class="sim-report-bar-bg"><div class="sim-report-bar ${cls}" style="width:${w}%"></div></div>`;
  };

  const rows = rounds.map(r => {
    const cpu = r.bpa + r.need + r.other;
    const bpaPct = pct(r.bpa, cpu);
    const needPct = pct(r.need, cpu);
    return `<tr class="sim-report-row">
      <td class="sim-report-td font-semibold text-slate-300">R${r.round}</td>
      <td class="sim-report-td text-slate-500 text-xs">${r.total} picks / ${cpu} CPU</td>
      <td class="sim-report-td">
        <div class="flex items-center gap-2">
          <span class="sim-report-pct text-sky-400">${bpaPct}</span>
          ${bar(bpaPct, 'bpa')}
          <span class="sim-report-count text-slate-500">${r.bpa}</span>
        </div>
      </td>
      <td class="sim-report-td">
        <div class="flex items-center gap-2">
          <span class="sim-report-pct text-accent-400">${needPct}</span>
          ${bar(needPct, 'need')}
          <span class="sim-report-count text-slate-500">${r.need}</span>
        </div>
      </td>
      <td class="sim-report-td text-slate-500 text-xs">${r.user} user</td>
    </tr>`;
  }).join('');

  const totBpaPct = pct(totalBpa, totalCpu);
  const totNeedPct = pct(totalNeed, totalCpu);
  const totalsRow = `<tr class="sim-report-totals">
    <td class="sim-report-td font-semibold text-slate-200">All</td>
    <td class="sim-report-td text-slate-400 text-xs">${totalAll} picks / ${totalCpu} CPU</td>
    <td class="sim-report-td">
      <div class="flex items-center gap-2">
        <span class="sim-report-pct text-sky-400 font-semibold">${totBpaPct}</span>
        ${bar(totBpaPct, 'bpa')}
        <span class="sim-report-count text-slate-500">${totalBpa}</span>
      </div>
    </td>
    <td class="sim-report-td">
      <div class="flex items-center gap-2">
        <span class="sim-report-pct text-accent-400 font-semibold">${totNeedPct}</span>
        ${bar(totNeedPct, 'need')}
        <span class="sim-report-count text-slate-500">${totalNeed}</span>
      </div>
    </td>
    <td class="sim-report-td text-slate-500 text-xs">${totalUser} user</td>
  </tr>`;

  const traitRows = (res.traits || []).map(t => {
    const bpaPct = t.bpa_pct + '%';
    const needPct = t.need_pct + '%';
    return `<tr class="sim-report-row">
      <td class="sim-report-td font-semibold text-slate-300">${t.trait}</td>
      <td class="sim-report-td text-slate-500 text-xs">${t.total} CPU</td>
      <td class="sim-report-td">
        <div class="flex items-center gap-2">
          <span class="sim-report-pct text-sky-400">${bpaPct}</span>
          ${bar(bpaPct, 'bpa')}
          <span class="sim-report-count text-slate-500">${t.bpa}</span>
        </div>
      </td>
      <td class="sim-report-td">
        <div class="flex items-center gap-2">
          <span class="sim-report-pct text-accent-400">${needPct}</span>
          ${bar(needPct, 'need')}
          <span class="sim-report-count text-slate-500">${t.need}</span>
        </div>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('modal-body').innerHTML = `
    <div class="pretty-scroll overflow-x-auto space-y-6">
      <table class="w-full text-sm">
        <thead>
          <tr class="sim-report-header">
            <th class="sim-report-th">Round</th>
            <th class="sim-report-th">Picks</th>
            <th class="sim-report-th">BPA</th>
            <th class="sim-report-th">Need</th>
            <th class="sim-report-th">User</th>
          </tr>
        </thead>
        <tbody>${rows}${totalsRow}</tbody>
      </table>
      <div>
        <div class="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 px-2">Need vs BPA Trait (all rounds, CPU picks)</div>
        <table class="w-full text-sm">
          <thead>
            <tr class="sim-report-header">
              <th class="sim-report-th">Trait</th>
              <th class="sim-report-th">Picks</th>
              <th class="sim-report-th">BPA</th>
              <th class="sim-report-th">Need</th>
            </tr>
          </thead>
          <tbody>${traitRows}</tbody>
        </table>
        <div class="text-[11px] text-slate-600 mt-1 px-2">1 = extreme BPA · 5 = extreme need</div>
      </div>
    </div>
  `;
}

function renderOffersTable(offers) {
  const fmtPick = p => `${roundPickLabel(p)}${p.year_offset ? ' <span class="text-[9px] text-amber-400">NY</span>' : ''}`;
  const fmtList = picks => picks && picks.length
    ? picks.map(fmtPick).join(', ')
    : '<span class="text-slate-600">—</span>';
  return `
    <table class="w-full text-sm">
      <thead class="text-xs uppercase text-slate-400 border-b border-ink-700">
        <tr>
          <th class="text-left py-1">Team</th>
          <th class="text-left py-1">You Receive</th>
          <th class="text-left py-1">You Send</th>
          <th class="text-right py-1">Net Value</th>
          <th class="text-right py-1">Net Ratio</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${offers.map(o => {
          const youSend = [o.target_pick, ...(o.return_picks || [])].filter(Boolean);
          const net = ((o.offer_value || 0) - (o.target_value || 0) - (o.return_value || 0));
          const netStr = (net >= 0 ? '+' : '') + net.toFixed(0);
          const netClass = net >= 0 ? 'text-accent-400' : 'text-rose-400';
          const denominator = (o.target_value || 0) + (o.return_value || 0);
          const ratio = denominator > 0 ? (o.offer_value || 0) / denominator : null;
          const ratioStr = ratio != null ? ratio.toFixed(2) + 'x' : '—';
          const ratioClass = ratio == null ? 'text-slate-500' : ratio >= 1 ? 'text-accent-400' : 'text-rose-400';
          return `<tr class="border-b border-ink-800">
            <td class="py-1 pr-2">${escapeHtml(o.from_team || '?')}</td>
            <td class="py-1 pr-2 text-xs">${fmtList(o.offered_picks)}</td>
            <td class="py-1 pr-2 text-xs text-slate-400">${fmtList(youSend)}</td>
            <td class="py-1 pr-2 text-right font-mono text-xs ${netClass}">${netStr}</td>
            <td class="py-1 pr-2 text-right font-mono text-xs ${ratioClass}">${ratioStr}</td>
            <td class="py-1 text-right"><button class="action-btn accept-offer-btn" data-from-team="${escapeHtml(o.from_team || '')}">Accept</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function acceptTradeDownOffer(fromTeam) {
  const res = await api.post('/api/trade/accept-offer', { from_team: fromTeam });
  if (!res.ok) {
    toast('Trade failed: ' + (res.error || 'unknown error'));
    return;
  }
  playTradeSound();
  closeModal();
  await reloadSessionAndRender();
  if (res.trade) {
    showTradeModal(res.trade, res.trade.target_pick);
  }
}

function wireAcceptOfferButtons() {
  document.querySelectorAll('.accept-offer-btn').forEach(btn => {
    btn.addEventListener('click', () => acceptTradeDownOffer(btn.dataset.fromTeam));
  });
}

// ---------- Big Board modal ----------

const POSITION_ORDER = ['QB','RB','FB','WR','TE','OG','OT','C','END','DT','LB','CB','SS','FS','K','P'];

// Madden stores sub-positions (LE/RE, LG/RG, LT/RT, LOLB/ROLB, MLB, HB) but
// we display the conventional grouping (END, OG, OT, LB, RB). This
// map says "what raw positions count as this display position?"
const POSITION_ALIASES = {
  QB: ['QB'],
  RB: ['HB'],
  FB: ['FB'],
  WR: ['WR'],
  TE: ['TE'],
  OG: ['LG', 'RG'],
  OT: ['LT', 'RT'],
  C: ['C'],
  END: ['LE', 'RE'],
  DT: ['DT'],
  LB: ['LOLB', 'ROLB', 'MLB', 'ILB'],
  CB: ['CB'],
  SS: ['SS'],
  FS: ['FS'],
  K: ['K'],
  P: ['P'],
};
// Inverse: raw position string -> display group label (e.g. "LE" -> "END").
const RAW_TO_DISPLAY = Object.fromEntries(
  Object.entries(POSITION_ALIASES).flatMap(([display, raws]) => raws.map(r => [r, display]))
);

function displayPosition(raw) {
  return RAW_TO_DISPLAY[raw] || raw || '—';
}

// Per-position display priority for attributes in the player card.
// The position_group on the grade record matches the per-position sheet
// name in Draft_LetterGrades.xlsx (QB, RB, WR, TE, OL, DL, LB, CB, SAF, ST).
// Listed attrs come first in the order given; unlisted attrs follow in the
// order they appear in the data.
const ATTR_PRIORITY = {
  QB:  ['THP','SAC','MAC','DAC','TUP','TOR','PAC','BSK','AWR'],
  RB:  ['CAR','BTK','TRK','SFA','JKM','SPM','BCV','AWR','SRR','CTH','CIT'],
  WR:  ['CTH','SRR','MRR','DRR','RLS','CIT','SPC','AWR','BCV','BTK'],
  TE:  ['CTH','SRR','MRR','DRR','CIT','SPC','PBK','RBK','IBL','AWR'],
  OL:  ['PBK','PBP','PBF','RBK','RBP','RBF','IBL','LBK','AWR'],
  DL:  ['PMV','FMV','BSH','TAK','HIT','PUR','PRC','AWR'],
  LB:  ['TAK','HIT','PUR','MCV','ZCV','PRC','PMV','FMV','BSH','AWR'],
  CB:  ['MCV','ZCV','PRS','PRC','TAK','AWR'],
  SAF: ['MCV','ZCV','PRC','TAK','HIT','PUR','BSH','AWR'],
  ST:  ['KPW','KAC','AWR'],
};

// Map a Madden display position (QB, RB, END, ...) to the sheet group used
// in Draft_LetterGrades.xlsx (so we know which priority list to apply, and
// which set of attributes to surface as sort options in the Big Board).
const DISPLAY_TO_GROUP = {
  QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE',
  OG: 'OL', OT: 'OL', C: 'OL',
  END: 'DL', DT: 'DL',
  LB: 'LB',
  CB: 'CB', SS: 'SAF', FS: 'SAF',
  K: 'ST', P: 'ST',
};

// Grade comparator: return numeric rank where higher = better.
// Handles letter grades (A+ > A > A- > B+ > B > ... > F) and star
// tiers ("7-Elite", "6-Great", ..., "1-Poor"). Returns -Infinity for
// unknown/missing so sort-descending puts those last.
function gradeRank(value) {
  if (value == null || value === '') return -Infinity;
  const s = String(value).trim();
  const star = s.match(/^([1-7])-/);
  if (star) return parseInt(star[1], 10);  // 1..7
  // Letter grade with optional +/-: A+=4.3, A=4, A-=3.7, B+=3.3, B=3, ... F=0
  const m = s.match(/^([A-F])([+-]?)/i);
  if (!m) return -Infinity;
  const base = { A: 4, B: 3, C: 2, D: 1, F: 0 }[m[1].toUpperCase()];
  if (base == null) return -Infinity;
  const mod = m[2] === '+' ? 0.3 : (m[2] === '-' ? -0.3 : 0);
  return base + mod;
}

// Look at the first non-null value seen in publicBoard for an attribute
// to decide whether the filter popover should offer letter buckets
// (A+/A/A-/B+...) or star buckets (1-7). Cached per render.
let _attrKindCache = null;
function invalidateAttrKindCache() { _attrKindCache = null; }
function attrKind(attrKey) {
  if (!_attrKindCache) _attrKindCache = {};
  if (attrKey in _attrKindCache) return _attrKindCache[attrKey];
  let kind = 'letter';
  for (const p of state.publicBoard) {
    const v = p.attributes?.[attrKey];
    if (v == null || v === '') continue;
    kind = /^[1-7]-/.test(String(v)) ? 'star' : 'letter';
    break;
  }
  _attrKindCache[attrKey] = kind;
  return kind;
}

// Discrete value buckets offered in the filter popover, paired with the
// numeric rank used for comparison (matches gradeRank()).
const LETTER_BUCKETS = [
  ['A', 4], ['B', 3], ['C', 2], ['D', 1], ['F', 0],
];
const STAR_BUCKETS = [
  ['7-Elite', 7], ['6-Great', 6], ['5-Good', 5],
  ['4-Solid', 4], ['3-Decent', 3], ['2-Marginal', 2], ['1-Poor', 1],
];

// "6'5"" -> 77 (inches). Returns -Infinity for missing/unparseable.
function parseHeight(h) {
  if (!h) return -Infinity;
  const m = String(h).match(/(\d+)'\s*(\d+)/);
  if (!m) return -Infinity;
  return parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
}

const bigBoardState = {
  position: 'ALL',          // 'ALL' | one of POSITION_ORDER
  sortBy: 'consensus',      // 'consensus' | 'team' | 'name' | 'height' | 'weight' | 'attr:<KEY>'
  showDrafted: false,
  userTeamBoard: [],        // cached big board for the user's team
  // Active min-value filters. Keys: 'attr:<KEY>', 'height', 'weight'.
  // Value shape: { min: <numeric rank>, label: <display label> }.
  // Numeric rank is comparable across grades via gradeRank() for attr
  // filters, raw inches for height, raw pounds for weight.
  filters: {},
};

// Columns shown in the ALL view: universal physical attributes graded
// on essentially every position. Star is shown when available.
const ALL_VIEW_ATTRS = ['SPD','ACC','AGI','STR','AWR','COD','JMP','INJ','STA'];

// Attribute columns for the current view. ALL returns ALL_VIEW_ATTRS;
// a specific position returns ATTR_PRIORITY[group] plus any extra attrs
// that actually appear on players of that position (so nothing is hidden).
function currentAttrColumns() {
  if (bigBoardState.position === 'ALL') return ALL_VIEW_ATTRS;
  const group = DISPLAY_TO_GROUP[bigBoardState.position];
  const priority = ATTR_PRIORITY[group] || [];
  const allowedRaws = new Set(POSITION_ALIASES[bigBoardState.position] || [bigBoardState.position]);
  const seen = new Set(priority);
  const extras = [];
  for (const p of state.publicBoard) {
    if (!allowedRaws.has(p.position)) continue;
    for (const k of Object.keys(p.attributes || {})) {
      if (!seen.has(k)) { seen.add(k); extras.push(k); }
    }
  }
  return [...priority, ...extras];
}

async function openBigBoardModal() {
  // Fetch the user's personal team board so we can sort by it. We
  // refresh on every open so rankings reflect current undrafted state.
  try {
    const res = await api.get('/api/big-board/team/' + encodeURIComponent(state.userTeam));
    bigBoardState.userTeamBoard = res.players || [];
  } catch (e) {
    bigBoardState.userTeamBoard = [];
  }
  const c = state.session?.current_pick;
  const onClock = c?.current_team;
  const headerLogo = c?.current_team_logo
    ? `<img src="${c.current_team_logo}" alt="${escapeHtml(onClock)}" class="h-10 w-10 object-contain">`
    : '';
  const subtitle = c
    ? `Drafting for ${onClock} · ${roundPickLabel(c)} (overall ${c.overall})`
    : 'Draft is complete — viewing only';
  const positionList = ['ALL', ...POSITION_ORDER].map(pos => {
    const label = pos === 'ALL' ? 'All' : pos;
    const active = bigBoardState.position === pos ? ' active' : '';
    return `<button class="bb-pos-pill${active}" data-bb-pos="${escapeHtml(pos)}">${escapeHtml(label)}</button>`;
  }).join('');
  const draftedChecked = bigBoardState.showDrafted ? ' checked' : '';
  const body = `
    <div class="big-board-modal">
      <div class="bbm-header">
        ${headerLogo}
        <div class="flex-1 min-w-0">
          <div class="text-xs uppercase tracking-wider text-slate-400">On the Clock</div>
          <div class="text-lg font-bold truncate">${escapeHtml(onClock || 'Draft Complete')}</div>
          <div class="text-xs text-slate-500">${subtitle}</div>
        </div>
        <div class="bbm-controls">
          <label class="bbm-drafted-toggle">
            <input id="bb-show-drafted" type="checkbox"${draftedChecked}>
            <span>Show drafted</span>
          </label>
          <input id="bb-search" type="text" placeholder="Search…" class="bbm-search">
        </div>
      </div>
      <div class="bbm-position-bar pretty-scroll">${positionList}</div>
      <div class="bbm-list-wrap">
        <div class="bbm-meta-row">
          <div id="bb-count" class="text-xs text-slate-500"></div>
          <div id="bb-filters" class="bbm-filters"></div>
        </div>
        <div id="bb-table" class="bbm-table pretty-scroll"></div>
      </div>
    </div>
  `;
  document.getElementById('modal-root').classList.add('big-board-modal-open');
  openModal('Big Board', '', body);
  // Wire up controls.
  document.querySelectorAll('[data-bb-pos]').forEach(btn => {
    btn.addEventListener('click', () => {
      bigBoardState.position = btn.dataset.bbPos;
      document.querySelectorAll('[data-bb-pos]').forEach(b => b.classList.toggle('active', b.dataset.bbPos === bigBoardState.position));
      // If the active sort is an attribute that's not in the new column set,
      // fall back to consensus.
      if (bigBoardState.sortBy.startsWith('attr:')) {
        const key = bigBoardState.sortBy.slice(5);
        if (!currentAttrColumns().includes(key)) bigBoardState.sortBy = 'consensus';
      }
      // Drop any attribute filters that no longer apply to the visible
      // column set — they'd be active-but-invisible otherwise.
      const colSet = new Set(currentAttrColumns().map(a => 'attr:' + a));
      for (const k of Object.keys(bigBoardState.filters)) {
        if (k.startsWith('attr:') && !colSet.has(k)) delete bigBoardState.filters[k];
      }
      renderBigBoardList();
    });
  });
  document.getElementById('bb-show-drafted').addEventListener('change', (e) => {
    bigBoardState.showDrafted = e.target.checked;
    renderBigBoardList();
  });
  const searchEl = document.getElementById('bb-search');
  searchEl.addEventListener('input', renderBigBoardList);
  renderBigBoardList();
}

function renderBigBoardList() {
  const c = state.session?.current_pick;
  const actionable = !!c;
  const drafted = new Set(state.board.filter(p => p.selected_player_id).map(p => p.selected_player_id));
  const searchEl = document.getElementById('bb-search');
  const q = searchEl ? searchEl.value.trim().toLowerCase() : '';

  // Build a per-player view by merging consensus board + user team board.
  // Use Player_ID as the join key. Consensus has `rank`; team has
  // `team_rank`/`original_rank`.
  const teamByPid = Object.fromEntries(bigBoardState.userTeamBoard.map(p => [p.player_id, p]));
  let players = state.publicBoard.map(p => {
    const t = teamByPid[p.player_id];
    return {
      ...p,
      team_rank: t?.team_rank ?? null,
      team_original_rank: t?.original_rank ?? null,
    };
  });
  // Filter: drafted, position (alias-aware), search.
  const allowedRaws = bigBoardState.position === 'ALL'
    ? null
    : new Set(POSITION_ALIASES[bigBoardState.position] || [bigBoardState.position]);
  const filters = bigBoardState.filters || {};
  const filterEntries = Object.entries(filters);
  players = players.filter(p => {
    if (!bigBoardState.showDrafted && (drafted.has(p.player_id) || p.drafted)) return false;
    if (allowedRaws && !allowedRaws.has(p.position)) return false;
    if (q) {
      const hay = (p.first_name + ' ' + p.last_name + ' ' + (p.college || '') + ' ' + (p.position || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    for (const [key, f] of filterEntries) {
      if (key === 'height') {
        if (parseHeight(p.height) < f.min) return false;
      } else if (key === 'weight') {
        if ((p.weight ?? -Infinity) < f.min) return false;
      } else if (key.startsWith('attr:')) {
        const attr = key.slice(5);
        if (gradeRank(p.attributes?.[attr]) < f.min) return false;
      }
    }
    return true;
  });
  // Sort. Nulls/unknowns always last regardless of mode.
  const sortBy = bigBoardState.sortBy;
  const isAttrSort = sortBy.startsWith('attr:');
  const attrKey = isAttrSort ? sortBy.slice(5) : null;
  if (isAttrSort) {
    players.sort((a, b) => {
      const ar = gradeRank(a.attributes?.[attrKey]);
      const br = gradeRank(b.attributes?.[attrKey]);
      if (br !== ar) return br - ar;  // higher grade first
      return (a.rank ?? 9999) - (b.rank ?? 9999);  // tie-break by consensus
    });
  } else if (sortBy === 'star') {
    players.sort((a, b) => {
      const ar = gradeRank(a.star);
      const br = gradeRank(b.star);
      if (br !== ar) return br - ar;
      return (a.rank ?? 9999) - (b.rank ?? 9999);
    });
  } else if (sortBy === 'height') {
    players.sort((a, b) => {
      const ar = parseHeight(a.height);
      const br = parseHeight(b.height);
      if (br !== ar) return br - ar;
      return (a.rank ?? 9999) - (b.rank ?? 9999);
    });
  } else if (sortBy === 'weight') {
    players.sort((a, b) => {
      const ar = a.weight ?? -Infinity;
      const br = b.weight ?? -Infinity;
      if (br !== ar) return br - ar;
      return (a.rank ?? 9999) - (b.rank ?? 9999);
    });
  } else if (sortBy === 'offfield') {
    players.sort((a, b) => {
      const ar = a.personality_rating ?? 0;
      const br = b.personality_rating ?? 0;
      if (br !== ar) return br - ar;
      return (a.rank ?? 9999) - (b.rank ?? 9999);
    });
  } else if (sortBy === 'name') {
    players.sort((a, b) =>
      (a.last_name || '').localeCompare(b.last_name || '') ||
      (a.first_name || '').localeCompare(b.first_name || ''));
  } else {
    const sortField = sortBy === 'team' ? 'team_rank' : 'rank';
    players.sort((a, b) => {
      const av = a[sortField], bv = b[sortField];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    });
  }
  document.getElementById('bb-count').textContent =
    `${players.length} player${players.length === 1 ? '' : 's'}` +
    (bigBoardState.showDrafted ? ' (incl. drafted)' : ' available');

  // Columns: # (rank), Player, HT, WT, then attribute columns. Each cell
  // is a flex container with: sort button on the left, optional filter
  // icon on the right. Filtered cols show a "≥X" badge.
  const attrCols = currentAttrColumns();
  invalidateAttrKindCache();  // publicBoard rarely changes but be safe
  // `filters` already in scope from the filter pass above.
  // Build one header cell. `filterKey` null means no filter trigger.
  const headerCol = (sortVal, label, extraCls, filterKey) => {
    const active = bigBoardState.sortBy === sortVal ? ' active' : '';
    const f = filterKey ? filters[filterKey] : null;
    const filterBtn = filterKey
      ? `<button class="bbm-th-filter${f ? ' active' : ''}" data-bb-filter="${escapeHtml(filterKey)}" title="Filter">▾</button>`
      : '';
    return `<div class="bbm-th-cell ${extraCls}">
      <button class="bbm-th${active}" data-bb-sort="${escapeHtml(sortVal)}">${escapeHtml(label)}</button>
      ${filterBtn}
    </div>`;
  };
  const headerHtml = `
    <div class="bbm-thead">
      ${headerCol('consensus', '#', 'bbm-th-rank', null)}
      ${headerCol('name', 'Player', 'bbm-th-name', null)}
      ${headerCol('height', 'HT', 'bbm-th-attr', 'height')}
      ${headerCol('weight', 'WT', 'bbm-th-attr', 'weight')}
      ${headerCol('offfield', 'OffField', 'bbm-th-attr', null)}
      ${attrCols.map(a => headerCol('attr:' + a, a, 'bbm-th-attr', 'attr:' + a)).join('')}
      <div class="bbm-th-action"></div>
    </div>
  `;
  // Active filter pills, shown only when at least one filter is set.
  const filterPillsHtml = renderFilterPills();
  const bodyHtml = players.slice(0, 600).map(p => {
    const isDrafted = drafted.has(p.player_id) || p.drafted;
    const cls = ['bbm-row'];
    if (isDrafted) cls.push('drafted');
    const logo = p.college_logo
      ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="bbm-logo">`
      : `<div class="bbm-logo-placeholder"></div>`;
    // Always show consensus rank as primary; team rank as small alt when not sorted by it.
    const primary = sortBy === 'team' ? p.team_rank : p.rank;
    const secondary = sortBy === 'team' ? p.rank : p.team_rank;
    const action = !isDrafted && actionable
      ? `<button class="bbm-draft" data-bb-draft="${escapeHtml(p.player_id)}">Draft</button>`
      : '';
    const cell = (val, isActive) => {
      const cellCls = ['bbm-td', 'bbm-td-attr', gradeClass(val)];
      if (isActive) cellCls.push('active-col');
      return `<div class="${cellCls.join(' ')}">${escapeHtml(compactGrade(val))}</div>`;
    };
    const plainCell = (text, isActive) => {
      const cellCls = ['bbm-td', 'bbm-td-attr', 'bbm-td-plain'];
      if (isActive) cellCls.push('active-col');
      return `<div class="${cellCls.join(' ')}">${escapeHtml(text ?? '—')}</div>`;
    };
    const heightCell = plainCell(p.height, sortBy === 'height');
    const weightCell = plainCell(p.weight, sortBy === 'weight');
    const offFieldCell = (() => {
      const pr = p.personality_rating;
      const isActive = sortBy === 'offfield';
      const cellCls = ['bbm-td', 'bbm-td-attr', 'bbm-td-plain'];
      if (isActive) cellCls.push('active-col');
      if (pr === 75) cellCls.push('bbm-char-minor');
      else if (pr === 90) cellCls.push('bbm-char-major');
      const label = pr === 75 ? 'Minor' : pr === 90 ? 'Major' : '—';
      return `<div class="${cellCls.join(' ')}">${label}</div>`;
    })();
    const attrCells = attrCols.map(a => cell(p.attributes?.[a], sortBy === 'attr:' + a)).join('');
    return `
      <div class="${cls.join(' ')}" data-bb-player="${escapeHtml(p.player_id)}">
        <div class="bbm-td bbm-td-rank">#${primary ?? '—'}${secondary != null ? `<span class="bbm-rank-alt">${sortBy === 'team' ? 'c' : 't'}${secondary}</span>` : ''}</div>
        <div class="bbm-td bbm-td-name">
          ${logo}
          <div class="bbm-info">
            <div class="bbm-name">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div>
            <div class="bbm-sub">${escapeHtml(p.position || '—')} · ${escapeHtml(p.college || '—')}</div>
          </div>
        </div>
        ${heightCell}
        ${weightCell}
        ${offFieldCell}
        ${attrCells}
        <div class="bbm-td bbm-td-action">${action}</div>
      </div>
    `;
  }).join('');

  // Inject filter pills above the table.
  document.getElementById('bb-filters').innerHTML = filterPillsHtml;

  // Set column count on the table so header + rows share the same grid
  // template via CSS custom property (1 rank + 1 name + 1 HT + 1 WT + 1 OffField + N attrs + 1 action).
  const tableEl = document.getElementById('bb-table');
  tableEl.style.setProperty('--bbm-attr-cols', attrCols.length);
  tableEl.innerHTML = headerHtml + (bodyHtml || '<div class="text-sm text-slate-500 p-6 text-center">No players match.</div>');

  tableEl.querySelectorAll('[data-bb-sort]').forEach(th => {
    th.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = th.dataset.bbSort;
      // Clicking the active sort a second time reverts to the default
      // consensus sort, so there's no manual "reset" needed.
      bigBoardState.sortBy = bigBoardState.sortBy === next ? 'consensus' : next;
      renderBigBoardList();
    });
  });
  tableEl.querySelectorAll('[data-bb-filter]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFilterPopover(btn);
    });
  });
  tableEl.querySelectorAll('[data-bb-draft]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await submitPick(btn.dataset.bbDraft);
      closeModal();
    });
  });
  tableEl.querySelectorAll('[data-bb-player]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-bb-draft]')) return;
      openPlayerProfile(row.dataset.bbPlayer, { returnTo: openBigBoardModal });
    });
  });
  // Filter pill removal + clear all.
  document.querySelectorAll('[data-bb-clear-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      delete bigBoardState.filters[btn.dataset.bbClearFilter];
      renderBigBoardList();
    });
  });
  const clearAll = document.getElementById('bb-clear-all-filters');
  if (clearAll) clearAll.addEventListener('click', () => {
    bigBoardState.filters = {};
    renderBigBoardList();
  });
}

function renderFilterPills() {
  const fs = bigBoardState.filters || {};
  const entries = Object.entries(fs);
  if (!entries.length) return '';
  const pills = entries.map(([key, f]) => {
    const label = key === 'height' ? 'HT'
      : key === 'weight' ? 'WT'
      : key.startsWith('attr:') ? key.slice(5)
      : key;
    return `<button class="bbm-filter-pill" data-bb-clear-filter="${escapeHtml(key)}" title="Remove filter">
      <span class="bbm-filter-pill-name">${escapeHtml(label)}</span>
      <span class="bbm-filter-pill-op">≥</span>
      <span class="bbm-filter-pill-val">${escapeHtml(f.label)}</span>
      <span class="bbm-filter-pill-x">×</span>
    </button>`;
  }).join('');
  return `${pills}<button id="bb-clear-all-filters" class="bbm-filter-clear-all">Clear all</button>`;
}

// Open a popover beneath the clicked filter button. Buckets depend on the
// column type (letter / star / height / weight).
function openFilterPopover(anchorBtn) {
  closeFilterPopover();
  const key = anchorBtn.dataset.bbFilter;
  const current = bigBoardState.filters?.[key];
  let buckets;
  if (key === 'height') {
    buckets = [];
    for (let ft = 5; ft <= 6; ft++) {
      for (let inch = 0; inch < 12; inch++) {
        buckets.push([`${ft}'${inch}"`, ft * 12 + inch]);
      }
    }
    buckets.push([`7'0"`, 84]);
    buckets.reverse();
  } else if (key === 'weight') {
    buckets = [];
    for (let w = 350; w >= 150; w -= 10) buckets.push([String(w) + ' lbs', w]);
  } else if (key.startsWith('attr:')) {
    buckets = attrKind(key.slice(5)) === 'star' ? STAR_BUCKETS : LETTER_BUCKETS;
  } else {
    return;
  }
  const isActive = (rank) => current && current.min === rank;
  const buttons = buckets.map(([label, rank]) =>
    `<button class="bbm-pop-btn${isActive(rank) ? ' active' : ''}" data-bb-pop-min="${rank}" data-bb-pop-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`
  ).join('');
  const pop = document.createElement('div');
  pop.id = 'bb-filter-popover';
  pop.className = 'bbm-popover';
  pop.innerHTML = `
    <div class="bbm-pop-title">Minimum</div>
    <div class="bbm-pop-grid">${buttons}</div>
    <button class="bbm-pop-any${!current ? ' active' : ''}" id="bb-pop-any">Any (clear)</button>
  `;
  document.body.appendChild(pop);
  // Position under the anchor, kept within viewport.
  const r = anchorBtn.getBoundingClientRect();
  const popW = 240;  // matches CSS width
  let left = r.left;
  if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = Math.max(8, left) + 'px';
  pop.querySelectorAll('[data-bb-pop-min]').forEach(b => {
    b.addEventListener('click', () => {
      bigBoardState.filters[key] = {
        min: parseFloat(b.dataset.bbPopMin),
        label: b.dataset.bbPopLabel,
      };
      closeFilterPopover();
      renderBigBoardList();
    });
  });
  document.getElementById('bb-pop-any').addEventListener('click', () => {
    delete bigBoardState.filters[key];
    closeFilterPopover();
    renderBigBoardList();
  });
  // Close on outside click / Escape.
  setTimeout(() => {
    document.addEventListener('click', _filterOutsideClick, { capture: true });
    document.addEventListener('keydown', _filterEscapeClose);
  }, 0);
}

function _filterOutsideClick(e) {
  const pop = document.getElementById('bb-filter-popover');
  if (!pop) return;
  if (!pop.contains(e.target) && !e.target.closest('[data-bb-filter]')) {
    closeFilterPopover();
  }
}
function _filterEscapeClose(e) {
  if (e.key === 'Escape') closeFilterPopover();
}
function closeFilterPopover() {
  const pop = document.getElementById('bb-filter-popover');
  if (pop) pop.remove();
  document.removeEventListener('click', _filterOutsideClick, { capture: true });
  document.removeEventListener('keydown', _filterEscapeClose);
}

// Compact display for a grade in a table cell: letter grades stay as-is
// ("A", "B+"), star tiers collapse to just the digit ("6-Great" -> "6").
function compactGrade(value) {
  if (value == null || value === '') return '—';
  const s = String(value);
  const m = s.match(/^([1-7])-/);
  if (m) return m[1];
  return s;
}

// Letter grades (A/B/C/D/F) and star tiers ("6-Great", "3-Decent" ...)
// both map to a 0-7-ish bucket so we can color-code attribute cells.
function gradeClass(value) {
  if (value == null || value === '') return 'g-unknown';
  const s = String(value);
  // Star pattern: "<digit>-<word>"
  const m = s.match(/^([1-7])-/);
  if (m) return 'g-star-' + m[1];
  const letter = s.trim().toUpperCase().charAt(0);
  if ('ABCDF'.indexOf(letter) >= 0) return 'g-' + letter.toLowerCase();
  return 'g-unknown';
}

async function openPlayerProfile(playerId, { returnTo = null } = {}) {
  const useOverlay = returnTo !== null;
  const bodyId = useOverlay ? 'player-overlay-body' : 'modal-body';

  if (useOverlay) {
    document.getElementById('player-overlay-title').textContent = 'Player Profile';
    document.getElementById('player-overlay-subtitle').textContent = '';
    document.getElementById('player-overlay-body').innerHTML = '<div class="text-sm text-slate-400">Loading…</div>';
    document.getElementById('player-overlay-root').classList.remove('hidden');
  } else {
    _modalReturnTo = null;
    document.getElementById('modal-root').classList.add('player-modal');
    openModal('Player Profile', '', '<div class="text-sm text-slate-400">Loading…</div>');
  }

  let p;
  try {
    p = await api.get('/api/player/' + encodeURIComponent(playerId));
  } catch (err) {
    document.getElementById(bodyId).innerHTML =
      `<div class="text-sm text-rose-400">Failed to load player.</div>`;
    return;
  }
  // Portrait is the main hero image with the college logo stacked
  // below it. Falls back to the college logo only if no portrait URL.
  const portraitBlock = p.portrait_url
    ? `<div class="pp-portrait-stack">
         <img src="${p.portrait_url}" alt="${escapeHtml(p.first_name + ' ' + p.last_name)}" class="pp-portrait">
         ${p.college_logo
           ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="pp-portrait-college-chip">`
           : ''}
       </div>`
    : (p.college_logo
        ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="pp-college-logo">`
        : `<div class="pp-college-logo-placeholder"></div>`);
  const bioBits = [
    p.position,
    p.height,
    p.weight ? `${p.weight} lbs` : null,
    p.age ? `Age ${p.age}` : null,
    p.college,
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const draftedBadge = p.drafted_info
    ? `<div class="pp-drafted">Drafted <strong>#${p.drafted_info.overall}</strong> by ${escapeHtml(p.drafted_info.team)} (R${p.drafted_info.round}, P${roundPickNumber({round: p.drafted_info.round, overall: p.drafted_info.overall, year_offset: 0})})</div>`
    : '';
  // OVR + DevTrait only after the player has actually been drafted —
  // mirrors the Last Selection card.
  const showLive = !!p.drafted_info;
  // Pick a color modifier from the dev trait — normal/star/superstar/
  // x-factor each get their own treatment.
  const devTraitClass = (() => {
    const t = String(p.development_trait || '').toLowerCase().replace(/[^a-z]/g, '');
    if (t.includes('xfactor')) return 'pp-meta-dev-xfactor';
    if (t.includes('superstar')) return 'pp-meta-dev-superstar';
    if (t.includes('star')) return 'pp-meta-dev-star';
    if (t.includes('normal')) return 'pp-meta-dev-normal';
    return '';
  })();
  const meta = [
    showLive && p.ovr != null ? `<div class="pp-meta-item"><div class="pp-meta-label">OVR</div><div class="pp-meta-value pp-meta-ovr">${escapeHtml(String(p.ovr))}</div></div>` : '',
    showLive && p.development_trait ? `<div class="pp-meta-item"><div class="pp-meta-label">Dev Trait</div><div class="pp-meta-value pp-meta-dev ${devTraitClass}">${escapeHtml(String(p.development_trait))}</div></div>` : '',
    p.consensus_rank != null ? `<div class="pp-meta-item"><div class="pp-meta-label">Consensus</div><div class="pp-meta-value">#${p.consensus_rank}</div></div>` : '',
    (p.projected_round != null && p.projected_pick != null) ? `<div class="pp-meta-item"><div class="pp-meta-label">Projected</div><div class="pp-meta-value">R${p.projected_round} · P${p.projected_pick}</div></div>` : '',
    p.grades && p.grades.star ? `<div class="pp-meta-item"><div class="pp-meta-label">Star</div><div class="pp-meta-value">${escapeHtml(p.grades.star)}</div></div>` : '',
  ].filter(Boolean).join('');

  let gradesHtml = '';
  if (p.grades && p.grades.attributes && Object.keys(p.grades.attributes).length) {
    const entries = Object.entries(p.grades.attributes);
    // Split by value shape: star tiers like "6-Great" are physical traits;
    // plain letter grades A/B/C/D/F are football skills.
    const skills = [];
    const physicals = [];
    for (const [k, v] of entries) {
      if (/^[1-7]-/.test(String(v))) physicals.push([k, v]);
      else skills.push([k, v]);
    }
    const group = p.grades.position_group;
    const priority = ATTR_PRIORITY[group] || [];
    const priorityIdx = new Map(priority.map((k, i) => [k, i]));
    const byPriority = (a, b) => {
      const ai = priorityIdx.has(a[0]) ? priorityIdx.get(a[0]) : 9999;
      const bi = priorityIdx.has(b[0]) ? priorityIdx.get(b[0]) : 9999;
      return ai - bi;
    };
    skills.sort(byPriority);
    physicals.sort(byPriority);
    const renderCells = (rows) => rows.map(([k, v]) => `
      <div class="pp-attr ${gradeClass(v)}">
        <div class="pp-attr-name">${escapeHtml(k)}</div>
        <div class="pp-attr-value">${escapeHtml(String(v))}</div>
      </div>
    `).join('');
    const groupTag = group ? ` <span class="pp-pos-group">(${escapeHtml(group)})</span>` : '';
    const skillsSection = skills.length ? `
      <div class="pp-section-title">Football Skills${groupTag}</div>
      <div class="pp-attr-grid">${renderCells(skills)}</div>
    ` : '';
    const physSection = physicals.length ? `
      <div class="pp-section-title">Physical Traits</div>
      <div class="pp-attr-grid">${renderCells(physicals)}</div>
    ` : '';
    gradesHtml = skillsSection + physSection;
  } else {
    gradesHtml = `<div class="pp-section-title">Madden Letter Grades</div>
      <div class="text-sm text-slate-500">No letter grades available for this prospect.</div>`;
  }

  const DRILL_LABELS = {
    FortyYardDash: '40 Time',
    TwentyYardShuttle: '20-Yd Shuttle',
    ThreeConeDrill: '3-Cone',
    VerticalJump: 'Vertical',
    BroadJump: 'Broad Jump',
    BenchPress: 'Bench Reps',
  };
  const DRILL_ORDER = ['FortyYardDash', 'TwentyYardShuttle', 'ThreeConeDrill', 'VerticalJump', 'BroadJump', 'BenchPress'];

  function formatDrillValue(drill, val) {
    if (val == null) return null;
    if (drill === 'FortyYardDash' || drill === 'TwentyYardShuttle' || drill === 'ThreeConeDrill')
      return (val / 100).toFixed(2) + ' sec';
    if (drill === 'VerticalJump')
      return (val / 10).toFixed(1) + '"';
    if (drill === 'BroadJump')
      return Math.floor(val / 12) + "'" + (val % 12) + '"';
    if (drill === 'BenchPress')
      return val + ' reps';
    return String(val);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderCombineSection(title, drillData, ranksData) {
    if (!drillData) return '';
    const cells = DRILL_ORDER.map(drill => {
      const raw = drillData[drill];
      const formatted = formatDrillValue(drill, raw);
      if (formatted == null) return '';
      const r = ranksData && ranksData[drill];
      const rankHtml = r ? `<div class="pp-attr-rank">${ordinal(r.rank)} out of ${r.total}</div>` : '';
      return `<div class="pp-attr g-stat">
        <div class="pp-attr-name">${DRILL_LABELS[drill]}</div>
        <div class="pp-attr-value">${escapeHtml(formatted)}</div>
        ${rankHtml}
      </div>`;
    }).join('');
    if (!cells.trim()) return '';
    return `<div class="pp-section-title">${title}</div><div class="pp-attr-grid pp-combine-grid">${cells}</div>`;
  }

  const combineHtml = p.combine_data
    ? renderCombineSection('Combine Performance', p.combine_data.combine, p.combine_data.combine_ranks) +
      renderCombineSection('Pro Day Performance', p.combine_data.pro_day, p.combine_data.pro_day_ranks)
    : '';

  const body = `
    <div class="player-profile">
      <div class="pp-header">
        ${portraitBlock}
        <div class="pp-header-info">
          <div class="pp-name">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div>
          <div class="pp-bio">${bioBits}</div>
          ${draftedBadge}
        </div>
      </div>
      <div class="pp-meta-row">${meta}</div>
      ${gradesHtml}
      ${combineHtml}
    </div>
  `;
  document.getElementById(bodyId).innerHTML = body;
}

function openFullBoard() {
  // Group picks by round so we can drop a round-divider between sections.
  // Each section is its own 8-wide grid; the user's picks keep the gold
  // border treatment from `.pick-cell.user-pick` so they're easy to find.
  const rounds = new Map();
  for (const p of state.board) {
    if (!rounds.has(p.round)) rounds.set(p.round, []);
    rounds.get(p.round).push(p);
  }
  const sections = Array.from(rounds.entries()).map(([round, picks]) => {
    const userCount = picks.filter(p => p.current_team === state.userTeam).length;
    const userBadge = userCount
      ? `<span class="fb-round-user-count">${userCount} pick${userCount === 1 ? '' : 's'}</span>`
      : '';
    return `
      <div class="fb-round-section">
        <div class="fb-round-divider">
          <span class="fb-round-label">Round ${round}</span>
          <span class="fb-round-line"></span>
          ${userBadge}
        </div>
        <div class="fb-round-grid">${picks.map(renderPickCell).join('')}</div>
      </div>
    `;
  }).join('');
  const html = `<div class="full-board pretty-scroll">${sections}</div>`;
  document.getElementById('modal-root').classList.add('full-board-modal');
  openModal('Full Draft Order', `${state.session.picks_made} of ${state.session.total_picks} picks made`, html);
  const modalBody = document.getElementById('modal-body');
  bindSimToPickClicks(modalBody);
  // Completed cells: clicking opens the drafted player's card. Future
  // (.simmable) cells keep the sim-to-pick behavior via the call above.
  modalBody.querySelectorAll('.pick-cell.completed').forEach(cell => {
    const overall = parseInt(cell.dataset.overall, 10);
    const pick = state.board.find(p => p.overall === overall);
    if (!pick?.selected_player_id) return;
    const trigger = () => openPlayerProfile(pick.selected_player_id, { returnTo: openFullBoard });
    cell.style.cursor = 'pointer';
    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.addEventListener('click', trigger);
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
    });
  });
}

// ---------- modal & toast ----------

function bindModal() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-root').addEventListener('click', (e) => {
    if (e.target.id === 'modal-root') closeModal();
  });
  document.getElementById('player-overlay-close').addEventListener('click', closePlayerOverlay);
  document.getElementById('player-overlay-root').addEventListener('click', (e) => {
    if (e.target.id === 'player-overlay-root') closePlayerOverlay();
  });
}

function openModal(title, subtitle, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-subtitle').textContent = subtitle || '';
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-root').classList.remove('hidden');
}

function confirmAction({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm }) {
  // Lightweight confirm dialog reusing the modal root.
  //
  // Two ways to use:
  //   1. Pass `onConfirm` — fires when user confirms (legacy fire-and-forget).
  //   2. `await confirmAction({...})` — returns a Promise<boolean> resolving
  //      true on confirm / false on cancel.
  // Both work simultaneously, so existing callers stay untouched.
  return new Promise((resolve) => {
    const safeMessage = typeof message === 'string'
      ? `<div class="text-sm text-slate-300">${escapeHtml(message)}</div>`
      : message;  // allow trusted HTML for richer body
    const body = `
      ${safeMessage}
      <div class="mt-4 flex items-center justify-end gap-2">
        <button id="confirm-go" class="primary-btn">${escapeHtml(confirmLabel)}</button>
        <button id="confirm-cancel" class="sim-btn">${escapeHtml(cancelLabel)}</button>
      </div>
    `;
    openModal(title, '', body);
    document.getElementById('confirm-cancel').addEventListener('click', () => {
      closeModal();
      resolve(false);
    });
    document.getElementById('confirm-go').addEventListener('click', async () => {
      closeModal();
      if (onConfirm) await onConfirm();
      resolve(true);
    });
  });
}

// When a modal is opened from inside another modal, the closer sets this
// to a callback that reopens the parent. closeModal consumes it.
let _modalReturnTo = null;

function closeModal() {
  const root = document.getElementById('modal-root');
  root.classList.add('hidden');
  root.classList.remove('full-board-modal', 'picker-modal', 'big-board-modal-open',
    'player-modal', 'trade-hub-modal', 'trade-history-modal', 'rosters-modal', 'gm-info-modal',
    'sim-report-modal');
  const returnTo = _modalReturnTo;
  _modalReturnTo = null;
  if (returnTo) returnTo();
}

function closePlayerOverlay() {
  document.getElementById('player-overlay-root').classList.add('hidden');
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('toast-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast-show'), 3000);
}

// ---------- utils ----------

function renderConsensusDelta(p) {
  // Show "#consensus (±delta)" using the team's ORIGINAL (session-start)
  // ranking — fixed for the whole draft, not recomputed as players are
  // drafted. delta = consensus_rank - original_rank: positive means the
  // team had him higher on their board than consensus (green/likes him),
  // negative means lower (red/concerns).
  const consensus = p.consensus_rank;
  const originalTeam = p.original_rank;
  if (consensus == null) return '<span class="text-slate-500">—</span>';
  if (originalTeam == null) return `<span class="text-slate-500">#${consensus}</span>`;
  const delta = consensus - originalTeam;
  if (delta === 0) {
    return `<span class="text-slate-500">#${consensus} <span class="text-slate-600">(=)</span></span>`;
  }
  const sign = delta > 0 ? '+' : '−';
  const mag = Math.abs(delta);
  const cls = delta > 0 ? 'text-emerald-400' : 'text-rose-400';
  return `<span class="text-slate-500">#${consensus}</span> <span class="${cls} font-semibold">(${sign}${mag})</span>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
