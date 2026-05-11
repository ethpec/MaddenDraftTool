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
  forcePickMode: false,  // when true, public board's Draft buttons force-pick for the AI on the clock
};

// ---------- bootstrap ----------

window.addEventListener('DOMContentLoaded', async () => {
  await populateYears();
  document.getElementById('start-btn').addEventListener('click', startDraft);
  bindHeaderActions();
  bindModal();
});

async function populateYears() {
  const res = await api.get('/api/years');
  const sel = document.getElementById('year-select');
  sel.innerHTML = '';
  // Always include a generic "current" option that maps to TestFiles fallback.
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

async function startDraft() {
  const btn = document.getElementById('start-btn');
  const status = document.getElementById('setup-status');
  btn.disabled = true;
  status.textContent = 'Loading data… (Player.xlsx is large, this can take 5–10s)';
  const year = document.getElementById('year-select').value;
  try {
    const res = await api.post('/api/session/start', { year });
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
  state.publicBoard = pub.players;

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
  renderPublicBoard();
  renderTeamBoard();
  renderSimRoundSelect();
}

function renderOnTheClock() {
  const c = state.session.current_pick;
  const teamEl = document.getElementById('on-the-clock-team');
  const metaEl = document.getElementById('on-the-clock-meta');
  const logoEl = document.getElementById('on-the-clock-logo');
  const userActions = document.getElementById('user-pick-actions');
  const aiActions = document.getElementById('ai-pick-actions');
  const forceTeamName = document.getElementById('force-pick-team-name');
  if (!c) {
    teamEl.textContent = 'Draft Complete';
    metaEl.textContent = `${state.session.picks_made} of ${state.session.total_picks} picks`;
    if (logoEl) logoEl.innerHTML = '';
    userActions.classList.add('hidden');
    if (aiActions) aiActions.classList.add('hidden');
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
  if (c.current_team === state.userTeam) {
    userActions.classList.remove('hidden');
    if (aiActions) aiActions.classList.add('hidden');
    updateTradeHubBadge();
  } else {
    userActions.classList.add('hidden');
    if (aiActions) {
      aiActions.classList.remove('hidden');
      if (forceTeamName) forceTeamName.textContent = c.current_team;
    }
  }
}

async function updateTradeHubBadge() {
  // Show offer count next to the Trade Hub button when user is on clock.
  const badge = document.getElementById('trade-hub-badge');
  if (!badge) return;
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
  const posMap = Object.fromEntries(state.publicBoard.map(p => [p.player_id, p.position]));
  const picks = state.board.filter(p => p.current_team === onClockTeam && p.selected_player_id);
  if (!picks.length) {
    el.innerHTML = '<div class="text-xs text-slate-500">No picks yet.</div>';
    return;
  }
  el.innerHTML = picks.map(p => {
    const pos = posMap[p.selected_player_id] ?? '—';
    return `<div class="need-row">
      <span class="pos">${pos}</span>
      <span class="meta">${p.selected_player_name} · R${p.round} P${p.pick_in_round}</span>
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
}

function renderPickCell(p) {
  const onClock = state.session.current_pick && state.session.current_pick.overall === p.overall;
  const isUser = p.current_team === state.userTeam;
  const completed = !!p.selected_player_id;
  const cls = ['pick-cell'];
  if (isUser) cls.push('user-pick');
  if (onClock) cls.push('on-clock');
  if (completed) cls.push('completed');
  const playerLine = completed
    ? `<div class="pick-player">${escapeHtml(p.selected_player_name)}</div>`
    : `<div class="pick-player placeholder">${onClock ? 'On the clock…' : 'TBD'}</div>`;
  const trade = p.original_team !== p.current_team
    ? `<div class="text-[9px] uppercase tracking-wider text-accent-500 mt-0.5">via ${escapeHtml(p.original_team)}</div>`
    : '';
  const logo = p.current_team_logo
    ? `<img src="${p.current_team_logo}" alt="${escapeHtml(p.current_team)}" class="pick-logo">`
    : '';
  return `
    <div class="${cls.join(' ')}" data-overall="${p.overall}">
      <div class="pick-num">R${p.round}.${p.pick_in_round} · #${p.overall}</div>
      <div class="pick-header">${logo}<div class="pick-team">${escapeHtml(p.current_team)}</div></div>
      ${playerLine}
      ${trade}
    </div>
  `;
}

function renderPublicBoard() {
  const search = document.getElementById('board-search');
  if (!search.dataset.bound) {
    search.addEventListener('input', renderPublicBoard);
    search.dataset.bound = '1';
  }
  const q = search.value.trim().toLowerCase();
  const drafted = new Set(state.board.filter(p => p.selected_player_id).map(p => p.selected_player_id));
  const isUserPick = state.session.current_pick && state.session.current_pick.current_team === state.userTeam;
  const draftableEnabled = isUserPick || state.forcePickMode;
  const rows = state.publicBoard
    .filter(p => !q || (p.first_name + ' ' + p.last_name + ' ' + (p.college || '')).toLowerCase().includes(q))
    .slice(0, 200)
    .map(p => {
      const isDrafted = drafted.has(p.player_id) || p.drafted;
      const cls = ['bb-row'];
      if (isDrafted) cls.push('drafted');
      else if (draftableEnabled) cls.push('draftable');
      const logo = p.college_logo
        ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="bb-logo">`
        : `<div class="bb-logo-placeholder"></div>`;
      const sub = [p.position, p.college].filter(Boolean).map(escapeHtml).join(' · ');
      return `
        <div class="${cls.join(' ')}" data-player-id="${escapeHtml(p.player_id)}">
          <div class="bb-rank">${p.rank ?? '—'}</div>
          ${logo}
          <div class="bb-info">
            <div class="bb-name">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div>
            ${sub ? `<div class="bb-sub">${sub}</div>` : ''}
          </div>
          <button class="bb-action" data-draft-id="${escapeHtml(p.player_id)}">Draft</button>
        </div>
      `;
    }).join('');
  const el = document.getElementById('public-board');
  el.innerHTML = rows || '<div class="text-xs text-slate-500 p-3">No matches.</div>';
  el.querySelectorAll('[data-draft-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.forcePickMode) {
        forceMakePick(btn.dataset.draftId);
      } else {
        makeUserPick(btn.dataset.draftId);
      }
    });
  });
}

