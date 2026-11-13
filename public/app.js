'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICONS = {
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  off: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  deco: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="5"/><circle cx="12" cy="16.5" r="0.8"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>',
  laptop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  tv: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8"/></svg>',
  wired: '<svg viewBox="0 0 24 24"><path d="M9 3v4M15 3v4M7 7h10v5a5 5 0 0 1-10 0zM12 17v4"/></svg>',
  device: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/></svg>',
};

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Deco-Local': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status === 401 && data.code === 'auth') {
    showLogin();
    throw new Error('Please log in again.');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- UI helpers ----------

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), bad ? 5000 : 2600);
}

function openDialog(html, onSubmit) {
  const dlg = $('#dialog');
  const form = $('#dialog-form');
  form.innerHTML = html;
  return new Promise((resolve) => {
    const finish = async (e) => {
      const action = e.submitter?.value;
      if (action !== 'ok') return; // cancel closes via method=dialog
      e.preventDefault();
      if (onSubmit) {
        const btn = e.submitter;
        btn.disabled = true;
        try {
          const keepOpen = await onSubmit(new FormData(form));
          if (keepOpen === false) return;
        } catch (err) {
          toast(err.message, true);
          return;
        } finally {
          btn.disabled = false;
        }
      }
      dlg.close('ok');
    };
    form.onsubmit = finish;
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.showModal();
  });
}

