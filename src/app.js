// ── Lookup map for full node data (includes columns/rows) ────────
const nodeById = new Map(RAW.nodes.map(n => [n.id, n]));

// ── Adjacency index (undirected) ──────────────────────────────────
const adj = new Map();
RAW.nodes.forEach(n => adj.set(n.id, []));
RAW.edges.forEach(e => {
  adj.get(e.source)?.push({ peer: e.target, via: e.via });
  adj.get(e.target)?.push({ peer: e.source, via: e.via });
});

// ── Family color (hash-based HSL, consistent per family name) ─────
function familyColor(family) {
  let h = 0;
  for (const c of family) h = Math.imul(h, 31) + c.charCodeAt(0) | 0;
  return `hsl(${(h >>> 0) % 360},60%,58%)`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Info panel resize ────────────────────────────────────────────
{
  const infoDrag = document.getElementById('info-drag');
  let dragging = false, startY = 0, startH = 0;
  infoDrag.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = infoPanel.offsetHeight;
    infoDrag.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;  // drag up = taller panel
    const newH = Math.max(32, Math.min(startH + delta, window.innerHeight * 0.7));
    infoPanel.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    infoDrag.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── State ────────────────────────────────────────────────────────
const state = {
  mode: 'graph',
  focused: null,
  showIsolated: false,
  showOnlyChanged: false,
  exploreRoot: null,
  exploreHistory: [],
  searchTarget: null,  // { table, rowId } — set by search result click
};

// ── Diff state ────────────────────────────────────────────────────
const DIFF_COLORS = { added: '#3fb950', removed: '#f85149', changed: '#d29922' };
let diffData          = null;
let dataDiffData      = null;       // summary: { tables: {T: {ra,rr,rc}}, _pairs: [{from,to}] }
let dataDiffPairs     = [];         // active consecutive pairs for per-table fetching
let dataDiffTableCache = new Map(); // tableId -> full {rows_added, rows_removed, rows_changed}
let rowDiffState      = { diffs: {}, cols: [] };
let diffEdgeAddedKeys = new Set();

// ── Data View state ───────────────────────────────────────────────
let dvSim  = null;
let dvNode = null;

function getDiffClass(nodeId) {
  if (!diffData) return null;
  if (diffData.tables.added.includes(nodeId))   return 'added';
  if (diffData.tables.removed.includes(nodeId)) return 'removed';
  if (nodeId in diffData.tables.changed)         return 'changed';
  return null;
}

// ── DOM refs ─────────────────────────────────────────────────────
const infoPanel   = document.getElementById('info-panel');
const searchEl    = document.getElementById('search');
const breadcrumb  = document.getElementById('breadcrumb');
const statsEl     = document.getElementById('stats');
const tipEl       = document.getElementById('tooltip');
const exploreHint = document.getElementById('explore-hint');
const rightArea   = document.getElementById('right-area');
const contentEl   = document.getElementById('content');

const PLACEHOLDER = '<p class="placeholder">Click a node to see its connections</p>';

// ── SVG & zoom ───────────────────────────────────────────────────
const svgEl = document.getElementById('graph');
const svg   = d3.select(svgEl);
const g     = svg.append('g');

// Arrow markers (default grey + active orange-red)
const defs = svg.append('defs');
['arrow', 'arrow-active'].forEach((id, i) => {
  defs.append('marker')
    .attr('id', id)
    .attr('viewBox', '0 -4 8 8')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 5).attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4')
    .attr('fill', i === 0 ? '#30363d' : '#f78166');
});

const zoom = d3.zoom()
  .scaleExtent([0.05, 12])
  .on('zoom', ({ transform }) => {
    g.attr('transform', transform);
  });

svg.call(zoom).on('dblclick.zoom', null);
svg.on('click', e => { if (e.target === svgEl) clearFocus(); });

// ── Tooltip helpers ───────────────────────────────────────────────
svg.on('mousemove', e => {
  if (+tipEl.style.opacity) {
    tipEl.style.left = (e.clientX + 14) + 'px';
    tipEl.style.top  = (e.clientY + 10) + 'px';
  }
});
function showTip(e, html) {
  tipEl.innerHTML = html;
  tipEl.style.opacity = 1;
  tipEl.style.left = (e.clientX + 14) + 'px';
  tipEl.style.top  = (e.clientY + 10) + 'px';
}
function hideTip() { tipEl.style.opacity = 0; }

// ── Pill dimensions ───────────────────────────────────────────────
const PILL_H = 18;
const CHAR_W = 5.5; // approximate px per character at 9px font
const PILL_PAD = 8;
function pillW(id) { return id.length * CHAR_W + PILL_PAD * 2; }

// ── Simulation & selections ───────────────────────────────────────
let sim = null, linkSel = null, nodeSel = null;

function visibleNodes() {
  let nodes;
  if (state.mode === 'graph') {
    nodes = RAW.nodes.filter(n => n.connected || state.showIsolated);
  } else {
    if (!state.exploreRoot) return [];
    const ids = new Set([state.exploreRoot, ...(adj.get(state.exploreRoot) || []).map(c => c.peer)]);
    nodes = RAW.nodes.filter(n => ids.has(n.id));
  }
  if (state.mode === 'graph' && diffData && state.showOnlyChanged) {
    const changedIds = new Set([
      ...diffData.tables.added,
      ...diffData.tables.removed,
      ...Object.keys(diffData.tables.changed),
    ]);
    nodes = nodes.filter(n => changedIds.has(n.id));
  }
  return nodes;
}

function render() {
  if (sim) sim.stop();
  g.selectAll('*').remove();
  state.focused = null;

  const nodes = visibleNodes().map(n => ({ ...n }));
  const ids   = new Set(nodes.map(n => n.id));
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  const links = RAW.edges
    .filter(e => ids.has(e.source) && ids.has(e.target))
    .map(e => ({ source: nodeMap.get(e.source), target: nodeMap.get(e.target), via: e.via }));

  // Spread nodes in a circle for faster initial convergence
  const w = svgEl.clientWidth || 900;
  const h = svgEl.clientHeight || 600;
  const r0 = Math.min(w, h) * 0.35;
  nodes.forEach((d, i) => {
    const a = (2 * Math.PI * i) / nodes.length;
    d.x = w / 2 + r0 * Math.cos(a);
    d.y = h / 2 + r0 * Math.sin(a);
  });

  // Edges
  linkSel = g.append('g')
    .selectAll('line').data(links).join('line')
    .attr('class', 'edge')
    .attr('marker-end', 'url(#arrow)')
    .on('mouseenter', (e, d) => showTip(e,
      `<b>${d.source.id}</b> → <b>${d.target.id}</b><br><span style="color:#6e7681">via ${d.via}</span>`))
    .on('mouseleave', hideTip);
  linkSel.classed('edge-diff-added', d =>
    diffEdgeAddedKeys.has(`${d.source.id}|${d.target.id}|${d.via}`));

  // Nodes
  nodeSel = g.append('g')
    .selectAll('g').data(nodes, d => d.id).join('g')
    .attr('class', 'node')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('click',      (e, d) => { e.stopPropagation(); handleNodeClick(d); })
    .on('mouseenter', (e, d) => showTip(e,
      `<b>${d.id}</b><br><span style="color:#6e7681">${d.family} · ${(adj.get(d.id)||[]).length} connections</span>`))
    .on('mouseleave', hideTip);

  nodeSel.append('rect')
    .attr('width',  d => pillW(d.id))
    .attr('height', PILL_H)
    .attr('x', d => -pillW(d.id) / 2)
    .attr('y', -PILL_H / 2)
    .attr('rx', PILL_H / 2)
    .attr('fill', d => { const dc = getDiffClass(d.id); return dc ? DIFF_COLORS[dc] : familyColor(d.family); });
  nodeSel.append('text').attr('class', 'node-label').text(d => d.id);

  sim = d3.forceSimulation(nodes)
    .force('link',    d3.forceLink(links).id(d => d.id).distance(120).strength(0.4))
    .force('charge',  d3.forceManyBody().strength(-300))
    .force('center',  d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide(d => pillW(d.id) / 2 + 4))
    .on('tick', () => {
      linkSel.each(function(d) {
        const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        // Approximate rect-edge distance along this direction
        const absCos = Math.abs(dx / len), absSin = Math.abs(dy / len);
        const pad = (pillW(d.target.id) / 2) * absCos + (PILL_H / 2) * absSin + 4;
        d3.select(this)
          .attr('x1', d.source.x).attr('y1', d.source.y)
          .attr('x2', d.target.x - dx / len * pad)
          .attr('y2', d.target.y - dy / len * pad);
      });
      nodeSel.attr('transform', d => `translate(${d.x},${d.y})`);
    });

  statsEl.textContent = `${nodes.length} nodes · ${links.length} edges`;
  refreshBreadcrumb();
}

// ── Interaction ───────────────────────────────────────────────────
function handleNodeClick(d) {
  if (state.mode === 'explore') { navigateTo(d.id); return; }
  state.focused === d.id ? clearFocus() : focusNode(d.id);
}

function focusNode(id) {
  state.focused = id;
  setTableListActive(id);
  const nbrs = new Set([id, ...(adj.get(id) || []).map(c => c.peer)]);
  nodeSel
    .classed('node-focused', d => d.id === id)
    .classed('node-dimmed',  d => !nbrs.has(d.id));
  linkSel
    .classed('edge-active', d => d.source.id === id || d.target.id === id)
    .classed('edge-dimmed', d => d.source.id !== id && d.target.id !== id)
    .attr('marker-end', d =>
      (d.source.id === id || d.target.id === id) ? 'url(#arrow-active)' : 'url(#arrow)');
  updateInfoPanel(id);
  openDataPanel(id);
}

function clearFocus() {
  state.focused = null;
  setTableListActive(null);
  nodeSel?.classed('node-focused', false).classed('node-dimmed', false);
  linkSel?.classed('edge-active', false).classed('edge-dimmed', false)
          .attr('marker-end', 'url(#arrow)');
  infoPanel.innerHTML = PLACEHOLDER;
  closeDpPanel();
}

// ── Explore navigation ────────────────────────────────────────────
function navigateTo(id) {
  if (state.exploreRoot) state.exploreHistory.push(state.exploreRoot);
  state.exploreRoot = id;
  setTableListActive(id);
  exploreHint.style.display = 'none';
  render();
  // Delay focus so nodeSel is populated after render
  requestAnimationFrame(() => focusNode(id));
}

// ── Info panel ────────────────────────────────────────────────────
function updateInfoPanel(id) {
  const conns = adj.get(id) || [];
  const node  = RAW.nodes.find(n => n.id === id);
  let html = `<div class="info-name">${id}</div>
    <div class="info-meta">${node?.family || ''} · ${conns.length} connection${conns.length !== 1 ? 's' : ''}</div>`;

  if (conns.length) {
    html += '<ul class="conn-list">' + conns.map(({ peer, via }) =>
      `<li data-peer="${peer}">
        <span class="peer-name">${peer}</span>
        <span class="via-col">via ${via}</span>
      </li>`
    ).join('') + '</ul>';
  }
  infoPanel.innerHTML = html;

  infoPanel.querySelectorAll('[data-peer]').forEach(el => {
    el.addEventListener('click', () => {
      const peerId = el.dataset.peer;
      if (state.mode === 'data')    { dvNavigateTo(peerId); return; }
      if (state.mode === 'explore') { navigateTo(peerId); return; }
      focusNode(peerId);
      const target = nodeSel?.data().find(d => d.id === peerId);
      if (target?.x != null) zoomTo(target);
    });
  });
}

function zoomTo(node) {
  const w = svgEl.clientWidth, h = svgEl.clientHeight;
  svg.transition().duration(500).call(
    zoom.transform,
    d3.zoomIdentity.translate(w / 2, h / 2).scale(3).translate(-node.x, -node.y)
  );
}

// ── Data View: mini-graph helpers ─────────────────────────────────
function computeMiniGraphData(id) {
  // Parents: nodes that reference this table (edge.target === id)
  const parentIds  = new Set(RAW.edges.filter(e => e.target === id).map(e => e.source));
  // L1 children: tables this node's FK columns point to (edge.source === id)
  const childL1Ids = new Set(RAW.edges.filter(e => e.source === id).map(e => e.target));
  // L2 children: outgoing from L1, capped to avoid clutter
  const childL2Ids = new Set();
  const MAX_L2 = 20;
  outer: for (const cid of childL1Ids) {
    for (const e of RAW.edges) {
      if (e.source === cid && e.target !== id &&
          !parentIds.has(e.target) && !childL1Ids.has(e.target)) {
        childL2Ids.add(e.target);
        if (childL2Ids.size >= MAX_L2) break outer;
      }
    }
  }
  const allIds  = new Set([id, ...parentIds, ...childL1Ids, ...childL2Ids]);
  const nodes   = RAW.nodes.filter(n => allIds.has(n.id)).map(n => ({ ...n }));
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const edges   = RAW.edges
    .filter(e => allIds.has(e.source) && allIds.has(e.target))
    .map(e => ({ source: nodeMap.get(e.source), target: nodeMap.get(e.target), via: e.via }));
  return { nodes, edges, parentIds, childL1Ids, childL2Ids };
}

function renderMiniGraph(id) {
  if (dvSim) { dvSim.stop(); dvSim = null; }
  const dvSvgEl = document.getElementById('dv-graph');
  const dvSvg   = d3.select(dvSvgEl);
  dvSvg.selectAll('*').remove();
  if (!id || !nodeById.has(id)) return;

  const W = dvSvgEl.clientWidth  || 600;
  const H = dvSvgEl.clientHeight || 190;
  const PITCH = 26;   // vertical gap between nodes in a column
  const PAD_X = 14;   // horizontal padding from svg edges
  const MAX_PER_COL = Math.max(3, Math.floor((H - PITCH) / PITCH));

  const { nodes, edges, parentIds, childL1Ids, childL2Ids } = computeMiniGraphData(id);

  // Split nodes into ordered columns: parents | focus | L1 | L2
  function sortedLayer(ids) {
    return [...ids].filter(nid => nodes.find(n => n.id === nid)).sort()
      .map(nid => nodes.find(n => n.id === nid));
  }
  const parentNodes = sortedLayer(parentIds);
  const l1Nodes     = sortedLayer(childL1Ids);
  const l2Nodes     = sortedLayer(childL2Ids);
  const focusNode   = nodes.find(n => n.id === id);

  const cols = [];
  if (parentNodes.length) cols.push({ key: 'parent', all: parentNodes });
  cols.push({ key: 'focus', all: [focusNode] });
  if (l1Nodes.length)  cols.push({ key: 'l1', all: l1Nodes });
  if (l2Nodes.length)  cols.push({ key: 'l2', all: l2Nodes });

  // Assign x positions evenly across width
  const colStep = (W - PAD_X * 2) / Math.max(1, cols.length - 1);
  cols.forEach((col, i) => {
    col.x = cols.length === 1 ? W / 2 : PAD_X + i * colStep;
    col.visible  = col.all.slice(0, MAX_PER_COL);
    col.overflow = col.all.length - col.visible.length;
  });

  // Assign y positions: vertically center each column's nodes
  cols.forEach(col => {
    const rows  = col.visible.length + (col.overflow > 0 ? 1 : 0);
    const totalH = rows * PITCH;
    const startY = (H - totalH) / 2 + PITCH / 2;
    col.visible.forEach((node, i) => {
      node.x = col.x;
      node.y = startY + i * PITCH;
    });
    col._overflowY = startY + col.visible.length * PITCH;
  });

  // Set up zoom/pan
  const dvG = dvSvg.append('g');
  const dvZoom = d3.zoom().scaleExtent([0.2, 4])
    .on('zoom', ({ transform }) => dvG.attr('transform', transform));
  dvSvg.call(dvZoom).on('dblclick.zoom', null);
  dvSvg.on('mousemove', e => {
    if (+tipEl.style.opacity) {
      tipEl.style.left = (e.clientX + 14) + 'px';
      tipEl.style.top  = (e.clientY + 10) + 'px';
    }
  });

  // Arrow marker
  dvSvg.append('defs').append('marker').attr('id', 'dv-arrow')
    .attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 4).attr('markerHeight', 4).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#484f58');

  // Visible node set for edge filtering
  const visibleIds = new Set(cols.flatMap(c => c.visible.map(n => n.id)));

  // Draw edges as cubic bezier paths (left → right)
  dvG.append('g').selectAll('path')
    .data(edges.filter(e => visibleIds.has(e.source.id) && visibleIds.has(e.target.id)
                         && e.source.x < e.target.x))   // only left-to-right
    .join('path')
    .attr('fill', 'none')
    .attr('class', 'edge')
    .attr('marker-end', 'url(#dv-arrow)')
    .attr('d', d => {
      const sx = d.source.x + pillW(d.source.id) / 2;
      const tx = d.target.x - pillW(d.target.id) / 2;
      const mx = (sx + tx) / 2;
      return `M${sx},${d.source.y} C${mx},${d.source.y} ${mx},${d.target.y} ${tx},${d.target.y}`;
    })
    .on('mouseenter', (e, d) => showTip(e,
      `<b>${d.source.id}</b> → <b>${d.target.id}</b><br><span style="color:#6e7681">via ${d.via}</span>`))
    .on('mouseleave', hideTip);

  // Draw nodes
  const allVisible = cols.flatMap(c => c.visible);
  dvG.append('g').selectAll('g').data(allVisible, d => d.id).join('g')
    .attr('class', d => {
      if (d.id === id)           return 'node node-focused';
      if (parentIds.has(d.id))   return 'node node-parent';
      if (childL2Ids.has(d.id))  return 'node node-l2';
      return 'node';
    })
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .on('click', (e, d) => { e.stopPropagation(); dvNavigateTo(d.id); })
    .on('mouseenter', (e, d) => {
      const role = d.id === id ? 'focus' :
                   parentIds.has(d.id)  ? 'references this' :
                   childL1Ids.has(d.id) ? 'child L1' : 'child L2';
      showTip(e, `<b>${d.id}</b><br><span style="color:#6e7681">${role}</span>`);
    })
    .on('mouseleave', hideTip)
    .call(sel => {
      sel.append('rect')
        .attr('width',  d => pillW(d.id)).attr('height', PILL_H)
        .attr('x', d => -pillW(d.id) / 2).attr('y', -PILL_H / 2)
        .attr('rx', PILL_H / 2)
        .attr('fill', d => { const dc = getDiffClass(d.id); return dc ? DIFF_COLORS[dc] : familyColor(d.family); });
      sel.append('text').attr('class', 'node-label').text(d => d.id);
    });

  // Overflow labels
  cols.forEach(col => {
    if (!col.overflow) return;
    dvG.append('text')
      .attr('x', col.x).attr('y', col._overflowY)
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
      .attr('font-size', '10px').attr('fill', '#6e7681')
      .text(`+${col.overflow} more`);
  });

  // Column header labels
  const LABELS = { parent: 'references this', focus: null, l1: 'L1 children', l2: 'L2 children' };
  cols.forEach(col => {
    const lbl = LABELS[col.key];
    if (!lbl) return;
    dvG.append('text')
      .attr('x', col.x).attr('y', 8)
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'hanging')
      .attr('font-size', '9px').attr('fill', '#484f58')
      .text(lbl);
  });

  const p = parentIds.size, c1 = childL1Ids.size, c2 = childL2Ids.size;
  document.getElementById('dv-graph-label').textContent =
    `${p} parent${p !== 1 ? 's' : ''} · ${c1} child${c1 !== 1 ? 'ren' : ''} L1 · ${c2} L2` +
    (c2 >= 20 ? ' (capped)' : '');
}