function renderTeamBoard() {
  const picker = document.getElementById('team-board-picker');
  if (picker.value !== state.selectedTeamForBoard) {
    picker.value = state.selectedTeamForBoard || state.userTeam;
  }
  const drafted = new Set(state.board.filter(p => p.selected_player_id).map(p => p.selected_player_id));
  const rows = state.teamBoard.slice(0, 100).map(p => {
    const isDrafted = drafted.has(p.player_id) || p.drafted;
    const cls = ['bb-row'];
    if (isDrafted) cls.push('drafted');
    const logo = p.college_logo
      ? `<img src="${p.college_logo}" alt="${escapeHtml(p.college || '')}" class="bb-logo">`
      : `<div class="bb-logo-placeholder"></div>`;
    const sub = [p.position, p.college].filter(Boolean).map(escapeHtml).join(' · ');
    return `
      <div class="${cls.join(' ')}">
        <div class="bb-rank">${p.team_rank ?? '—'}${p.original_rank != null && p.original_rank !== p.team_rank ? `<span class="bb-orig-rank">(${p.original_rank})</span>` : ''}</div>
        ${logo}
        <div class="bb-info">
          <div class="bb-name">${escapeHtml(p.first_name)} ${escapeHtml(p.last_name)}</div>
          ${sub ? `<div class="bb-sub">${sub}</div>` : ''}
        </div>
        <div class="text-[10px] text-slate-500 font-mono">c${p.consensus_rank ?? '—'}</div>
      </div>
    `;
  }).join('');
  document.getElementById('team-board').innerHTML = rows;
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
    case 'sim-until-round': return promptSimUntilRound();
    case 'open-board-zoom': return openFullBoard();
    case 'export': return doExport();
    case 'trade-down': return showTradeDownOffers();
    case 'trade-up': return openTradeUpModal();
    case 'trade-hub': return openTradeHub();
    case 'trade-up-current': return openTradeUpModal({ targetCurrent: true });
    case 'force-pick-on-board': return enterForcePickMode();
  }
}