function confirmDialog(title, text, okLabel = 'Continue', danger = false) {
  return openDialog(`
    <h3>${esc(title)}</h3>
    <p class="muted">${esc(text)}</p>
    <div class="dialog-actions">
      <button class="btn" value="cancel">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(okLabel)}</button>
    </div>`);
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

function secret(value) {
  if (!value) return '<span class="muted">None</span>';
  return `<span class="secret" data-secret="${esc(value)}"><span class="mono">••••••••</span>
    <button type="button" class="icon-btn" data-act="reveal">Show</button>
    <button type="button" class="icon-btn" data-act="copy">Copy</button></span>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.secret .icon-btn');
  if (!btn) return;
  const wrap = btn.closest('.secret');
  const value = wrap.dataset.secret;
  if (btn.dataset.act === 'copy') {
    copyText(value).then(() => toast('Copied'));
  } else {
    const span = wrap.querySelector('.mono');
    const shown = btn.textContent === 'Hide';
    span.textContent = shown ? '••••••••' : value;
    btn.textContent = shown ? 'Show' : 'Hide';
  }
});

const pct = (v) => (v === undefined || v === null || isNaN(v) ? null : Math.round(Number(v) * (Number(v) <= 1 ? 100 : 1)));

function speed(kbps) {
  if (!kbps) return '0 KB/s';
  return kbps < 1024 ? `${Math.round(kbps)} KB/s` : `${(kbps / 1024).toFixed(1)} MB/s`;
}

function connLabel(c) {
  if (!c) return '';
  const s = String(c).toLowerCase();
  if (s.includes('wired') || s === 'ethernet') return 'Wired';
  if (s.includes('2_4') || s.includes('2.4')) return '2.4 GHz';
  if (s.includes('6')) return '6 GHz';
  if (s.includes('5')) return '5 GHz';
  return c;
}

function clientIcon(c) {
  const t = String(c.type || '').toLowerCase();
  if (connLabel(c.connection) === 'Wired') return ICONS.wired;
  if (/phone|mobile|tablet|pad/.test(t)) return ICONS.phone;
  if (/pc|laptop|computer|notebook/.test(t)) return ICONS.laptop;
  if (/tv|media|stb|console/.test(t)) return ICONS.tv;
  return ICONS.device;
}

const loadingHtml = '<div class="loading"><div class="spinner"></div>Loading…</div>';
const errorHtml = (msg) => `<div class="notice warn">${esc(msg)}</div>`;

// ---------- Router ----------

const state = { tab: 'overview', timer: null, clientFilter: 'all', clientSearch: '' };

const VIEWS = {
  overview: { title: 'Overview', render: renderOverview, refreshMs: 10000 },
  decos: { title: 'Decos', render: renderDecos },
  clients: { title: 'Clients', render: renderClients, refreshMs: 10000 },
  wifi: { title: 'Wi-Fi', render: renderWifi },
  more: { title: 'More', render: renderMore },
};

function setActions(html) {
  $('#view-actions').innerHTML = html;
}

async function go(tab, { quiet = false } = {}) {
  state.tab = tab;
  clearTimeout(state.timer);
  const v = VIEWS[tab];
  $('#view-title').textContent = v.title;
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (!quiet) {
    setActions('');
    $('#view').innerHTML = loadingHtml;
    try {
      history.replaceState(null, '', '#' + tab);
    } catch {}
  }
  try {
    await v.render({ quiet });
  } catch (err) {
    if (state.tab === tab && !quiet) $('#view').innerHTML = errorHtml(err.message);
  }
  if (v.refreshMs && state.tab === tab) scheduleRefresh(tab, v.refreshMs);
}

function scheduleRefresh(tab, ms) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    if (state.tab !== tab) return;
    // Don't redraw under an open dialog or while the page is in the background.
    if (document.hidden || $('#dialog').open) scheduleRefresh(tab, ms);
    else go(tab, { quiet: true });
  }, ms);
}

$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) go(b.dataset.tab);
});

// ---------- Overview ----------

async function renderOverview() {
  const o = await api('GET', '/api/overview');
  if (state.tab !== 'overview') return;
  setActions('<button class="icon-btn" id="refresh">Refresh</button>');
  $('#refresh').onclick = () => go('overview');

  const status = String(o.internet.status || '').toLowerCase();
  const cls = status === 'online' ? 'ok' : status === 'offline' ? 'bad' : 'unknown';
  const statusText = status === 'online' ? 'Internet is online' : status === 'offline' ? 'Internet is offline' : 'Internet status unknown';
  const cpu = pct(o.performance.cpu);
  const mem = pct(o.performance.mem);
  const wan = o.wan;

  $('#view').innerHTML = `
    <div class="card">
      <div class="hero">
        <div class="hero-dot ${cls}">${cls === 'bad' ? ICONS.off : ICONS.globe}</div>
        <div>
          <div class="hero-title">${statusText}</div>
          <div class="card-sub">${status === 'offline' ? 'You can still manage your Decos from here.' : esc(o.main ? `${o.main.name} · ${o.main.model}` : '')}</div>
        </div>
      </div>
      ${wan.error ? '' : `<dl class="kv">
        <dt>Connection type</dt><dd>${esc(prettyDial(wan.dialType))}</dd>
        <dt>WAN IP</dt><dd class="mono">${esc(wan.ip || '-')}</dd>
        <dt>Gateway</dt><dd class="mono">${esc(wan.gateway || '-')}</dd>
        <dt>DNS</dt><dd class="mono">${esc([wan.dns1, wan.dns2].filter((x) => x && x !== '0.0.0.0').join(', ') || '-')}</dd>
        ${o.lan.ip ? `<dt>LAN IP</dt><dd class="mono">${esc(o.lan.ip)}</dd>` : ''}
      </dl>`}
    </div>
    <div class="tiles">
      <div class="tile"><div class="tile-value">${o.decos.online}<span class="muted" style="font-size:16px"> / ${o.decos.total}</span></div><div class="tile-label">Decos online</div></div>
      <div class="tile"><div class="tile-value">${o.clients.total}</div><div class="tile-label">Clients online</div></div>
      <div class="tile"><div class="tile-value">${cpu ?? '–'}${cpu !== null ? '%' : ''}</div><div class="tile-label">CPU (main Deco)</div>${cpu !== null ? `<div class="meter"><i style="width:${cpu}%"></i></div>` : ''}</div>
      <div class="tile"><div class="tile-value">${mem ?? '–'}${mem !== null ? '%' : ''}</div><div class="tile-label">Memory (main Deco)</div>${mem !== null ? `<div class="meter"><i style="width:${mem}%"></i></div>` : ''}</div>
    </div>
    ${o.main ? `
    <h2>Main Deco</h2>
    <div class="card">
      <div class="card-head">
        <div><div class="card-title">${esc(o.main.name)}</div><div class="card-sub">${esc(o.main.model)} · ${esc(o.main.ip || '')}</div></div>
        <span class="badge accent">Main</span>
      </div>
      <dl class="kv">
        <dt>Firmware</dt><dd>${esc(o.main.firmware || '-')}</dd>
        <dt>Hardware</dt><dd>${esc(o.main.hardware || '-')}</dd>
        <dt>MAC</dt><dd class="mono">${esc(o.main.mac || '-')}</dd>
      </dl>
    </div>` : ''}`;
}

function prettyDial(t) {
  return { dynamic_ip: 'Dynamic IP', static_ip: 'Static IP', pppoe: 'PPPoE', l2tp: 'L2TP', pptp: 'PPTP', dslite: 'DS-Lite', lte: 'Mobile' }[t] || t || '-';
}

// ---------- Decos ----------

async function renderDecos() {
  const { decos } = await api('GET', '/api/decos');
  if (state.tab !== 'decos') return;
  setActions(decos.length > 1 ? '<button class="btn small danger" id="reboot-all">Reboot all</button>' : '');
  if ($('#reboot-all')) {
    $('#reboot-all').onclick = () => reboot(decos.map((d) => d.mac), 'all Decos');
  }
  if (!decos.length) {
    $('#view').innerHTML = '<div class="empty">No Decos found.</div>';
    return;
  }
  const sorted = [...decos].sort((a, b) => (a.role === 'master' ? -1 : b.role === 'master' ? 1 : a.name.localeCompare(b.name)));
  $('#view').innerHTML = sorted
    .map((d) => {
      const signal = d.signal && typeof d.signal === 'object'
        ? Object.entries(d.signal).map(([k, v]) => `${connLabel(k)}: ${v}`).join(', ')
        : '';
      const backhaul = (Array.isArray(d.connection) ? d.connection : [d.connection]).filter(Boolean).map(connLabel).join(', ');
      return `
      <div class="card">
        <div class="card-head">
          <div><div class="card-title">${esc(d.name)}</div><div class="card-sub">${esc(d.model || '')}${d.ip ? ' · ' + esc(d.ip) : ''}</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            ${d.role === 'master' ? '<span class="badge accent">Main</span>' : ''}
            <span class="badge ${d.online ? 'ok' : 'bad'}">${d.online ? 'Online' : 'Offline'}</span>
          </div>
        </div>
        <dl class="kv">
          ${backhaul && d.role !== 'master' ? `<dt>Backhaul</dt><dd>${esc(backhaul)}</dd>` : ''}
          ${signal && d.role !== 'master' ? `<dt>Signal</dt><dd>${esc(signal)}</dd>` : ''}
          <dt>Firmware</dt><dd>${esc(d.firmware || '-')}</dd>
          <dt>Hardware</dt><dd>${esc(d.hardware || '-')}</dd>
          <dt>MAC</dt><dd class="mono">${esc(d.mac)}</dd>
        </dl>
        <div class="card-actions">
          <button class="btn small" data-clients="${esc(d.mac)}">Clients</button>
          <button class="btn small danger" data-reboot="${esc(d.mac)}" data-name="${esc(d.name)}">Reboot</button>
        </div>
      </div>`;
    })
    .join('');
  $$('[data-reboot]').forEach((b) => (b.onclick = () => reboot([b.dataset.reboot], b.dataset.name)));
  $$('[data-clients]').forEach(
    (b) =>
      (b.onclick = () => {
        state.clientFilter = 'deco:' + b.dataset.clients;
        go('clients');
      })
  );
}

async function reboot(macs, label) {
  const ok = await confirmDialog(
    `Reboot ${label}?`,
    'Devices connected through it will lose their connection for a couple of minutes.',
    'Reboot',
    true
  );
  if (!ok) return;
  try {
    await api('POST', '/api/reboot', { macs });
    toast(`Rebooting ${label}…`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- Clients ----------

async function renderClients({ quiet }) {
  const { clients } = await api('GET', '/api/clients');
  if (state.tab !== 'clients') return;
  state.clients = clients;
  if (!quiet || !$('#client-list')) {
    setActions('<button class="icon-btn" id="refresh">Refresh</button>');
    $('#refresh').onclick = () => go('clients');
    const decos = [...new Map(clients.filter((c) => c.deco).map((c) => [c.deco.mac, c.deco])).values()];
    $('#view').innerHTML = `
      <div class="toolbar"><input id="client-search" type="search" placeholder="Search name, IP or MAC" value="${esc(state.clientSearch)}" /></div>
      <div class="toolbar chips" id="client-chips">
        ${[['all', 'All'], ['wifi', 'Wi-Fi'], ['wired', 'Wired'], ['offline', 'Offline']]
          .map(([k, l]) => `<button class="chip" data-f="${k}">${l}</button>`)
          .join('')}
        ${decos.map((d) => `<button class="chip" data-f="deco:${esc(d.mac)}">${esc(d.name)}</button>`).join('')}
      </div>
      <div id="client-list"></div>`;
    $('#client-search').oninput = (e) => {
      state.clientSearch = e.target.value;
      drawClients();
    };
    $('#client-chips').onclick = (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      state.clientFilter = c.dataset.f;
      drawClients();
    };
  }
  drawClients();
}

function drawClients() {
  $$('#client-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.f === state.clientFilter));
  const q = state.clientSearch.trim().toLowerCase();
  const f = state.clientFilter;
  const list = state.clients
    .filter((c) => {
      if (f === 'offline') return !c.online;
      if (!c.online && f !== 'all') return false;
      if (f === 'wired') return connLabel(c.connection) === 'Wired';
      if (f === 'wifi') return connLabel(c.connection) !== 'Wired';
      if (f.startsWith('deco:')) return c.deco && c.deco.mac === f.slice(5);
      return true;
    })
    .filter((c) => !q || [c.name, c.ip, c.mac].some((x) => String(x || '').toLowerCase().includes(q)))
    .sort((a, b) => b.online - a.online || b.downKBps + b.upKBps - (a.downKBps + a.upKBps) || a.name.localeCompare(b.name));

  $('#client-list').innerHTML = list.length
    ? `<div class="list">${list
        .map(
          (c) => `
      <div class="row clickable ${c.online ? '' : 'offline'}" data-mac="${esc(c.mac)}">
        <div class="row-icon">${clientIcon(c)}</div>
        <div class="row-main">
          <div class="row-title">${esc(c.name)}</div>
          <div class="row-sub">${esc([c.ip, connLabel(c.connection), c.deco && c.deco.name].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="row-end">${c.online ? `↓ ${speed(c.downKBps)}<br>↑ ${speed(c.upKBps)}` : 'Offline'}</div>
      </div>`
        )
        .join('')}</div>`
    : '<div class="empty">No clients match.</div>';
  $$('#client-list .row').forEach((r) => (r.onclick = () => clientDetails(state.clients.find((c) => c.mac === r.dataset.mac))));
}

function clientDetails(c) {
  if (!c) return;
  openDialog(`
    <h3>${esc(c.name)}</h3>
    <dl class="kv">
      <dt>Status</dt><dd>${c.online ? 'Online' : 'Offline'}</dd>
      <dt>IP</dt><dd class="mono">${esc(c.ip || '-')}</dd>
      <dt>MAC</dt><dd class="mono">${esc(c.mac)}</dd>
      <dt>Connection</dt><dd>${esc(connLabel(c.connection) || '-')}</dd>
      ${c.deco ? `<dt>Connected to</dt><dd>${esc(c.deco.name)}</dd>` : ''}
      ${c.type ? `<dt>Type</dt><dd>${esc(c.type)}</dd>` : ''}
      <dt>Download</dt><dd>${speed(c.downKBps)}</dd>
      <dt>Upload</dt><dd>${speed(c.upKBps)}</dd>
    </dl>
    <details style="margin-top:14px"><summary class="muted">Raw data</summary><pre class="output">${esc(JSON.stringify(c.raw, null, 2))}</pre></details>
    <div class="dialog-actions"><button class="btn" value="cancel">Close</button></div>`);
}

// ---------- Wi-Fi ----------

async function renderWifi() {
  const w = await api('GET', '/api/wifi');
  if (state.tab !== 'wifi') return;
  setActions('');
  const netCard = (band, kind, n) =>
    n
      ? `<div class="card">
      <div class="card-head">
        <div><div class="card-title">${esc(n.ssid || '(no name)')}</div><div class="card-sub">${kind === 'guest' ? 'Guest network' : 'Main network'} · ${esc(band.label)}</div></div>
        <span class="badge ${n.enable ? 'ok' : 'bad'}">${n.enable ? 'On' : 'Off'}</span>
      </div>
      <dl class="kv">
        <dt>Password</dt><dd>${secret(n.password)}</dd>
        ${kind === 'host' && n.channel !== undefined ? `<dt>Channel</dt><dd>${esc(n.channel === 0 || n.channel === 'auto' ? 'Auto' : n.channel)}${n.channelWidth ? ' · ' + esc(n.channelWidth) : ''}</dd>` : ''}
        ${kind === 'host' && n.mode ? `<dt>Mode</dt><dd>${esc(n.mode)}</dd>` : ''}
      </dl>
      <div class="card-actions"><button class="btn small" data-edit="${band.key}:${kind}">Edit</button></div>
    </div>`
      : '';

  const power = w.power;
  const powerBands = power ? ['band2_4', 'band5_1', 'band5_2', 'band6'].filter((k) => power[k]) : [];
  const bandLabel = { band2_4: '2.4 GHz', band5_1: '5 GHz', band5_2: '5 GHz-2', band6: '6 GHz' };

  $('#view').innerHTML = `
    ${w.bands.map((b) => `<h2>${esc(b.label)}</h2>${netCard(b, 'host', b.host)}${netCard(b, 'guest', b.guest)}`).join('')}
    ${powerBands.length ? `
      <h2>Transmit power</h2>
      <div class="list" id="power-list">
        ${powerBands
          .map(
            (k) => `<div class="setting"><span>${bandLabel[k]}</span>
          <select data-power="${k}">${['low', 'middle', 'high'].map((l) => `<option value="${l}" ${power[k] === l ? 'selected' : ''}>${l[0].toUpperCase() + l.slice(1)}</option>`).join('')}</select></div>`
          )
          .join('')}
      </div>` : ''}`;

  $$('[data-edit]').forEach(
    (b) =>
      (b.onclick = () => {
        const [key, kind] = b.dataset.edit.split(':');
        const band = w.bands.find((x) => x.key === key);
        editNetwork(band, kind, band[kind]);
      })
  );
  $$('[data-power]').forEach(
    (s) =>
      (s.onchange = async () => {
        s.disabled = true;
        try {
          await api('POST', '/api/power', { [s.dataset.power]: s.value });
          toast('Transmit power updated');
        } catch (err) {
          toast(err.message, true);
          go('wifi');
        } finally {
          s.disabled = false;
        }
      })
  );
}

function editNetwork(band, kind, n) {
  openDialog(
    `
    <h3>Edit ${kind === 'guest' ? 'guest' : 'main'} network · ${esc(band.label)}</h3>
    <div class="notice">Experimental. The Deco's own local web page only shows these settings, so some firmware may reject the change. Nothing changes unless the Deco accepts it. If you're connected over this Wi-Fi, you'll be disconnected when it applies.</div>
    <label><span>Network name (SSID)</span><input name="ssid" value="${esc(n.ssid)}" maxlength="32" required /></label>
    <label><span>Password</span><input name="password" value="${esc(n.password)}" minlength="8" maxlength="63" /></label>
    <div class="setting" style="padding:8px 0;border:0"><span>Enabled</span><label class="switch" style="margin:0"><input type="checkbox" name="enable" ${n.enable ? 'checked' : ''} /><span></span></label></div>
    <div class="dialog-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div>`,
    async (fd) => {
      const body = { band: band.key, network: kind };
      const ssid = fd.get('ssid');
      const password = fd.get('password');
      const enable = fd.get('enable') === 'on';
      if (ssid !== n.ssid) body.ssid = ssid;
      if (password !== n.password) body.password = password;
      if (enable !== n.enable) body.enable = enable;
      if (Object.keys(body).length === 2) return true;
      await api('POST', '/api/wifi', body);
      toast('Wi-Fi settings saved');
      setTimeout(() => go('wifi'), 400);
      return true;
    }
  );
}