function dvNavigateTo(id) {
  if (!nodeById.has(id)) return;
  dvNode = id;
  setTableListActive(id);
  openDataPanel(id);
  renderMiniGraph(id);
  updateInfoPanel(id);
}

// ── Breadcrumb ────────────────────────────────────────────────────
function refreshBreadcrumb() {
  if (state.mode !== 'explore' || !state.exploreRoot) {
    breadcrumb.style.display = 'none';
    return;
  }
  breadcrumb.style.display = 'flex';
  const trail = [...state.exploreHistory, state.exploreRoot];
  breadcrumb.innerHTML = trail.map((id, i) => {
    const cur = i === trail.length - 1;
    return `<span class="${cur ? 'crumb-cur' : 'crumb'}" data-idx="${i}">${id}</span>` +
           (cur ? '' : '<span class="crumb-sep">›</span>');
  }).join('');
  breadcrumb.querySelectorAll('.crumb').forEach(el => {
    el.addEventListener('click', () => {
      const idx = +el.dataset.idx;
      state.exploreRoot = state.exploreHistory[idx];
      state.exploreHistory = state.exploreHistory.slice(0, idx);
      render();
      requestAnimationFrame(() => focusNode(state.exploreRoot));
    });
  });
}

// ── Table list ────────────────────────────────────────────────────
function setTableListActive(id) {
  const items = document.querySelectorAll('#table-list .tbl-item');
  let hit = null;
  items.forEach(item => {
    const active = item.dataset.id === id;
    item.classList.toggle('active', active);
    if (active) hit = item;
  });
  hit?.scrollIntoView({ block: 'nearest' });
}