async function simPick() {
  const c = state.session.current_pick;
  if (!c) return toast('Draft complete.');
  if (c.current_team === state.userTeam) {
    return toast("Steelers are on the clock — pick or trade.");
  }
  const res = await api.post('/api/pick/sim');
  if (!res.ok) return toast('Sim failed: ' + (res.error || 'unknown'));
  await reloadSessionAndRender();
  if (res.pick) toast(`R${res.pick.round}.${res.pick.pick_in_round}: ${res.pick.current_team} → ${res.pick.selected_player_name}`);
}

async function simUntilUser() {
  await api.post('/api/pick/sim-until-user');
  await reloadSessionAndRender();
  toast('Sim complete.');
}

function renderSimRoundSelect() {
  const sel = document.getElementById('sim-round-select');
  if (!sel) return;
  const currentRound = state.session?.current_pick?.round ?? 1;
  const totalRounds = state.board.length ? Math.max(...state.board.map(p => p.round)) : 7;
  const prev = parseInt(sel.value, 10);
  sel.innerHTML = '';
  for (let r = currentRound + 1; r <= totalRounds; r++) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = `Round ${r}`;
    if (r === prev) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.disabled = currentRound >= totalRounds;
  const btn = sel.nextElementSibling;
  if (btn) btn.disabled = sel.disabled;
}

async function promptSimUntilRound() {
  const sel = document.getElementById('sim-round-select');
  const r = sel ? parseInt(sel.value, 10) : NaN;
  if (!r || isNaN(r)) return;
  await api.post('/api/pick/sim-until-round', { round: r });
  await reloadSessionAndRender();
}

async function makeUserPick(playerId) {
  const c = state.session.current_pick;
  if (!c || c.current_team !== state.userTeam) return toast("Not your pick.");
  const res = await api.post('/api/pick/make', { player_id: playerId });
  if (!res.ok) return toast('Pick failed: ' + res.error);
  await reloadSessionAndRender();
  toast('Pick submitted.');
}

function enterForcePickMode() {
  const c = state.session.current_pick;
  if (!c) return toast('Draft complete.');
  if (c.current_team === state.userTeam) return toast('Use the public board to draft your own pick.');
  state.forcePickMode = true;
  renderPublicBoard();
  toast(`Force-pick mode: click a player to draft for the ${c.current_team}.`);
}

async function forceMakePick(playerId) {
  const c = state.session.current_pick;
  if (!c) return toast('Draft complete.');
  const res = await api.post('/api/pick/force-make', { player_id: playerId });
  if (!res.ok) return toast('Pick failed: ' + res.error);
  state.forcePickMode = false;
  await reloadSessionAndRender();
  toast(`Drafted for ${res.drafted_for || c.current_team}.`);
}

