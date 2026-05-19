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
};

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
  grid.innerHTML = '<div class="col-span-4 text-xs text-slate-500 text-center py-2">Loading teams…</div>';
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
    grid.innerHTML = '<div class="col-span-4 text-xs text-rose-400 text-center py-2">Failed to load teams.</div>';
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

  // Round picker.
  const maxRound = Math.max(...state.board.map(p => p.round));
  const rp = document.getElementById('round-picker');
  if (rp.options.length === 0) {
    for (let r = 1; r <= maxRound; r++) {
      const o = document.createElement('option');
      o.value = String(r);
      o.textContent = `Round ${r}`;
      rp.appendChild(o);
    }
    rp.addEventListener('change', () => {
      state.selectedRound = parseInt(rp.value, 10);
      renderRoundGrid();
    });
  }

  // Auto-snap selected round to the round of the current pick.
  if (state.session.current_pick) {
    state.selectedRound = state.session.current_pick.round;
    rp.value = String(state.selectedRound);
  }

  await refreshContextual();
  renderAll();
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
  renderTeamBoard();
  renderSimRoundSelect();
}

function renderOnTheClock() {
  const c = state.session.current_pick;
  const teamEl = document.getElementById('on-the-clock-team');
  const metaEl = document.getElementById('on-the-clock-meta');
  const logoEl = document.getElementById('on-the-clock-logo');
  if (!c) {
    teamEl.textContent = 'Draft Complete';
    metaEl.textContent = `${state.session.picks_made} of ${state.session.total_picks} picks`;
    if (logoEl) logoEl.innerHTML = '';
    return;
  }
  teamEl.textContent = c.current_team;
  metaEl.textContent = `Round ${c.round}, Pick ${c.pick_in_round} (Overall ${c.overall})` +
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
  const collegeBlock = p.college_logo
    ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="mx-auto h-12 w-12 object-contain mb-2">`
    : (p.college ? `<div class="text-[10px] uppercase tracking-wider text-slate-500 text-center mb-1">${escapeHtml(p.college)}</div>` : '');
  const teamLogo = p.current_team_logo
    ? `<img src="${p.current_team_logo}" alt="${escapeHtml(p.current_team)}" class="h-4 w-4 object-contain">`
    : '';
  el.innerHTML = `
    <div class="text-center">${collegeBlock}</div>
    <div class="text-xs text-slate-500 flex items-center gap-1.5 justify-center">${teamLogo}<span>R${p.round}.${p.pick_in_round} · ${escapeHtml(p.current_team)}</span></div>
    <div class="mt-1 text-base font-semibold text-center">${escapeHtml(p.selected_player_name || '')}</div>
    ${p.position ? `<div class="text-xs text-slate-400 text-center">${escapeHtml(p.position)}${p.college ? ' · ' + escapeHtml(p.college) : ''}</div>` : ''}
  `;
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
  el.innerHTML = top.map(n => `
    <div class="need-row">
      <span class="pos">${n.label}</span>
      <span class="meta">w ${n.weight}</span>
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
    return `<div class="ps-row">
      <span class="ps-pos">${escapeHtml(pos)}</span>
      ${logo}
      <span class="ps-meta">${escapeHtml(p.selected_player_name)} <span class="ps-rd">R${p.round} P${p.pick_in_round}</span></span>
    </div>`;
  }).join('');
}

function renderRoundTitle() {
  document.getElementById('round-title').textContent = `Round ${state.selectedRound}`;
}