// ---------- More ----------

const KNOWN_ENDPOINTS = [
  'admin/device?form=device_list',
  'admin/client?form=client_list',
  'admin/network?form=internet',
  'admin/network?form=wan_ipv4',
  'admin/network?form=lan_ip',
  'admin/network?form=ipv6',
  'admin/network?form=performance',
  'admin/wireless?form=wlan',
  'admin/wireless?form=power',
  'admin/device?form=timesetting',
  'admin/network?form=igmp_setting',
  'admin/network?form=dhcp_dial',
  'admin/network?form=wifi_network',
  'admin/network?form=erp_setting',
  'admin/network?form=flow_control',
  'admin/network?form=flow_control_lan_wan',
  'admin/network?form=fast_xmit_setting',
  'admin/cloud?form=firmware_status',
  'admin/log_export?form=feedback_log',
  'admin/log_export?form=types',
  'admin/syslog?form=mail',
];

async function renderMore() {
  const [{ toggles }, sys] = await Promise.all([api('GET', '/api/toggles'), api('GET', '/api/system')]);
  if (state.tab !== 'more') return;
  setActions('<button class="btn small" id="logout">Log out</button>');
  $('#logout').onclick = async () => {
    await api('POST', '/api/logout').catch(() => {});
    showLogin();
  };
  const t = sys.time || {};
  $('#view').innerHTML = `
    <h2>System parameters</h2>
    ${toggles.length ? `<div class="list">${toggles
      .map(
        (x, i) => `<div class="setting"><span>${esc(x.label)}</span>
        <label class="switch" style="margin:0"><input type="checkbox" data-toggle="${i}" ${x.value ? 'checked' : ''} /><span></span></label></div>`
      )
      .join('')}</div>` : '<div class="card muted">No adjustable parameters reported by this Deco.</div>'}

    <h2>Time</h2>
    <div class="card">
      ${t.error ? `<span class="muted">${esc(t.error)}</span>` : `<dl class="kv" style="margin:0">
        ${t.time || t.date ? `<dt>Device time</dt><dd>${esc([t.date, t.time].filter(Boolean).join(' '))}</dd>` : ''}
        ${t.timezone ? `<dt>Time zone</dt><dd>${esc(t.timezone)}</dd>` : ''}
        ${t.tz_region ? `<dt>Region</dt><dd>${esc(t.tz_region)}</dd>` : ''}
      </dl>`}
    </div>

    <h2>Restart</h2>
    <div class="list">${(sys.decos || [])
      .map(
        (d) => `<div class="setting"><span>${esc(d.name)} <span class="muted">· ${esc(d.model || '')}</span></span>
        <button class="btn small danger" data-reboot="${esc(d.mac)}" data-name="${esc(d.name)}">Reboot</button></div>`
      )
      .join('')}</div>

    <h2>System log</h2>
    <div class="card">
      <button class="btn small" id="load-logs">Load log</button>
      <div id="logs"></div>
    </div>

    <h2>API console</h2>
    <div class="card">
      <p class="muted" style="margin:0 0 4px">Call any endpoint on the Deco directly. Use <b>read</b> to explore. Writes change your network.</p>
      <label><span>Endpoint</span><input id="raw-path" list="raw-endpoints" value="admin/device?form=device_list" spellcheck="false" autocapitalize="off" class="mono" /></label>
      <datalist id="raw-endpoints">${KNOWN_ENDPOINTS.map((e) => `<option value="${e}">`).join('')}</datalist>
      <label><span>Operation</span><input id="raw-op" value="read" list="raw-ops" class="mono" /></label>
      <datalist id="raw-ops"><option value="read"><option value="write"><option value="load"></datalist>
      <label><span>Params (JSON, optional)</span><textarea id="raw-params" rows="3" class="mono" placeholder='{"device_mac":"default"}'></textarea></label>
      <button class="btn primary" id="raw-send">Send</button>
      <pre class="output" id="raw-out" hidden></pre>
    </div>
    <p class="muted" style="text-align:center;font-size:12px;margin-top:24px">Connected to ${esc(window.__host || '')}</p>`;

  $$('[data-toggle]').forEach((input) => {
    input.onchange = async () => {
      const x = toggles[Number(input.dataset.toggle)];
      const value = input.checked;
      if (!value && x.warn) {
        const ok = await confirmDialog(`Turn off ${x.label}?`, x.warn, 'Turn off', true);
        if (!ok) {
          input.checked = true;
          return;
        }
      } else if (value && x.warn && x.label === 'Flow Control') {
        const ok = await confirmDialog(`Turn on ${x.label}?`, x.warn, 'Turn on');
        if (!ok) {
          input.checked = false;
          return;
        }
      }
      input.disabled = true;
      try {
        await api('POST', '/api/toggles', { form: x.form, field: x.field, value });
        x.value = value;
        toast(`${x.label} ${value ? 'on' : 'off'}`);
      } catch (err) {
        input.checked = !value;
        toast(err.message, true);
      } finally {
        input.disabled = false;
      }
    };
  });
  $$('[data-reboot]').forEach((b) => (b.onclick = () => reboot([b.dataset.reboot], b.dataset.name)));

  $('#load-logs').onclick = async (e) => {
    e.target.disabled = true;
    $('#logs').innerHTML = loadingHtml;
    try {
      const { logs } = await api('GET', '/api/logs');
      $('#logs').innerHTML = logs.length
        ? `<div class="list" style="margin-top:12px;max-height:420px;overflow:auto">${logs
            .slice(-300)
            .reverse()
            .map((l) => `<div class="log-line">${esc(typeof l === 'string' ? l : [l.time, l.level, l.type, l.content].filter(Boolean).join('  '))}</div>`)
            .join('')}</div>`
        : '<p class="muted">The log is empty.</p>';
    } catch (err) {
      $('#logs').innerHTML = errorHtml(err.message);
    } finally {
      e.target.disabled = false;
    }
  };

  $('#raw-send').onclick = async (e) => {
    const out = $('#raw-out');
    let params;
    const txt = $('#raw-params').value.trim();
    if (txt) {
      try {
        params = JSON.parse(txt);
      } catch {
        toast('Params must be valid JSON', true);
        return;
      }
    }
    const operation = $('#raw-op').value.trim() || 'read';
    if (operation !== 'read' && operation !== 'load') {
      const ok = await confirmDialog('Send a non-read request?', `Operation "${operation}" can change your Deco's configuration.`, 'Send', true);
      if (!ok) return;
    }
    e.target.disabled = true;
    out.hidden = false;
    out.textContent = 'Sending…';
    try {
      const r = await api('POST', '/api/raw', { path: $('#raw-path').value.trim(), operation, params });
      out.textContent = JSON.stringify(r.result, null, 2);
    } catch (err) {
      out.textContent = 'Error: ' + err.message;
    } finally {
      e.target.disabled = false;
    }
  };
}

// ---------- Login / boot ----------

function showLogin(host) {
  clearTimeout(state.timer);
  $('#app').hidden = true;
  $('#login').hidden = false;
  if (host !== undefined) $('#login-host').value = host;
  $('#login-password').value = '';
  ($('#login-host').value ? $('#login-password') : $('#login-host')).focus();
}

function showApp(host) {
  window.__host = host;
  $('#login').hidden = true;
  $('#app').hidden = false;
  const tab = location.hash.slice(1);
  go(VIEWS[tab] ? tab : 'overview');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const err = $('#login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const host = $('#login-host').value.trim();
    const r = await api('POST', '/api/login', { host, password: $('#login-password').value });
    showApp(r.host);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log in';
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('#app').hidden && VIEWS[state.tab].refreshMs) go(state.tab, { quiet: true });
});

(async function boot() {
  try {
    const s = await api('GET', '/api/session');
    if (s.loggedIn) showApp(s.host);
    else showLogin(s.host);
  } catch {
    showLogin('');
  }
})();