async function reloadSessionAndRender() {
  const [s, b, pub] = await Promise.all([
    api.get('/api/session'),
    api.get('/api/board'),
    api.get('/api/big-board/public'),
  ]);
  state.session = s.session;
  state.board = b.picks;
  state.publicBoard = pub.players;
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
  // Combined trade hub modal — incoming trade-up offers on top, manual
  // trade-up offer form on the bottom. Only meaningful when user is on
  // the clock; for AI-on-clock the header button is hidden and the AI
  // override section has a dedicated "Trade Up to This Pick" button.
  const res = await api.get('/api/trade/down-offers').catch(() => ({ ok: false }));
  const offers = (res.ok && res.offers) || [];
  const offersBlock = offers.length
    ? renderOffersTable(offers)
    : '<div class="text-sm text-slate-400">No incoming trade-up offers right now. <span class="text-slate-500">(AI trade logic is still a placeholder.)</span></div>';
  const myUnpickedPicks = state.board.filter(p => p.current_team === state.userTeam && !p.selected_player_id);
  const targets = state.board.filter(p => p.current_team !== state.userTeam && !p.selected_player_id).slice(0, 64);
  const targetOpts = targets.map(p =>
    `<option value="${p.overall}">R${p.round}.${p.pick_in_round} · ${escapeHtml(p.current_team)} (overall ${p.overall})</option>`
  ).join('');
  const offerCheckboxes = myUnpickedPicks.map(p => `
    <label class="flex items-center gap-2 text-sm py-1">
      <input type="checkbox" class="trade-up-offer" value="${p.overall}">
      <span>R${p.round}.${p.pick_in_round} (overall ${p.overall})</span>
    </label>
  `).join('');
  const body = `
    <div class="space-y-5">
      <div>
        <div class="card-eyebrow mb-2">Incoming Offers</div>
        ${offersBlock}
      </div>
      <div class="border-t border-ink-700 pt-4">
        <div class="card-eyebrow mb-2">Offer Trade Up</div>
        <div class="space-y-2">
          <div>
            <label class="text-xs uppercase text-slate-400">Target Pick</label>
            <select id="trade-up-target" class="mt-1 w-full rounded border border-ink-600 bg-ink-800 px-2 py-1 text-sm">${targetOpts}</select>
          </div>
          <div>
            <label class="text-xs uppercase text-slate-400">Picks You Offer</label>
            <div class="mt-1 max-h-40 overflow-y-auto pretty-scroll border border-ink-700 rounded p-2">${offerCheckboxes || '<div class="text-xs text-slate-500">No picks left to offer.</div>'}</div>
          </div>
          <button id="submit-trade-up" class="primary-btn w-full">Submit Offer</button>
          <div id="trade-up-result" class="text-sm text-slate-400"></div>
        </div>
      </div>
    </div>
  `;
  openModal('Trade Hub', 'Review incoming offers or propose a trade up', body);
  const submitBtn = document.getElementById('submit-trade-up');
  if (submitBtn) submitBtn.addEventListener('click', submitTradeUp);
}

async function submitTradeUp() {
  const target = parseInt(document.getElementById('trade-up-target').value, 10);
  const offered = Array.from(document.querySelectorAll('.trade-up-offer:checked')).map(c => parseInt(c.value, 10));
  const result = document.getElementById('trade-up-result');
  if (!offered.length) { result.textContent = 'Select at least one pick to offer.'; return; }
  const res = await api.post('/api/trade/up', { target_overall: target, offered_overalls: offered });
  if (!res.ok) { result.textContent = 'Error: ' + res.error; return; }
  if (res.decision.accepted) {
    result.innerHTML = '<span class="text-emerald-400">Offer accepted!</span> Refreshing…';
    await reloadSessionAndRender();
    setTimeout(closeModal, 800);
  } else {
    result.textContent = 'Offer refused: ' + (res.decision.reason || 'no reason given');
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

function openFullBoard() {
  const html = `<div class="full-board pretty-scroll">${state.board.map(renderPickCell).join('')}</div>`;
  document.getElementById('modal-root').classList.add('full-board-modal');
  openModal('Full Draft Order', `${state.session.picks_made} of ${state.session.total_picks} picks made`, html);
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

function closeModal() {
  document.getElementById('modal-root').classList.add('hidden');
  document.getElementById('modal-root').classList.remove('full-board-modal');
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

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