function renderRoundGrid(target = 'round-grid') {
  const el = document.getElementById(target);
  const picks = state.board.filter(p => p.round === state.selectedRound);
  el.innerHTML = picks.map(p => renderPickCell(p)).join('');
  bindSimToPickClicks(el);
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

function promptSimUntilOverall(overall) {
  if (!overall) return;
  const c = state.session?.current_pick;
  if (c && overall <= c.overall) return;
  const target = state.board.find(p => p.overall === overall);
  if (!target) return;
  confirmAction({
    title: `Sim to R${target.round}.${target.pick_in_round}?`,
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
function getPositionByPlayerId() {
  if (_positionByPlayerId === null) {
    _positionByPlayerId = {};
    for (const pl of state.publicBoard) {
      if (pl.player_id) _positionByPlayerId[pl.player_id] = pl.position;
    }
  }
  return _positionByPlayerId;
}
function invalidatePositionLookup() { _positionByPlayerId = null; }

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
  if (completed) {
    const pos = getPositionByPlayerId()[p.selected_player_id];
    const posTag = pos ? `<span class="pick-pos">${escapeHtml(displayPosition(pos))}</span>` : '';
    playerLine = `<div class="pick-player">${posTag}${escapeHtml(p.selected_player_name)}</div>`;
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
      <div class="pick-num">R${p.round}.${p.pick_in_round} · #${p.overall}</div>
      <div class="pick-header">${logo}<div class="pick-team">${escapeHtml(p.current_team)}</div></div>
      ${playerLine}
      ${trade}
    </div>
  `;
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
  el.innerHTML = rows;
  el.querySelectorAll('[data-draft-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitPick(btn.dataset.draftId);
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
  await reloadSessionAndRender();
  if (res.trade) {
    showTradeModal(res.trade, res.pick);
  } else if (res.pick) {
    toast(`R${res.pick.round}.${res.pick.pick_in_round}: ${res.pick.current_team} → ${res.pick.selected_player_name}`);
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
      <span>R${p.round}.${p.pick_in_round}${nyBadge} <span class="text-slate-500 text-xs">#${p.draft_slot ?? p.overall}</span></span>
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
  const res = await api.post('/api/pick/force-make', { player_id: playerId });
  if (!res.ok) return toast('Pick failed: ' + res.error);
  await reloadSessionAndRender();
  toast(`${res.drafted_for || c.current_team} drafted.`);
}

async function reloadSessionAndRender() {
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
  if (state.session.current_pick) {
    state.selectedRound = state.session.current_pick.round;
    document.getElementById('round-picker').value = String(state.selectedRound);
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
        : '<div class="text-sm text-slate-400">No teams are interested in trading up right now. (Trade logic is a placeholder — once implemented this will populate.)</div>'));
}

function openTradeUpModal(opts = {}) {
  const myUnpickedPicks = state.board.filter(p => p.current_team === state.userTeam && !p.selected_player_id);
  const targets = state.board.filter(p => p.current_team !== state.userTeam && !p.selected_player_id)
    .slice(0, 64);
  const preselect = opts.targetCurrent && state.session.current_pick
    ? state.session.current_pick.overall : null;
  const targetOpts = targets.map(p => {
    const sel = preselect === p.overall ? ' selected' : '';
    return `<option value="${p.overall}"${sel}>R${p.round}.${p.pick_in_round} · ${escapeHtml(p.current_team)} (overall ${p.overall})</option>`;
  }).join('');
  const offerCheckboxes = myUnpickedPicks.map(p => `
    <label class="flex items-center gap-2 text-sm py-1">
      <input type="checkbox" class="trade-up-offer" value="${p.overall}">
      <span>R${p.round}.${p.pick_in_round} (overall ${p.overall})</span>
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

async function openTradeHub() {
  // Trade Hub modal. Layout depends on who's on the clock:
  //  - User on clock: incoming offers + manual trade form (full layout).
  //  - AI on clock: trade-up form only, with the on-clock pick pre-selected.
  //  - Draft complete: empty state.
  const c = state.session?.current_pick;
  const isUserPick = c?.current_team === state.userTeam;

  let body, subtitle;
  if (!c) {
    body = '<div class="text-sm text-slate-400">Draft is complete — no more trades possible.</div>';
    subtitle = '';
  } else if (isUserPick) {
    const res = await api.get('/api/trade/down-offers').catch(() => ({ ok: false }));
    const offers = (res.ok && res.offers) || [];
    const offersBlock = offers.length
      ? renderOffersTable(offers)
      : '<div class="text-sm text-slate-400">No incoming trade-up offers right now. <span class="text-slate-500">(AI trade logic is still a placeholder.)</span></div>';
    body = `
      <div class="space-y-5">
        <div>
          <div class="card-eyebrow mb-2">Incoming Offers</div>
          ${offersBlock}
        </div>
        <div class="border-t border-ink-700 pt-4">
          <div class="card-eyebrow mb-2">Offer Manual Trade</div>
          ${buildTradeForm(c, isUserPick)}
        </div>
      </div>
    `;
    subtitle = 'Review incoming offers or propose a manual trade';
  } else {
    body = `
      <div class="space-y-3">
        <div class="card-eyebrow">Trade Up to ${escapeHtml(c.current_team)}'s Pick</div>
        <div class="text-xs text-slate-500">R${c.round}.${c.pick_in_round} · pick #${c.draft_slot ?? c.overall}</div>
        ${buildTradeForm(c, isUserPick)}
      </div>
    `;
    subtitle = `Propose a trade for ${escapeHtml(c.current_team)}'s pick`;
  }
  openModal('Trade Hub', subtitle, body);

  const targetSel = document.getElementById('trade-up-target');
  if (targetSel) {
    updateTargetTeamPicks(targetSel.value);
    targetSel.addEventListener('change', e => updateTargetTeamPicks(e.target.value));
  }
  const submitBtn = document.getElementById('submit-trade-up');
  if (submitBtn) submitBtn.addEventListener('click', submitTradeUp);
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
    return `<option value="${p.overall}"${sel}>R${p.round}.${p.pick_in_round}${nyStr} · ${escapeHtml(p.current_team)} (#${p.draft_slot ?? p.overall}${valStr})</option>`;
  }).join('');

  const myPicksHtml = myUnpickedPicks.length
    ? myUnpickedPicks.map(p => {
        const valStr = p.value != null ? ` <span class="text-slate-500">${p.value.toLocaleString()} pts</span>` : '';
        const badge = p.year_offset ? ' ' + nyBadge : '';
        return `<label class="flex items-center justify-between gap-2 text-sm py-1 cursor-pointer">
          <span class="flex items-center gap-2">
            <input type="checkbox" class="trade-up-offer" value="${p.overall}" data-value="${p.value ?? 0}" onchange="updateTradeTotals()">
            R${p.round}.${p.pick_in_round}${badge} <span class="text-slate-500">#${p.draft_slot ?? p.overall}</span>
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
          R${p.round}.${p.pick_in_round}${badge} <span class="text-slate-500">#${p.draft_slot ?? p.overall}</span>
          <span class="text-xs text-accent-400">(target)</span>
        </span>
        ${valStr}
      </label>`;
    }
    return `<label class="flex items-center justify-between gap-2 text-sm py-1 cursor-pointer">
      <span class="flex items-center gap-2">
        <input type="checkbox" class="trade-their-pick" value="${p.overall}" data-value="${p.value ?? 0}" onchange="updateTradeTotals()">
        R${p.round}.${p.pick_in_round}${badge} <span class="text-slate-500">#${p.draft_slot ?? p.overall}</span>
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
    result.innerHTML = '<span class="text-emerald-400">Offer accepted!</span> Refreshing…';
    await reloadSessionAndRender();
    setTimeout(closeModal, 800);
  } else {
    const d = res.decision;
    let msg = 'Offer refused: ' + (d.reason || 'no reason given');
    if (d.offer_value != null && d.target_value != null) {
      msg += ` (your offer: ${d.offer_value.toLocaleString()} pts`;
      if (d.threshold != null) msg += `, need: ${Math.ceil(d.target_value * d.threshold).toLocaleString()} pts`;
      msg += ')';
    }
    result.textContent = msg;
  }
}

function renderOffersTable(offers) {
  return `
    <table class="w-full text-sm">
      <thead class="text-xs uppercase text-slate-400 border-b border-ink-700">
        <tr><th class="text-left py-1">From</th><th class="text-left py-1">Offers</th><th class="text-left py-1">Value</th><th></th></tr>
      </thead>
      <tbody>
        ${offers.map(o => `<tr class="border-b border-ink-800">
          <td class="py-1">${escapeHtml(o.from_team || '?')}</td>
          <td class="py-1 text-xs">${(o.from_picks || []).map(p => `R${p.round}.${p.pick_in_round}`).join(', ')}</td>
          <td class="py-1 font-mono text-xs">${o.value ?? '—'}</td>
          <td class="py-1 text-right"><button class="action-btn">Accept</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

// ---------- Big Board modal ----------

const POSITION_ORDER = ['QB','RB','FB','WR','TE','OG','OT','C','END','DT','OLB','ILB','CB','SS','FS','K','P'];

// Madden stores sub-positions (LE/RE, LG/RG, LT/RT, LOLB/ROLB, MLB, HB) but
// we display the conventional grouping (END, OG, OT, OLB, ILB, RB). This
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
  OLB: ['LOLB', 'ROLB'],
  ILB: ['MLB', 'ILB'],
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

const bigBoardState = {
  position: 'ALL',          // 'ALL' | one of POSITION_ORDER
  sortBy: 'consensus',      // 'consensus' | 'team'
  showDrafted: false,
  userTeamBoard: [],        // cached big board for the user's team
};

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
    ? `Drafting for ${onClock} · R${c.round}.${c.pick_in_round} (overall ${c.overall})`
    : 'Draft is complete — viewing only';
  const positionList = ['ALL', ...POSITION_ORDER].map(pos => {
    const label = pos === 'ALL' ? 'All' : pos;
    const active = bigBoardState.position === pos ? ' active' : '';
    return `<button class="bb-pos-pill${active}" data-bb-pos="${escapeHtml(pos)}">${escapeHtml(label)}</button>`;
  }).join('');
  const sortConsensusActive = bigBoardState.sortBy === 'consensus' ? ' active' : '';
  const sortTeamActive = bigBoardState.sortBy === 'team' ? ' active' : '';
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
          <div class="bbm-sort-group">
            <button class="bbm-sort${sortConsensusActive}" data-bb-sort="consensus">Consensus</button>
            <button class="bbm-sort${sortTeamActive}" data-bb-sort="team">My Team</button>
          </div>
          <label class="bbm-drafted-toggle">
            <input id="bb-show-drafted" type="checkbox"${draftedChecked}>
            <span>Show drafted</span>
          </label>
          <input id="bb-search" type="text" placeholder="Search…" class="bbm-search">
        </div>
      </div>
      <div class="bbm-position-bar pretty-scroll">${positionList}</div>
      <div class="bbm-list-wrap">
        <div id="bb-count" class="text-xs text-slate-500 px-1 pb-1.5"></div>
        <div id="bb-list" class="bbm-list pretty-scroll"></div>
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
      renderBigBoardList();
    });
  });
  document.querySelectorAll('[data-bb-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      bigBoardState.sortBy = btn.dataset.bbSort;
      document.querySelectorAll('[data-bb-sort]').forEach(b => b.classList.toggle('active', b.dataset.bbSort === bigBoardState.sortBy));
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
  players = players.filter(p => {
    if (!bigBoardState.showDrafted && (drafted.has(p.player_id) || p.drafted)) return false;
    if (allowedRaws && !allowedRaws.has(p.position)) return false;
    if (q) {
      const hay = (p.first_name + ' ' + p.last_name + ' ' + (p.college || '') + ' ' + (p.position || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  // Sort: consensus or team. Nulls always last.
  const sortField = bigBoardState.sortBy === 'team' ? 'team_rank' : 'rank';
  players.sort((a, b) => {
    const av = a[sortField], bv = b[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  });
  document.getElementById('bb-count').textContent =
    `${players.length} player${players.length === 1 ? '' : 's'}` +
    (bigBoardState.showDrafted ? ' (incl. drafted)' : ' available');
  const html = players.slice(0, 600).map(p => {
    const isDrafted = drafted.has(p.player_id) || p.drafted;
    const cls = ['bbm-row'];
    if (isDrafted) cls.push('drafted');
    const logo = p.college_logo
      ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="bbm-logo">`
      : `<div class="bbm-logo-placeholder"></div>`;
    const primary = bigBoardState.sortBy === 'team' ? p.team_rank : p.rank;
    const secondary = bigBoardState.sortBy === 'team' ? p.rank : p.team_rank;
    const action = !isDrafted && actionable
      ? `<button class="bbm-draft" data-bb-draft="${escapeHtml(p.player_id)}">Draft</button>`
      : '';
    return `
      <div class="${cls.join(' ')}">
        <div class="bbm-rank">#${primary ?? '—'}${secondary != null ? `<span class="bbm-rank-alt">${bigBoardState.sortBy === 'team' ? 'c' : 't'}${secondary}</span>` : ''}</div>
        ${logo}
        <div class="bbm-info">
          <div class="bbm-name">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div>
          <div class="bbm-sub">${escapeHtml(p.position || '—')} · ${escapeHtml(p.college || '—')}</div>
        </div>
        ${action}
      </div>
    `;
  }).join('');
  const listEl = document.getElementById('bb-list');
  listEl.innerHTML = html || '<div class="text-sm text-slate-500 p-6 text-center">No players match.</div>';
  listEl.querySelectorAll('[data-bb-draft]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await submitPick(btn.dataset.bbDraft);
      closeModal();
    });
  });
}

function openFullBoard() {
  const html = `<div class="full-board pretty-scroll">${state.board.map(renderPickCell).join('')}</div>`;
  document.getElementById('modal-root').classList.add('full-board-modal');
  openModal('Full Draft Order', `${state.session.picks_made} of ${state.session.total_picks} picks made`, html);
  bindSimToPickClicks(document.getElementById('modal-body'));
}

// ---------- modal & toast ----------

function bindModal() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-root').addEventListener('click', (e) => {
    if (e.target.id === 'modal-root') closeModal();
  });
}

function openModal(title, subtitle, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-subtitle').textContent = subtitle || '';
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-root').classList.remove('hidden');
}

function confirmAction({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm }) {
  // Lightweight confirm dialog reusing the modal root. Awaits a user
  // click on Confirm before calling onConfirm; Cancel just closes.
  const safeMessage = typeof message === 'string'
    ? `<div class="text-sm text-slate-300">${escapeHtml(message)}</div>`
    : message;  // allow trusted HTML for richer body
  const body = `
    ${safeMessage}
    <div class="mt-4 flex items-center justify-end gap-2">
      <button id="confirm-cancel" class="sim-btn">${escapeHtml(cancelLabel)}</button>
      <button id="confirm-go" class="primary-btn">${escapeHtml(confirmLabel)}</button>
    </div>
  `;
  openModal(title, '', body);
  document.getElementById('confirm-cancel').addEventListener('click', closeModal);
  document.getElementById('confirm-go').addEventListener('click', async () => {
    closeModal();
    if (onConfirm) await onConfirm();
  });
}

function closeModal() {
  const root = document.getElementById('modal-root');
  root.classList.add('hidden');
  root.classList.remove('full-board-modal', 'picker-modal', 'big-board-modal-open');
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