function filterTableList(q) {
  const lower = q.toLowerCase();
  const listEl = document.getElementById('table-list');

  let changedTables = null;
  if (state.showOnlyChanged && (diffData || dataDiffData)) {
    changedTables = new Set();
    if (diffData) {
      diffData.tables.added.forEach(t => changedTables.add(t));
      diffData.tables.removed.forEach(t => changedTables.add(t));
      Object.keys(diffData.tables.changed).forEach(t => changedTables.add(t));
    }
    if (dataDiffData) {
      Object.keys(dataDiffData.tables).forEach(t => changedTables.add(t));
    }
  }

  listEl.querySelectorAll('.tbl-item').forEach(item => {
    const id = item.dataset.id;
    const matchesSearch = !lower || id.toLowerCase().includes(lower);
    const matchesDiff   = !changedTables || changedTables.has(id);
    item.style.display  = (matchesSearch && matchesDiff) ? '' : 'none';
  });
  if (lower || changedTables) listEl.scrollTop = 0;
}

function initTableList() {
  const listEl = document.getElementById('table-list');
  const schemaNodes = RAW.nodes.slice().sort((a, b) => a.id.localeCompare(b.id));
  listEl.innerHTML = schemaNodes.map(n =>
    `<div class="tbl-item" data-id="${n.id}">` +
    `<span class="drop-dot" style="background:${familyColor(n.family)}"></span>${n.id}</div>`
  ).join('');
  listEl.addEventListener('click', e => {
    const item = e.target.closest('.tbl-item');
    if (!item) return;
    const id = item.dataset.id;
    searchEl.value = '';
    filterTableList('');
    if (state.mode === 'data') {
      dvNavigateTo(id);
    } else if (state.mode === 'explore') {
      state.exploreHistory = [];
      navigateTo(id);
    } else {
      const target = nodeSel?.data().find(d => d.id === id);
      if (target) { focusNode(id); zoomTo(target); }
      else { updateInfoPanel(id); openDataPanel(id); }
    }
  });
}

searchEl.addEventListener('input', () => {
  filterTableList(searchEl.value.trim());
});

// ── Mode toggle ───────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const m = btn.dataset.mode;
    if (m === state.mode) return;

    // Tear down previous mode
    if (state.mode === 'data') {
      rightArea.classList.remove('mode-data');
      document.getElementById('show-isolated-wrap').style.display = '';
      if (dvSim) dvSim.stop();
      dvNode = null;
      // Keep dpNode / data panel open if it was loaded
    } else if (state.mode === 'changelog') {
      rightArea.classList.remove('mode-changelog');
      contentEl.classList.remove('mode-changelog');
      document.getElementById('diff-controls').style.display = (RAW.meta.versions?.length > 1) ? 'flex' : 'none';
      document.getElementById('show-isolated-wrap').style.display = '';
    }

    state.mode = m;
    state.focused = null;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));

    if (m === 'changelog') {
      rightArea.classList.add('mode-changelog');
      contentEl.classList.add('mode-changelog');
      document.getElementById('diff-controls').style.display = 'none';
      document.getElementById('show-isolated-wrap').style.display = 'none';
      if (sim) sim.stop();
      g.selectAll('*').remove();
      statsEl.textContent = '';

    } else if (m === 'explore') {
      state.exploreHistory = [];
      state.exploreRoot = null;
      if (sim) sim.stop();
      g.selectAll('*').remove();
      infoPanel.innerHTML = PLACEHOLDER;
      exploreHint.style.display = 'flex';
      statsEl.textContent = '';
      refreshBreadcrumb();

    } else if (m === 'data') {
      rightArea.classList.add('mode-data');
      document.getElementById('show-isolated-wrap').style.display = 'none';
      if (sim) sim.stop();
      g.selectAll('*').remove();
      exploreHint.style.display = 'none';
      statsEl.textContent = '';
      refreshBreadcrumb();

      // Carry a previously focused node into data view
      const carryOver = dpNode || state.exploreRoot;
      state.exploreRoot = null;
      state.exploreHistory = [];
      infoPanel.innerHTML = PLACEHOLDER;

      // Always show data panel in data mode
      dataPanel.classList.remove('dp-hidden');

      if (carryOver && nodeById.has(carryOver)) {
        dvNavigateTo(carryOver);
      } else {
        dvNode = null;
        dpTitle.textContent = 'Data View';
        dpDataPane.innerHTML = '<p class="placeholder">Search for a table above to begin</p>';
        document.getElementById('dv-graph-label').textContent = '';
      }

    } else { // graph
      exploreHint.style.display = 'none';
      state.exploreHistory = [];
      state.exploreRoot = null;
      render();
    }

    updateHash();
  });
});

// ── Isolated filter ───────────────────────────────────────────────
document.getElementById('show-isolated').addEventListener('change', e => {
  state.showIsolated = e.target.checked;
  if (state.mode === 'graph') render();
});

// ── Data panel ───────────────────────────────────────────────────
const dataPanel  = document.getElementById('data-panel');
const dpTitle    = document.getElementById('dp-title');
const dpDataPane = document.getElementById('dp-data');
const dpDrag     = document.getElementById('dp-drag');

const CSV_BASE = 'ffxiv-datamining-latest/csv/en';

let dpNode        = null;
let dpPage        = 0;
let DP_PAGE       = 15;
let dpSelectedRow = null;

function calcDpPage() {
  const body = document.getElementById('dp-body');
  if (!body) return 15;
  const bodyH = body.offsetHeight;
  const ROW_H = 22, THEAD = 26, PAGINATION = 44, BUFFER = 8;
  let overhead = THEAD + PAGINATION + BUFFER;
  if (diffData?.tables.changed?.[dpNode])       overhead += 52;
  if (dataDiffData?.tables?.[dpNode])           overhead += 52;
  return Math.max(5, Math.floor((bodyH - overhead) / ROW_H));
}

// Parse a full CSV text into an array of rows (handles quoted fields and embedded newlines).
function parseCSVText(text) {
  const rows = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const row = [];
    rowLoop: while (true) {
      let field = '';
      if (i < n && text[i] === '"') {
        i++;
        while (i < n) {
          if (text[i] === '"' && text[i + 1] === '"') { field += '"'; i += 2; }
          else if (text[i] === '"') { i++; break; }
          else field += text[i++];
        }
      } else {
        while (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') field += text[i++];
      }
      row.push(field);
      if (i < n && text[i] === ',') { i++; continue rowLoop; }
      break;
    }
    if (i < n && text[i] === '\r') i++;
    if (i < n && text[i] === '\n') i++;
    if (row.length === 1 && row[0] === '') continue;
    rows.push(row);
  }
  return rows;
}

async function loadCSVRows(node) {
  if ('_rows' in node) return;
  try {
    const resp = await fetch(`${CSV_BASE}/${node.path}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const all = parseCSVText(text);
    node._rows = all.slice(1); // first line is the # schema header
  } catch (e) {
    node._rows = [];
    node._fetchError = String(e);
  }
}

async function openDataPanel(id, page = 0) {
  const node = nodeById.get(id);
  if (!node) return;
  if (dpNode !== id) dpSelectedRow = null;
  dpNode = id;
  dpPage = page;
  // If a search target is arriving for this table, record it as the selected row immediately
  // so updateHash() below includes it in the URL.
  if (state.searchTarget?.table === id) dpSelectedRow = state.searchTarget.rowId;
  dpTitle.textContent = id;
  dataPanel.classList.remove('dp-hidden');
  updateHash();
  if (!('_rows' in node)) {
    dpDataPane.innerHTML = '<p class="placeholder">Loading…</p>';
    await loadCSVRows(node);
    if (dpNode !== id) return; // user navigated away during fetch
  }
  // Pre-fetch per-table diff so renderDataPane can use it synchronously
  if (dataDiffData) await fetchTableDiff(id);
  renderDataPane();
}

function closeDpPanel() {
  dataPanel.classList.add('dp-hidden');
  dpNode = null;
  dpSelectedRow = null;
  history.replaceState(null, '', location.pathname + location.search);
}

function renderDataPane() {
  DP_PAGE = calcDpPage();
  const node = nodeById.get(dpNode);
  if (!node) return;
  if (node._fetchError) {
    dpDataPane.innerHTML = `<p class="placeholder">Failed to load CSV: ${node._fetchError}</p>`;
    return;
  }
  const rows = node._rows || [];
  const cols   = node.columns || [];
  const fkMap  = new Map(RAW.edges.filter(e => e.source === dpNode).map(e => [e.via, e.target]));

  // Schema diff info
  const diffChange = diffData?.tables.changed?.[dpNode];

  // Row-level diff info — per-table detail was pre-fetched into cache by openDataPanel
  const tableDataDiff  = dataDiffTableCache.get(dpNode) ?? null;
  const addedRowSet    = tableDataDiff ? new Set(tableDataDiff.rows_added.map(String)) : new Set();
  const changedRowMap  = tableDataDiff?.rows_changed || {};
  const diffSummary    = dataDiffData?.tables?.[dpNode] ?? null; // counts: {ra,rr,rc}

  // In data view with "Only changed" active, restrict rows to added/changed ones
  let displayRows = rows;
  if (state.mode === 'data' && state.showOnlyChanged && tableDataDiff) {
    const changedIds = new Set([
      ...tableDataDiff.rows_added.map(String),
      ...Object.keys(tableDataDiff.rows_changed),
    ]);
    displayRows = rows.filter(row => changedIds.has(row[0]));
  }

  // If a search result targeted this table, jump to the page containing that row
  const searchTargetId = state.searchTarget?.table === dpNode ? String(state.searchTarget.rowId) : null;
  if (searchTargetId) {
    const idx = displayRows.findIndex(r => r[0] === searchTargetId);
    if (idx !== -1) dpPage = Math.floor(idx / DP_PAGE);
  }

  const total = displayRows.length;
  const pages = Math.max(1, Math.ceil(total / DP_PAGE));
  const start = dpPage * DP_PAGE;
  const slice = displayRows.slice(start, start + DP_PAGE);
  const end   = start + slice.length;

  const thead = cols.map(c => {
    const tgt = fkMap.get(c);
    return tgt
      ? `<th class="th-fk" data-target="${tgt}" title="→ ${tgt}">${c}</th>`
      : `<th>${c}</th>`;
  }).join('');

  // Share full diff map with click handlers (covers all rows, not just current page)
  rowDiffState = { diffs: changedRowMap, cols };

  const tbody = slice.flatMap(row => {
    const rowId     = row[0];
    const rowChange = changedRowMap[rowId];
    const isAdded   = addedRowSet.has(rowId);
    const isChanged = !!rowChange;

    const isTarget   = searchTargetId === rowId;
    const isSelected = dpSelectedRow   === rowId;
    const cls = [
      isAdded    ? 'row-diff-added'    : '',
      isChanged  ? 'row-diff-changed'  : '',
      isTarget   ? 'row-search-target' : '',
      isSelected ? 'row-selected'      : '',
    ].filter(Boolean).join(' ');
    const trAttrs = (cls ? ` class="${cls}"` : '') + ` data-rowid="${escHtml(rowId)}"`;

    const cells = row.map((cell, ci) => {
      if (ci === 0 && isChanged)
        return `<td><span class="row-toggle" title="Toggle inline diff">▶</span>${cell}</td>`;
      const change = rowChange?.[cols[ci]];
      return change ? `<td class="cell-diff-changed">${cell}</td>` : `<td>${cell}</td>`;
    }).join('');

    const mainRow = `<tr${trAttrs}>${cells}</tr>`;
    if (!isChanged) return [mainRow];

    // Detail row (hidden until toggled)
    const fields = Object.entries(rowChange).map(([col, [ov, nv]]) =>
      `<div class="diff-field">` +
      `<div class="diff-field-name">${escHtml(col)}</div>` +
      `<div class="diff-val-old">&#8722;&nbsp;${escHtml(String(ov))}</div>` +
      `<div class="diff-val-new">+&nbsp;${escHtml(String(nv))}</div>` +
      `</div>`
    ).join('');
    const detailRow =
      `<tr class="diff-detail-row" data-for="${escHtml(rowId)}" style="display:none">` +
      `<td colspan="${cols.length}"><div class="diff-detail-content">${fields}</div></td></tr>`;

    return [mainRow, detailRow];
  }).join('');

  const diffSection = diffChange ? `
    <div class="col-diff">
      <span class="col-diff-hdr">Schema changes in this diff</span>
      ${diffChange.columns_added.map(c => `<span class="col-badge col-added">+ ${c}</span>`).join('')}
      ${diffChange.columns_removed.map(c => `<span class="col-badge col-removed">&#8722; ${c}</span>`).join('')}
    </div>` : '';

  const rowDiffSection = diffSummary ? (() => {
    const na       = diffSummary.ra ?? tableDataDiff?.rows_added.length   ?? 0;
    const nr       = diffSummary.rr ?? tableDataDiff?.rows_removed.length ?? 0;
    const nc       = diffSummary.rc ?? Object.keys(tableDataDiff?.rows_changed ?? {}).length;
    const truncated = tableDataDiff?._rc_truncated ?? 0;
    return `<div class="col-diff">
      <span class="col-diff-hdr">Row changes in this diff</span>
      ${na ? `<span class="col-badge col-added">+${na} added</span>` : ''}
      ${nr ? `<span class="col-badge col-removed">&#8722;${nr} removed</span>` : ''}
      ${nc ? `<span class="col-badge" style="background:rgba(210,153,34,0.15);color:#d29922">~${nc} changed</span>` : ''}
      ${truncated ? `<span class="col-badge" style="background:rgba(110,118,129,0.15);color:#6e7681" title="Showing first ${nc - truncated} of ${nc} changed rows">&#x26A0; ${truncated} rows truncated</span>` : ''}
    </div>`;
  })() : '';

  dpDataPane.innerHTML = `${diffSection}${rowDiffSection}
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
    <div class="page-bar">
      <button class="page-btn" id="dp-prev" ${dpPage === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page <input class="page-input" id="dp-pg-in" type="text" value="${dpPage + 1}"> of ${pages}</span>
      <button class="page-btn" id="dp-next" ${dpPage >= pages - 1 ? 'disabled' : ''}>Next ›</button>
      <span class="row-range">rows ${start + 1}–${end} of ${total}</span>
    </div>`;

  if (searchTargetId) {
    requestAnimationFrame(() => {
      dpDataPane.querySelector('.row-search-target')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.searchTarget = null;
    });
  }

  dpDataPane.querySelector('#dp-prev').addEventListener('click', () => { dpPage--; updateHash(); renderDataPane(); });
  dpDataPane.querySelector('#dp-next').addEventListener('click', () => { dpPage++; updateHash(); renderDataPane(); });

  const pgIn = dpDataPane.querySelector('#dp-pg-in');
  pgIn.addEventListener('change', () => {
    const p = Math.max(1, Math.min(parseInt(pgIn.value, 10) || 1, pages)) - 1;
    if (p !== dpPage) { dpPage = p; updateHash(); renderDataPane(); }
  });
  pgIn.addEventListener('keydown', e => { if (e.key === 'Enter') pgIn.dispatchEvent(new Event('change')); });

  dpDataPane.querySelectorAll('th.th-fk[data-target]').forEach(th => {
    th.addEventListener('click', () => navigateToFromPanel(th.dataset.target));
  });

  dpDataPane.querySelector('.data-table')
    ?.addEventListener('click', handleTableRowClick);
}

function navigateToFromPanel(id) {
  if (state.mode === 'data') { dvNavigateTo(id); return; }
  if (state.mode === 'explore') { navigateTo(id); }
  else {
    focusNode(id);
    const t = nodeSel?.data().find(d => d.id === id);
    if (t?.x != null) zoomTo(t);
  }
  openDataPanel(id);
}

// ── Row diff interaction ──────────────────────────────────────────
function handleTableRowClick(e) {
  // Toggle icon → expand/collapse inline detail row
  const toggle = e.target.closest('.row-toggle');
  if (toggle) {
    e.stopPropagation();
    const rowId = toggle.closest('tr').dataset.rowid;
    const detail = dpDataPane.querySelector(`.diff-detail-row[data-for="${CSS.escape(rowId)}"]`);
    if (!detail) return;
    const opening = detail.style.display === 'none';
    detail.style.display = opening ? '' : 'none';
    toggle.textContent = opening ? '▼' : '▶';
    return;
  }

  // Click on any data row → select/deselect it
  const tr = e.target.closest('tr[data-rowid]');
  if (!tr) return;
  const rowId = tr.dataset.rowid;

  if (dpSelectedRow === rowId) {
    tr.classList.remove('row-selected');
    dpSelectedRow = null;
  } else {
    dpDataPane.querySelector('.row-selected')?.classList.remove('row-selected');
    tr.classList.add('row-selected');
    dpSelectedRow = rowId;
  }
  updateHash();

  // Also show diff detail in sidebar for changed rows
  if (tr.classList.contains('row-diff-changed')) showRowDiffInSidebar(rowId);
}

function showRowDiffInSidebar(rowId) {
  const changes = rowDiffState.diffs[rowId];
  if (!changes) return;
  infoPanel.innerHTML =
    `<div class="rdiff-title">Row ${escHtml(rowId)} &mdash; changes</div>` +
    Object.entries(changes).map(([col, [ov, nv]]) =>
      `<div class="rdiff-field">` +
      `<div class="rdiff-fname">${escHtml(col)}</div>` +
      `<div class="rdiff-old">&#8722;&nbsp;${escHtml(String(ov))}</div>` +
      `<div class="rdiff-new">+&nbsp;${escHtml(String(nv))}</div>` +
      `</div>`
    ).join('');
}

// ── Drag-to-resize (data panel in graph/explore mode) ────────────
{
  let dragging = false, startY = 0, startH = 0;
  dpDrag.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = dataPanel.offsetHeight;
    dpDrag.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH  = Math.max(80, Math.min(startH + delta, window.innerHeight * 0.85));
    dataPanel.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    dpDrag.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── Drag-to-resize (mini-graph in data view) ──────────────────────
{
  const dvResize = document.getElementById('dv-resize');
  const dvGraphArea = document.getElementById('dv-graph-area');
  let dragging = false, startY = 0, startH = 0;
  dvResize.addEventListener('mousedown', e => {
    dragging = true;
    startY = e.clientY;
    startH = dvGraphArea.offsetHeight;
    dvResize.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY;   // drag up = taller mini-graph
    const newH  = Math.max(100, Math.min(startH + delta, window.innerHeight * 0.7));
    dvGraphArea.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    dvResize.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// Re-render when the data panel body changes height (resize drag or mode switch)
new ResizeObserver(() => {
  if (dpNode) renderDataPane();
}).observe(document.getElementById('dp-body'));

document.getElementById('dp-close').addEventListener('click', () => {
  if (state.mode !== 'data') closeDpPanel();
});

// ── Diff loading & controls ───────────────────────────────────────
function getVersionChain(fromId, toId) {
  const versions = RAW.meta.versions || [];
  const fromIdx  = versions.findIndex(v => v.id === fromId);
  const toIdx    = versions.findIndex(v => v.id === toId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx >= toIdx) return null;
  return versions.slice(fromIdx, toIdx + 1).map(v => v.id);
}

function mergeSchemaDiffs(diffs) {
  const netAddedTables   = new Set();
  const netRemovedTables = new Set();
  const netChangedTables = {};
  const netAddedEdges    = new Set();
  const netRemovedEdges  = new Set();
  const edgeByKey        = {};

  for (const diff of diffs) {
    for (const t of diff.tables.added) {
      if (netRemovedTables.has(t)) { netRemovedTables.delete(t); } else { netAddedTables.add(t); }
      delete netChangedTables[t];
    }
    for (const t of diff.tables.removed) {
      if (netAddedTables.has(t)) { netAddedTables.delete(t); } else { netRemovedTables.add(t); }
      delete netChangedTables[t];
    }
    for (const [t, changes] of Object.entries(diff.tables.changed)) {
      if (netAddedTables.has(t) || netRemovedTables.has(t)) continue;
      if (!netChangedTables[t]) netChangedTables[t] = { columns_added: new Set(), columns_removed: new Set() };
      const tc = netChangedTables[t];
      for (const col of (changes.columns_added || [])) {
        if (tc.columns_removed.has(col)) { tc.columns_removed.delete(col); } else { tc.columns_added.add(col); }
      }
      for (const col of (changes.columns_removed || [])) {
        if (tc.columns_added.has(col)) { tc.columns_added.delete(col); } else { tc.columns_removed.add(col); }
      }
    }
    for (const e of diff.edges.added) {
      const key = `${e.source}|${e.target}|${e.via}`;
      edgeByKey[key] = e;
      if (netRemovedEdges.has(key)) { netRemovedEdges.delete(key); } else { netAddedEdges.add(key); }
    }
    for (const e of diff.edges.removed) {
      const key = `${e.source}|${e.target}|${e.via}`;
      edgeByKey[key] = e;
      if (netAddedEdges.has(key)) { netAddedEdges.delete(key); } else { netRemovedEdges.add(key); }
    }
  }

  const changedTables = {};
  for (const [t, tc] of Object.entries(netChangedTables)) {
    if (tc.columns_added.size || tc.columns_removed.size)
      changedTables[t] = { columns_added: [...tc.columns_added], columns_removed: [...tc.columns_removed] };
  }

  return {
    from: diffs[0].from,
    to:   diffs[diffs.length - 1].to,
    tables: { added: [...netAddedTables], removed: [...netRemovedTables], changed: changedTables },
    edges:  { added: [...netAddedEdges].map(k => edgeByKey[k]), removed: [...netRemovedEdges].map(k => edgeByKey[k]) },
  };
}

// Merge full row-level data for a single table across consecutive diff steps.
function mergeTableDiffs(tables) {
  const tr = { rows_added: new Set(), rows_removed: new Set(), rows_changed: {} };
  for (const changes of tables) {
    for (const id of (changes.rows_added || [])) {
      const key = String(id);
      if (tr.rows_removed.has(key)) { tr.rows_removed.delete(key); delete tr.rows_changed[key]; }
      else { tr.rows_added.add(key); }
    }
    for (const id of (changes.rows_removed || [])) {
      const key = String(id);
      if (tr.rows_added.has(key)) { tr.rows_added.delete(key); }
      else { tr.rows_removed.add(key); }
      delete tr.rows_changed[key];
    }
    for (const [rowId, fieldDiffs] of Object.entries(changes.rows_changed || {})) {
      const key = String(rowId);
      if (tr.rows_added.has(key) || tr.rows_removed.has(key)) continue;
      if (!tr.rows_changed[key]) tr.rows_changed[key] = {};
      const existing = tr.rows_changed[key];
      for (const [col, [oldVal, newVal]] of Object.entries(fieldDiffs)) {
        if (existing[col]) {
          existing[col] = [existing[col][0], newVal];
          if (existing[col][0] === existing[col][1]) delete existing[col];
        } else {
          existing[col] = [oldVal, newVal];
        }
      }
      if (!Object.keys(existing).length) delete tr.rows_changed[key];
    }
  }
  return {
    rows_added:   [...tr.rows_added].map(id => isNaN(id) ? id : Number(id)),
    rows_removed: [...tr.rows_removed].map(id => isNaN(id) ? id : Number(id)),
    rows_changed: tr.rows_changed,
  };
}

// Merge summary-level data diff objects (counts only — used for table list badges).
function mergeDataDiffs(summaries) {
  const result = {};
  for (const s of summaries) {
    for (const [table, counts] of Object.entries(s.tables || {})) {
      if (!result[table]) result[table] = { ra: 0, rr: 0, rc: 0 };
      result[table].ra += counts.ra;
      result[table].rr += counts.rr;
      result[table].rc += counts.rc;
    }
  }
  return result;
}

// Fetch and cache the full per-table diff for the active diff range.
async function fetchTableDiff(tableId) {
  if (dataDiffTableCache.has(tableId)) return dataDiffTableCache.get(tableId);
  if (!dataDiffPairs.length) return null;

  const fetched = await Promise.all(dataDiffPairs.map(async ({ from, to }) => {
    try {
      const r = await fetch(`data_diff_${from}_to_${to}/${tableId}.json`);
      return r.ok ? r.json() : null;
    } catch { return null; }
  }));
  const valid = fetched.filter(Boolean);
  const result = valid.length === 0 ? null
               : valid.length === 1 ? valid[0]
               : mergeTableDiffs(valid);
  dataDiffTableCache.set(tableId, result);
  return result;
}

async function applyDiff() {
  const from = document.getElementById('diff-from').value;
  const to   = document.getElementById('diff-to').value;
  const changedWrap = document.getElementById('diff-changed-wrap');
  const onlyChanged = document.getElementById('diff-only-changed');

  diffData          = null;
  diffEdgeAddedKeys = new Set();
  dataDiffData      = null;
  dataDiffPairs     = [];
  dataDiffTableCache.clear();

  if (from && to && from !== to) {
    const chain = getVersionChain(from, to);
    const pairs = chain ? chain.slice(0, -1).map((id, i) => ({ from: id, to: chain[i + 1] })) : [];

    // Schema diffs: fetch all consecutive pairs in the chain, skip any missing files
    if (pairs.length) {
      const fetched = await Promise.all(pairs.map(async p => {
        try { const r = await fetch(`diff_${p.from}_to_${p.to}.json`); return r.ok ? r.json() : null; }
        catch { return null; }
      }));
      const valid = fetched.filter(Boolean);
      if (valid.length) {
        diffData = valid.length === 1 ? valid[0] : mergeSchemaDiffs(valid);
        diffEdgeAddedKeys = new Set(diffData.edges.added.map(e => `${e.source}|${e.target}|${e.via}`));
      }
    }

    // Data diffs: fetch summaries only — per-table detail loaded lazily via fetchTableDiff
    if (pairs.length) {
      const fetched = await Promise.all(pairs.map(async p => {
        try { const r = await fetch(`data_diff_${p.from}_to_${p.to}.json`); return r.ok ? r.json() : null; }
        catch { return null; }
      }));
      const valid = fetched.filter(Boolean);
      if (valid.length) {
        const tables = valid.length === 1 ? (valid[0].tables || {}) : mergeDataDiffs(valid);
        dataDiffData  = { from, to, tables };
        dataDiffPairs = pairs;
      }
    }
  }

  const hasDiff    = !!diffData;
  const hasAnyDiff = hasDiff || !!dataDiffData;
  changedWrap.style.display = hasAnyDiff ? 'flex' : 'none';
  if (!hasAnyDiff) { onlyChanged.checked = false; state.showOnlyChanged = false; }

  filterTableList(searchEl.value.trim());

  if (state.mode === 'data') {
    if (dpNode) renderDataPane();
  } else {
    render();
  }
}

document.getElementById('diff-from').addEventListener('change', applyDiff);
document.getElementById('diff-to').addEventListener('change', applyDiff);
document.getElementById('diff-only-changed').addEventListener('change', e => {
  state.showOnlyChanged = e.target.checked;
  filterTableList(searchEl.value.trim());
  if (state.mode === 'data') {
    dpPage = 0;
    if (dpNode) renderDataPane();
  } else {
    render();
  }
});

// ── Patch Summary mode ────────────────────────────────────────────
let clSchemaDiff = null;
let clDataDiff   = null;
const clRowDataCache = new Map(); // tableId -> loaded CSV rows

async function loadChangelogVersion(versionId) {
  const versions = RAW.meta.versions || [];
  const idx = versions.findIndex(v => v.id === versionId);
  if (idx <= 0) return;
  const fromId = versions[idx - 1].id;

  const [sd, dd] = await Promise.all([
    fetch(`diff_${fromId}_to_${versionId}.json`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`data_diff_${fromId}_to_${versionId}.json`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  clSchemaDiff = sd;
  clDataDiff   = dd;
  clRowDataCache.clear();
  renderChangelog(versionId);
}

function renderChangelog(versionId) {
  const body = document.getElementById('cl-body');
  const summaryEl = document.getElementById('cl-header-summary');

  if (!clSchemaDiff && !clDataDiff) {
    body.innerHTML = '<p style="color:#6e7681;padding:20px">No diff data available for this version.</p>';
    summaryEl.textContent = '';
    return;
  }

  const versions  = RAW.meta.versions || [];
  const idx       = versions.findIndex(v => v.id === versionId);
  const fromLabel = idx > 0 ? versions[idx - 1].label : '?';
  const toLabel   = versions[idx]?.label || versionId;

  const tables    = clSchemaDiff?.tables || { added: [], removed: [], changed: {} };
  const dataTbls  = clDataDiff?.tables   || {};
  const na = tables.added.length, nr = tables.removed.length;
  const nc = Object.keys(tables.changed).length, nd = Object.keys(dataTbls).length;

  const parts = [];
  if (na) parts.push(`<span style="color:#3fb950">+${na} added</span>`);
  if (nr) parts.push(`<span style="color:#f85149">&#8722;${nr} removed</span>`);
  if (nc) parts.push(`<span style="color:#d29922">~${nc} schema</span>`);
  if (nd) parts.push(`<span style="color:#58a6ff">${nd} row changes</span>`);
  summaryEl.innerHTML = `${fromLabel} &rarr; ${toLabel} &nbsp; ${parts.join(' &nbsp; ')}`;

  let html = '';
  if (na) html += clMakeSection('cl-s-added',   'Added Tables',   na, tables.added.slice().sort().map(t => clMakeRow(t, 'added', null, null)).join(''));
  if (nr) html += clMakeSection('cl-s-removed',  'Removed Tables', nr, tables.removed.slice().sort().map(t => clMakeRow(t, 'removed', null, null)).join(''));
  if (nc) html += clMakeSection('cl-s-schema',   'Schema Changes', nc, Object.entries(tables.changed).sort((a,b)=>a[0].localeCompare(b[0])).map(([t,c]) => clMakeRow(t, 'schema', c, null)).join(''));
  if (nd) html += clMakeSection('cl-s-rowdata',  'Row Changes',    nd, Object.entries(dataTbls).sort((a,b)=>a[0].localeCompare(b[0])).map(([t,d]) => clMakeRow(t, 'rowdata', null, d)).join(''));

  body.innerHTML = html;

  body.querySelectorAll('.cl-section-header').forEach(hdr => {
    hdr.addEventListener('click', () => hdr.closest('.cl-section').classList.toggle('cl-collapsed'));
  });
  body.querySelectorAll('.cl-row').forEach(row => {
    row.addEventListener('click', () => clToggleRow(row));
  });
}

function clMakeSection(id, title, count, rowsHtml) {
  return `<div class="cl-section" id="${id}">
    <div class="cl-section-header">
      <span class="cl-section-chevron">&#9660;</span>
      <span>${title}</span> <span class="cl-section-count">(${count})</span>
    </div>
    <div class="cl-section-body">${rowsHtml}</div>
  </div>`;
}

function clMakeRow(tableId, type, schemaChange, rowData) {
  const dot = nodeById.has(tableId)
    ? `<span class="drop-dot" style="background:${familyColor(nodeById.get(tableId).family)}"></span>` : '';

  let badges = '';
  if (type === 'added') {
    badges = `<span class="col-badge col-added">new</span>`;
  } else if (type === 'removed') {
    badges = `<span class="col-badge col-removed">removed</span>`;
  } else if (type === 'schema' && schemaChange) {
    const ca = schemaChange.columns_added?.length || 0, cr = schemaChange.columns_removed?.length || 0;
    if (ca) badges += `<span class="col-badge col-added">+${ca} col${ca>1?'s':''}</span>`;
    if (cr) badges += `<span class="col-badge col-removed">&#8722;${cr} col${cr>1?'s':''}</span>`;
  } else if (type === 'rowdata' && rowData) {
    // rowData is a summary {ra,rr,rc} from the data_diff summary file
    const ra = rowData.ra ?? 0, rr = rowData.rr ?? 0, rc = rowData.rc ?? 0;
    if (ra) badges += `<span class="col-badge col-added">+${ra}</span>`;
    if (rr) badges += `<span class="col-badge col-removed">&#8722;${rr}</span>`;
    if (rc) badges += `<span class="col-badge" style="background:rgba(210,153,34,0.15);color:#d29922">~${rc}</span>`;
  }

  return `<div class="cl-row" data-id="${tableId}" data-type="${type}">
    ${dot}<span class="cl-row-name">${tableId}</span>
    <div class="cl-row-badges">${badges}</div>
    <span class="cl-chevron">&#9654;</span>
  </div>`;
}

async function clToggleRow(rowEl) {
  const tableId = rowEl.dataset.id;
  const type    = rowEl.dataset.type;

  const existing = rowEl.nextElementSibling;
  if (existing?.classList.contains('cl-inline')) {
    existing.remove();
    rowEl.classList.remove('cl-expanded');
    return;
  }
  rowEl.classList.add('cl-expanded');

  const inline = document.createElement('div');
  inline.className = 'cl-inline';
  inline.innerHTML = '<p class="cl-load-msg">Loading&#8230;</p>';
  rowEl.after(inline);

  if (type === 'removed') {
    inline.innerHTML = '<p class="cl-load-msg" style="color:#6e7681">Row data not available — table was removed in this version.</p>';
    return;
  }

  const node = nodeById.get(tableId);
  if (!node) {
    inline.innerHTML = '<p class="cl-load-msg">Table not found in current version.</p>';
    return;
  }

  if (!clRowDataCache.has(tableId)) {
    try {
      const resp = await fetch(`${CSV_BASE}/${node.path}`);
      if (!resp.ok) throw new Error();
      const text   = await resp.text();
      const parsed = parseCSVText(text);
      clRowDataCache.set(tableId, parsed);
    } catch {
      clRowDataCache.set(tableId, null);
    }
  }

  const rows = clRowDataCache.get(tableId);
  if (!rows) {
    inline.innerHTML = '<p class="cl-load-msg">Failed to load CSV data.</p>';
    return;
  }

  const cols = (node.columns || []).slice(1); // skip '#' header

  if (type === 'added') {
    const shown = rows.slice(1, 201); // skip header row, up to 200 data rows
    const more  = Math.max(0, rows.length - 1 - shown.length);
    inline.innerHTML = clRenderTable(cols, shown.map(r => ({ id: r[0], vals: r.slice(1), kind: 'added' })), more);

  } else if (type === 'schema') {
    const schemaChange = clSchemaDiff?.tables.changed?.[tableId] || {};
    const addedCols    = new Set(schemaChange.columns_added   || []);
    const removedCols  = new Set(schemaChange.columns_removed || []);
    const colHeaders   = cols.map(c =>
      addedCols.has(c)   ? `<span class="cl-col-added">+&nbsp;${c}</span>` :
      removedCols.has(c) ? `<span class="cl-col-removed">&#8722;&nbsp;${c}</span>` : c
    );
    const shown = rows.slice(1, 51);
    inline.innerHTML = clRenderTable(colHeaders, shown.map(r => ({ id: r[0], vals: r.slice(1), kind: '' })), 0, true);

  } else if (type === 'rowdata') {
    // Per-table detail is in a separate file — fetch it lazily
    const versions = RAW.meta.versions || [];
    const idx      = versions.findIndex(v => v.id === document.getElementById('cl-version').value);
    const fromId   = idx > 0 ? versions[idx - 1].id : null;
    const toId     = versions[idx]?.id;
    let rd = null;
    if (fromId && toId) {
      try {
        const r = await fetch(`data_diff_${fromId}_to_${toId}/${tableId}.json`);
        rd = r.ok ? await r.json() : null;
      } catch { rd = null; }
    }
    if (!rd) { inline.innerHTML = '<p class="cl-load-msg">No row diff data.</p>'; return; }

    const addedSet   = new Set(rd.rows_added.map(String));
    const removedSet = new Set(rd.rows_removed.map(String));
    const changedMap = rd.rows_changed || {};
    const allIds     = new Set([...addedSet, ...removedSet, ...Object.keys(changedMap)]);

    // Build a lookup from row ID to row values using the parsed CSV array
    const rowById = new Map(rows.slice(1).map(r => [r[0], r.slice(1)]));

    const rowItems = [];
    for (const id of allIds) {
      const vals = rowById.get(id) || [];
      if (addedSet.has(id))   { rowItems.push({ id, vals, kind: 'added' }); continue; }
      if (removedSet.has(id)) { rowItems.push({ id, vals, kind: 'removed' }); continue; }
      if (changedMap[id])     { rowItems.push({ id, vals, kind: 'changed', diffs: changedMap[id] }); }
    }
    rowItems.sort((a, b) => {
      const ai = isNaN(a.id) ? a.id : Number(a.id);
      const bi = isNaN(b.id) ? b.id : Number(b.id);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    inline.innerHTML = clRenderTable(cols, rowItems, 0);
  }
}

function clRenderTable(cols, rowItems, moreCount, rawColHtml = false) {
  if (!rowItems.length) return '<p class="cl-load-msg">No rows.</p>';
  const thHtml = cols.map(c => `<th>${rawColHtml ? c : escHtml(String(c))}</th>`).join('');
  const tbHtml = rowItems.map(({ id, vals, kind, diffs }) => {
    const cls = kind === 'added' ? 'cl-row-added' : kind === 'removed' ? 'cl-row-removed' : '';
    const tdHtml = vals.map((v, i) => {
      const col     = cols[i];
      const changed = diffs && diffs[col];
      if (changed) {
        const [oldV, newV] = changed;
        return `<td class="cl-cell-changed" title="was: ${escHtml(String(oldV))}">${escHtml(String(newV))}</td>`;
      }
      return `<td>${escHtml(String(v ?? ''))}</td>`;
    }).join('');
    return `<tr class="${cls}"><td>${escHtml(String(id))}</td>${tdHtml}</tr>`;
  }).join('');
  const more = moreCount > 0 ? `<p class="cl-load-msg">&#8230; and ${moreCount} more rows</p>` : '';
  return `<table><thead><tr><th>#</th>${thHtml}</tr></thead><tbody>${tbHtml}</tbody></table>${more}`;
}

document.getElementById('cl-version').addEventListener('change', e => {
  if (e.target.value) { updateHash(); loadChangelogVersion(e.target.value); }
});

// ── URL hash state ────────────────────────────────────────────────
function updateHash() {
  const p = new URLSearchParams();
  p.set('mode', state.mode);
  if (state.mode === 'data' && dpNode) {
    p.set('node', dpNode);
    p.set('page', dpPage + 1);
    if (dpSelectedRow) p.set('row', dpSelectedRow);
  } else if (state.mode === 'changelog') {
    const ver = document.getElementById('cl-version').value;
    if (ver) p.set('version', ver);
  }
  history.replaceState(null, '', `#${p.toString()}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const mode   = params.get('mode');
  const id     = params.get('node');
  const page   = Math.max(0, (parseInt(params.get('page'), 10) || 1) - 1);
  const ver    = params.get('version');

  // Backward compat: hash with node but no mode implies data mode
  const targetMode = mode || (id ? 'data' : null);
  if (targetMode && targetMode !== state.mode) {
    document.querySelector(`.mode-btn[data-mode="${targetMode}"]`)?.click();
  }

  const row = params.get('row');

  if (id && nodeById.has(id)) {
    if (row) {
      dpSelectedRow       = row;
      state.searchTarget  = { table: id, rowId: row };
    }
    openDataPanel(id, page);
    if (state.mode === 'graph') {
      focusNode(id);
      sim?.on('end.hashrestore', () => {
        const t = nodeSel?.data().find(d => d.id === id);
        if (t?.x != null) zoomTo(t);
        sim.on('end.hashrestore', null);
      });
    }
  }

  if (ver) {
    const clEl = document.getElementById('cl-version');
    clEl.value = ver;
    loadChangelogVersion(ver);
  }
}

// ── Levenshtein distance ──────────────────────────────────────────
function levenshtein(a, b) {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  let curr = new Array(lb + 1);
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i-1] === b[j-1]
        ? prev[j-1]
        : 1 + Math.min(prev[j], curr[j-1], prev[j-1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

// ── Search overlay ────────────────────────────────────────────────
let searchIndexData = null;  // null = not yet loaded
let searchLoadState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let searchDebounce  = null;

async function loadSearchIndex() {
  if (searchLoadState !== 'idle') return;
  searchLoadState = 'loading';
  document.getElementById('so-status').textContent = 'Loading index…';
  try {
    const r = await fetch('search_index.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    searchIndexData = data.entries; // [t, c, r, s, vs]
    searchLoadState = 'ready';
    document.getElementById('so-status').textContent =
      `${searchIndexData.length.toLocaleString()} entries across ${(RAW.meta.versions||[]).length} versions`;
  } catch {
    searchLoadState = 'error';
    document.getElementById('so-status').textContent = 'Failed to load search index';
    searchIndexData = [];
  }
  runSearch(document.getElementById('so-input').value.trim());
}

function openSearchOverlay() {
  document.getElementById('search-overlay').style.display = 'flex';
  document.getElementById('so-input').select();
  if (searchLoadState === 'idle') loadSearchIndex();
}

function closeSearchOverlay() {
  document.getElementById('search-overlay').style.display = 'none';
  clearTimeout(searchDebounce);
}

function runSearch(query) {
  const resultsEl = document.getElementById('so-results');
  const q = query.trim();

  if (q.length < 2) {
    resultsEl.innerHTML = '<p class="so-hint">Type at least 2 characters to search</p>';
    return;
  }
  if (searchLoadState === 'loading') {
    resultsEl.innerHTML = '<p class="so-hint">Loading index…</p>';
    return;
  }
  if (!searchIndexData?.length) {
    resultsEl.innerHTML = '<p class="so-hint">No index available — run update.ps1 to generate it</p>';
    return;
  }

  const lower   = q.toLowerCase();
  const matches = searchIndexData.filter(e => e[3].toLowerCase().includes(lower));

  if (!matches.length) {
    resultsEl.innerHTML = `<p class=”so-hint”>No results for “${escHtml(q)}”</p>`;
    return;
  }

  // Score by Levenshtein distance between query and value (case-insensitive),
  // tiebreak by value length so shorter/more-exact values rank higher.
  matches.sort((a, b) => {
    const da = levenshtein(lower, a[3].toLowerCase());
    const db = levenshtein(lower, b[3].toLowerCase());
    return da !== db ? da - db : a[3].length - b[3].length;
  });

  const MAX_SHOWN = 200;
  const shown = matches.slice(0, MAX_SHOWN);
  const more  = matches.length - shown.length;
  const allVersions = RAW.meta.versions || [];

  resultsEl.innerHTML = shown.map(e => {
    const [table, col, rowId, val, vf, vl] = e;
    return `<div class="so-result" data-table="${escHtml(table)}" data-row="${escHtml(String(rowId))}">
      <div class="so-result-meta">
        <span class="so-result-table">${escHtml(table)}</span>
        <span style="color:#484f58"> &middot; ${escHtml(col)} &middot; row ${rowId}</span>
      </div>
      <div class="so-result-val">${soHighlight(val, q)}</div>
      ${soVersionBadges(vf, vl, allVersions)}
    </div>`;
  }).join('') +
  (more > 0 ? `<p class="so-hint">… and ${more.toLocaleString()} more &mdash; refine your search</p>` : '');

  resultsEl.querySelectorAll('.so-result').forEach(el => {
    el.addEventListener('click', () => soNavigate(el.dataset.table, el.dataset.row));
  });
}

function soHighlight(val, query) {
  const lower = val.toLowerCase();
  const idx   = lower.indexOf(query.toLowerCase());
  if (idx === -1) return escHtml(val);
  return escHtml(val.slice(0, idx)) +
    `<mark class="so-mark">${escHtml(val.slice(idx, idx + query.length))}</mark>` +
    escHtml(val.slice(idx + query.length));
}

function soVersionBadges(vf, vl, allVersions) {
  if (!vf) return '';
  const label = v => allVersions.find(x => x.id === v)?.label || v;
  if (vl === null) {
    // Still present — show "Since X" unless it's been there from the very first version
    const firstLabel = label(vf);
    const isFirst    = allVersions[0]?.id === vf;
    return isFirst
      ? ''
      : `<div class="so-versions"><span class="so-ver-badge">${escHtml(firstLabel)} &rarr; latest</span></div>`;
  }
  // Removed — show range
  const removed = `<span class="so-ver-badge so-ver-more">${escHtml(label(vf))} &rarr; ${escHtml(label(vl))}</span>`;
  return `<div class="so-versions">${removed}</div>`;
}

function soNavigate(table, rowId) {
  closeSearchOverlay();
  state.searchTarget = { table, rowId };
  if (state.mode !== 'data') document.querySelector('.mode-btn[data-mode="data"]').click();
  dvNavigateTo(table);
}

// Wiring
document.getElementById('search-btn').addEventListener('click', openSearchOverlay);
document.getElementById('so-close').addEventListener('click', closeSearchOverlay);
document.getElementById('search-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('search-overlay')) closeSearchOverlay();
});
document.getElementById('so-input').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(e.target.value), 200);
});
document.getElementById('so-input').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSearchOverlay();
  if (e.key === 'Enter') {
    const first = document.querySelector('.so-result');
    if (first) soNavigate(first.dataset.table, first.dataset.row);
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    document.querySelector('.so-result')?.focus();
  }
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.getElementById('search-overlay').style.display === 'none'
      ? openSearchOverlay() : closeSearchOverlay();
  }
  if (e.key === 'Escape' && document.getElementById('search-overlay').style.display !== 'none') {
    closeSearchOverlay();
  }
});

// ── Init ──────────────────────────────────────────────────────────
{
  const versions = RAW.meta.versions || [];
  if (versions.length > 1) {
    const fromEl = document.getElementById('diff-from');
    const toEl   = document.getElementById('diff-to');
    const clEl   = document.getElementById('cl-version');
    versions.forEach((v, i) => {
      fromEl.appendChild(Object.assign(document.createElement('option'), { value: v.id, textContent: v.label }));
      toEl.appendChild(Object.assign(document.createElement('option'), { value: v.id, textContent: v.label }));
      // Patch Summary: skip the first version (no previous to diff against)
      if (i > 0) clEl.appendChild(Object.assign(document.createElement('option'), { value: v.id, textContent: v.label }));
    });
    document.getElementById('diff-controls').style.display = 'flex';
  }
}
initTableList();
render();
readHash();
