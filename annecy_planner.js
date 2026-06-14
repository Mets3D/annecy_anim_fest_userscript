// ==UserScript==
// @name         Annecy Festival Planner
// @namespace    https://github.com/mets-tools
// @version      0.1.0
// @description  Plan and track your Annecy festival bookings
// @author       Demeter Dzadik
// @match        https://programme.annecyfestival.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// ==/UserScript==

'use strict';

// ---------------------------------------------------------------------------
// DATA MODEL
// ---------------------------------------------------------------------------
// A "screening" looks like:
// {
//   id:     string
//   title:  string
//   type:   string
//   date:   string  — "Sunday 21 June 2026"
//   start:  string  — "HH:MM"
//   end:    string  — "HH:MM"
//   venue:  string
//   url:    string
//   status: string  — one of STATUSES
// }

const STATUSES = [
    'Interested',
    'Will attend without booking',
    "Can't attend due to conflict",
    'Hope to attend different showtime',
    'Want to Book',
    'Backup Book',
    'Booked',
    'Evening Freebie',
];

const STATUS_COLOR = {
    'Interested':                        '#9b59b6',
    'Will attend without booking':       '#3f44d0',
    "Can't attend due to conflict":      '#555',
    'Hope to attend different showtime': '#856448',
    'Want to Book':                      '#fff70b',
    'Backup Book':                       '#b98737',
    'Booked':                            '#2ecc71',
    'Evening Freebie':                   '#4c7912',
};

// ---------------------------------------------------------------------------
// STORAGE
// ---------------------------------------------------------------------------

function migratePlan(data) {
    for (const e of Object.values(data)) {
        if (!e.status) {
            e.status = e.booked ? 'Booked' : 'Interested';
            delete e.booked;
        }
    }
}

function loadPlan() {
    for (const key of ['annecy_plan', 'annecy_plan_backup']) {
        const raw = GM_getValue(key, '');
        if (!raw) continue;
        try {
            const data = JSON.parse(raw);
            if (typeof data !== 'object' || data === null) continue;
            migratePlan(data);
            if (key === 'annecy_plan_backup') {
                console.warn('[Annecy Planner] Primary storage was unreadable — restored from backup.');
            }
            return data;
        } catch {}
    }
    return {};
}

function savePlan(plan) {
    // Preserve previous primary as backup before overwriting
    const prev = GM_getValue('annecy_plan', '');
    if (prev) GM_setValue('annecy_plan_backup', prev);
    GM_setValue('annecy_plan', JSON.stringify(plan));
}

function savePosition(left, top) {
    GM_setValue('annecy_position', JSON.stringify({ left, top }));
}

function saveTlPosition(left, top) {
    GM_setValue('annecy_tl_position', JSON.stringify({ left, top }));
}

function saveTlVisible(visible) {
    GM_setValue('annecy_tl_visible', visible ? '1' : '0');
}

function saveSearch(query) {
    GM_setValue('annecy_search', query);
}

// Returns plan keyed by screening id
let plan = loadPlan();
const pendingNew = new Set();

function setPlanEntry(id, props) {
    if (!plan[id]) pendingNew.add(id);
    plan[id] = { ...(plan[id] || {}), ...props };
    savePlan(plan);
    renderPanel();
}

function removePlanEntry(id) {
    delete plan[id];
    savePlan(plan);
    renderPanel();
}

// ---------------------------------------------------------------------------
// DOM SCRAPING
// ---------------------------------------------------------------------------

// Parses French time format "16h00" → "16:00"
function parseFrTime(str) {
    if (!str) return '';
    const m = str.trim().replace(/^to\s*/i, '').match(/(\d{1,2})h(\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

function findDateForCard(card) {
    // All-days view: cards are grouped under H3 date headers
    const h3 = card.parentElement?.previousElementSibling;
    if (h3?.tagName === 'H3') return h3.textContent.trim();

    // Single-day view: date is only in the page heading e.g. "Programme of Thursday 25 June 2026"
    for (const el of document.querySelectorAll('h1, h2')) {
        const m = el.textContent.match(/programme\s+of\s+(.+)/i);
        if (m) return m[1].trim();
    }

    return '';
}

function extractId(card) {
    const a = card.querySelector('a[href*="/event/"]');
    if (a) {
        const m = a.getAttribute('href').match(/\/event\/([a-f0-9-]{36})/);
        if (m) return m[1];
    }
    // Fallback: hash the text content
    const text = card.textContent.trim().slice(0, 80);
    return text.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0).toString(36);
}

function scrapeDetailPage() {
    const idMatch = location.pathname.match(/\/event\/([a-f0-9-]{36})/);
    if (!idMatch) return null;

    // "Saturday 27 June 2026, from 16h00 to 17h29"
    const dayText = document.querySelector('p.event-day')?.textContent.trim() || '';
    const timeMatch = dayText.match(/^(.+?),\s*from\s+(\d{1,2}h\d{2})\s+to\s+(\d{1,2}h\d{2})/i);

    return {
        id:    idMatch[1],
        title: document.querySelector('h1')?.textContent.trim() || '',
        type:  document.querySelector('[class*="breadcrumb"]')?.textContent.replace(/\s+/g, ' ').trim() || '',
        date:  timeMatch ? timeMatch[1].trim() : '',
        start: timeMatch ? parseFrTime(timeMatch[2]) : '',
        end:   timeMatch ? parseFrTime(timeMatch[3]) : '',
        venue: document.querySelector('a[href="#event-map"]')?.closest('.text-with-icon-text')?.querySelector('span')?.textContent.trim() || '',
        url:   location.href,
    };
}

function scrapeCard(card) {
    const hourSpans = card.querySelectorAll('.card-state .hour span');
    const start = parseFrTime(hourSpans[0]?.textContent);
    const end   = parseFrTime(hourSpans[1]?.textContent);

    const venueItems = card.querySelectorAll('.card-list .text-with-icon p');
    const venue = venueItems[venueItems.length - 1]?.textContent.trim() || '';

    const a = card.querySelector('a.card-link-title, a[href*="/event/"]');

    return {
        id:    extractId(card),
        title: card.querySelector('.card-link-title h2')?.textContent.trim() || '',
        type:  card.querySelector('.card-breadcrumb')?.textContent.replace(/\s+/g, ' ').trim() || '',
        date:  findDateForCard(card),
        start,
        end,
        venue,
        url:   a ? a.href : location.href,
    };
}

// ---------------------------------------------------------------------------
// CONFLICT DETECTION
// ---------------------------------------------------------------------------

function toMinutes(hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

function endMinutes(startMin, endHhmm) {
    const e = toMinutes(endHhmm);
    if (e === null) return null;
    return e < startMin ? e + 24 * 60 : e;
}

function overlaps(a, b) {
    if (a.date !== b.date) return false;
    const aStart = toMinutes(a.start);
    const bStart = toMinutes(b.start);
    if (aStart == null || bStart == null) return false;
    const aEnd = endMinutes(aStart, a.end);
    const bEnd = endMinutes(bStart, b.end);
    if (aEnd == null || bEnd == null) return false;
    // Allow 0-minute gaps (back-to-back is fine)
    return aStart < bEnd && bStart < aEnd;
}

function findConflicts(entries) {
    const conflicts = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            if (overlaps(entries[i], entries[j])) {
                conflicts.push([entries[i].id, entries[j].id]);
            }
        }
    }
    return conflicts;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

GM_addStyle(`
#annecy-planner {
    position: fixed;
    top: 60px;
    right: 12px;
    width: 320px;
    max-height: calc(100vh - 80px);
    display: flex;
    flex-direction: column;
    background: #1a1a2e;
    color: #e0e0e0;
    border: 1px solid #444;
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    z-index: 99999;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    resize: both;
    overflow: hidden;
    min-width: 220px;
    min-height: 120px;
}
#annecy-planner header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: #e63946;
    border-radius: 8px 8px 0 0;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.03em;
    cursor: move;
    user-select: none;
}
#annecy-planner-toggle,
#annecy-planner-import,
#annecy-planner-search-toggle {
    background: none;
    border: none;
    color: #fff;
    font-size: 12px;
    cursor: pointer;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 3px;
}
#annecy-planner-toggle { font-size: 18px; }
#annecy-planner-import:hover { background: rgba(255,255,255,0.15); }
#annecy-planner-filters {
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a4a;
    display: none;
}
#annecy-filter-search {
    width: 100%;
    box-sizing: border-box;
    background: #0d0d1a;
    border: 1px solid #555;
    border-radius: 4px;
    color: #ddd;
    padding: 5px 8px;
    font-size: 12px;
    outline: none;
}
#annecy-filter-search:focus { border-color: #e63946; }
#annecy-planner-body {
    padding: 12px 14px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
}
#annecy-planner .ap-section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #aaa;
    margin: 12px 0 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 5px;
    user-select: none;
}
#annecy-planner .ap-section-title:hover { color: #ddd; }
#annecy-planner .ap-chevron { font-style: normal; flex-shrink: 0; }
@keyframes ap-flash-in {
    from { background-color: #1a4a2e; }
    to   { background-color: #16213e; }
}
#annecy-planner .ap-entry {
    background: #16213e;
    border-radius: 5px;
    padding: 7px 10px;
    margin-bottom: 6px;
    border-left: 3px solid #e63946;
}
#annecy-planner .ap-entry.ap-new { animation: ap-flash-in 1.2s ease-out forwards; }
#annecy-planner .ap-entry .ap-title  { font-weight: 600; margin-bottom: 3px; }
#annecy-planner .ap-entry .ap-title a { color: inherit; text-decoration: none; }
#annecy-planner .ap-entry .ap-title a:hover { text-decoration: underline; }
#annecy-planner .ap-entry .ap-meta   { font-size: 11px; color: #aaa; margin-bottom: 5px; }
#annecy-planner .ap-actions  { display: flex; gap: 6px; margin-top: 4px; align-items: center; }
#annecy-planner .ap-status {
    flex: 1;
    background: #0d0d1a;
    border: 1px solid #555;
    color: #ddd;
    border-radius: 4px;
    padding: 3px 5px;
    font-size: 11px;
    cursor: pointer;
}
#annecy-planner .ap-btn {
    background: #2a2a4a;
    border: 1px solid #555;
    color: #ddd;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
}
#annecy-planner .ap-btn:hover { background: #3a3a6a; }
#annecy-planner .ap-btn.danger { border-color: #e63946; color: #e63946; }
#annecy-planner .ap-empty { color: #666; font-style: italic; text-align: center; padding: 16px 0; }
#annecy-planner-fab {
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 48px;
    height: 48px;
    background: #e63946;
    color: #fff;
    border: none;
    border-radius: 50%;
    font-size: 22px;
    cursor: pointer;
    box-shadow: 0 2px 12px rgba(0,0,0,0.4);
    z-index: 99999;
    display: none;
}
#annecy-timeline {
    position: fixed;
    top: 60px;
    right: 344px;
    width: 1500px;
    max-height: calc(100vh - 70px);
    display: flex;
    flex-direction: column;
    background: #1a1a2e;
    color: #e0e0e0;
    border: 1px solid #444;
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    z-index: 99998;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    resize: both;
    overflow: hidden;
    min-width: 300px;
    min-height: 120px;
}
#annecy-timeline header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: #e63946;
    border-radius: 8px 8px 0 0;
    font-weight: 700;
    font-size: 14px;
    cursor: move;
    user-select: none;
    gap: 8px;
    flex-shrink: 0;
}
#tl-day-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    justify-content: flex-start;
}
#tl-day-label { min-width: 180px; text-align: center; font-size: 12px; font-weight: 400; }
.tl-btn {
    background: none;
    border: none;
    color: #fff;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 13px;
    line-height: 1;
}
.tl-btn:hover { background: rgba(255,255,255,0.15); }
#annecy-tl-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
#tl-labels-col {
    width: 120px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid #333;
    overflow: hidden;
}
.tl-corner {
    height: 28px;
    flex-shrink: 0;
    border-bottom: 1px solid #333;
    background: #12122a;
}
#tl-labels-inner { display: flex; flex-direction: column; will-change: transform; }
.tl-label {
    height: 34px;
    min-height: 34px;
    display: flex;
    align-items: center;
    padding: 0 8px;
    font-size: 11px;
    color: #bbb;
    border-bottom: 1px solid #2a2a4a;
    white-space: nowrap;
    overflow: hidden;
}
#tl-right {
    flex: 1;
    overflow: auto;
    cursor: grab;
}
#tl-right.tl-panning { cursor: grabbing; }
#tl-grid { display: flex; flex-direction: column; }
.tl-axis-row {
    height: 28px;
    min-height: 28px;
    position: sticky;
    top: 0;
    z-index: 1;
    flex-shrink: 0;
    border-bottom: 1px solid #333;
    background: #12122a;
    box-sizing: border-box;
}
.tl-hour-mark {
    position: absolute;
    top: 6px;
    font-size: 10px;
    color: #666;
    transform: translateX(-50%);
    white-space: nowrap;
    pointer-events: none;
}
.tl-track {
    height: 34px;
    min-height: 34px;
    position: relative;
    flex-shrink: 0;
    border-bottom: 1px solid #2a2a4a;
    box-sizing: border-box;
}
.tl-gridline {
    position: absolute;
    top: 0; bottom: 0;
    width: 1px;
    background: #252545;
    pointer-events: none;
}
.tl-event {
    position: absolute;
    top: 4px; bottom: 4px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    overflow: hidden;
    text-decoration: none;
    box-sizing: border-box;
    cursor: pointer;
}
.tl-event:hover { filter: brightness(1.2); z-index: 2; }
.tl-event-label {
    padding: 0 5px;
    font-size: 10px;
    color: rgba(0,0,0,0.85);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
    pointer-events: none;
    user-select: none;
}
#annecy-md-btn {
    background: #2a2a4a;
    border: 1px solid #666;
    color: #ddd;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    font-family: system-ui, sans-serif;
    letter-spacing: 0.05em;
    vertical-align: middle;
}
#annecy-md-btn:hover { background: #3a3a6a; }
`);

function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'annecy-planner';
    panel.innerHTML = `
        <header id="annecy-planner-header">
            🎬 Annecy Planner
            <div style="display:flex;gap:6px;align-items:center;">
                <button id="annecy-planner-timeline" title="Toggle timeline">📊</button>
                <button id="annecy-planner-search-toggle" title="Search">🔍</button>
                <button id="annecy-planner-import" title="Import all hearted events visible on this page">⬇ Import ♥</button>
                <button id="annecy-planner-toggle" title="Minimise">−</button>
            </div>
        </header>
        <div id="annecy-planner-filters">
            <input id="annecy-filter-search" type="text" placeholder="Search title, venue, type…" />
        </div>
        <div id="annecy-planner-body">
            <div class="ap-section-title">Loading…</div>
        </div>
    `;
    document.body.appendChild(panel);

    const savedPos = JSON.parse(GM_getValue('annecy_position', 'null'));
    if (savedPos) {
        panel.style.left  = savedPos.left;
        panel.style.top   = savedPos.top;
        panel.style.right = 'auto';
    }

    // FAB to reopen when minimised
    const fab = document.createElement('button');
    fab.id = 'annecy-planner-fab';
    fab.textContent = '📅';
    fab.title = 'Open Annecy Planner';
    document.body.appendChild(fab);

    document.getElementById('annecy-planner-import').addEventListener('click', importFavourites);
    document.getElementById('annecy-planner-timeline').addEventListener('click', () => {
        const tl = document.getElementById('annecy-timeline');
        const opening = tl.style.display === 'none';
        tl.style.display = opening ? '' : 'none';
        saveTlVisible(opening);
        if (opening) renderTimeline(true);
    });

    const filterBar = document.getElementById('annecy-planner-filters');
    const searchInput = document.getElementById('annecy-filter-search');
    document.getElementById('annecy-planner-search-toggle').addEventListener('click', () => {
        const open = filterBar.style.display !== 'block';
        filterBar.style.display = open ? 'block' : 'none';
        GM_setValue('annecy_search_visible', open ? '1' : '0');
        if (open) searchInput.focus();
        applyFilter();
    });
    searchInput.addEventListener('input', () => {
        saveSearch(searchInput.value);
        applyFilter();
    });

    document.getElementById('annecy-planner-toggle').addEventListener('click', () => {
        panel.style.display = 'none';
        fab.style.display = 'flex';
    });
    fab.addEventListener('click', () => {
        panel.style.display = '';
        fab.style.display = 'none';
    });

    makeDraggable(panel, document.getElementById('annecy-planner-header'));
    return panel;
}

function makeDraggable(el, handle, onDragEnd = savePosition) {
    let ox = 0, oy = 0;
    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        ox = e.clientX - el.getBoundingClientRect().left;
        oy = e.clientY - el.getBoundingClientRect().top;
        const onMove = e => {
            el.style.left  = (e.clientX - ox) + 'px';
            el.style.top   = (e.clientY - oy) + 'px';
            el.style.right = 'auto';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            onDragEnd(el.style.left, el.style.top);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

const collapsedDays = new Set(JSON.parse(GM_getValue('annecy_collapsed', '[]')));

function saveCollapsed() {
    GM_setValue('annecy_collapsed', JSON.stringify([...collapsedDays]));
}

// ---------------------------------------------------------------------------
// TIMELINE
// ---------------------------------------------------------------------------

let timelineDayIndex = 0;
let pxPerHour = 100;

function getTimelineDays() {
    const days = [...new Set(Object.values(plan).map(e => e.date).filter(Boolean))];
    days.sort((a, b) => new Date(a.replace(/^\w+\s+/, '')) - new Date(b.replace(/^\w+\s+/, '')));
    return days;
}

function buildTimeline() {
    const tl = document.createElement('div');
    tl.id = 'annecy-timeline';
    tl.style.display = 'none';
    tl.innerHTML = `
        <header id="annecy-tl-header">
            📊 Timeline
            <div id="tl-day-nav">
                <button class="tl-btn" id="tl-prev">◀</button>
                <span id="tl-day-label">—</span>
                <button class="tl-btn" id="tl-next">▶</button>
            </div>
            <div style="display:flex;gap:4px;">
                <button class="tl-btn" id="tl-close">✕</button>
            </div>
        </header>
        <div id="annecy-tl-body">
            <div id="tl-labels-col">
                <div class="tl-corner"></div>
                <div id="tl-labels-inner"></div>
            </div>
            <div id="tl-right">
                <div id="tl-grid"></div>
            </div>
        </div>
    `;
    document.body.appendChild(tl);

    document.getElementById('tl-prev').addEventListener('click', () => {
        const days = getTimelineDays();
        if (!days.length) return;
        timelineDayIndex = Math.max(0, timelineDayIndex - 1);
        GM_setValue('annecy_tl_day', String(timelineDayIndex));
        renderTimeline(true);
    });
    document.getElementById('tl-next').addEventListener('click', () => {
        const days = getTimelineDays();
        if (!days.length) return;
        timelineDayIndex = Math.min(days.length - 1, timelineDayIndex + 1);
        GM_setValue('annecy_tl_day', String(timelineDayIndex));
        renderTimeline(true);
    });
    document.getElementById('tl-close').addEventListener('click', () => {
        tl.style.display = 'none';
        saveTlVisible(false);
    });

    // Ctrl+wheel to zoom
    const tlRight = document.getElementById('tl-right');
    tlRight.addEventListener('wheel', e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        pxPerHour = Math.max(40, Math.min(400, pxPerHour + (e.deltaY < 0 ? 20 : -20)));
        renderTimeline();
    }, { passive: false });

    // Sync label column scroll with the right area
    tlRight.addEventListener('scroll', () => {
        document.getElementById('tl-labels-inner').style.transform =
            `translateY(-${tlRight.scrollTop}px)`;
    });

    // Click-drag to pan
    let panning = false, panX = 0, panY = 0, scrollX = 0, scrollY = 0;
    tlRight.addEventListener('mousedown', e => {
        if (e.target.closest('.tl-event')) return;
        panning = true;
        panX = e.clientX; panY = e.clientY;
        scrollX = tlRight.scrollLeft; scrollY = tlRight.scrollTop;
        tlRight.classList.add('tl-panning');
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!panning) return;
        tlRight.scrollLeft = scrollX - (e.clientX - panX);
        tlRight.scrollTop  = scrollY - (e.clientY - panY);
    });
    document.addEventListener('mouseup', () => {
        panning = false;
        tlRight.classList.remove('tl-panning');
    });

    const savedTlPos = JSON.parse(GM_getValue('annecy_tl_position', 'null'));
    if (savedTlPos) {
        tl.style.left  = savedTlPos.left;
        tl.style.top   = savedTlPos.top;
        tl.style.right = 'auto';
    }

    const savedTlSize = JSON.parse(GM_getValue('annecy_tl_size', 'null'));
    if (savedTlSize) {
        tl.style.width  = savedTlSize.width  + 'px';
        tl.style.height = savedTlSize.height + 'px';
    }

    timelineDayIndex = parseInt(GM_getValue('annecy_tl_day', '0'), 10) || 0;

    let tlResizeTimer = null;
    new ResizeObserver(() => {
        clearTimeout(tlResizeTimer);
        tlResizeTimer = setTimeout(() => {
            GM_setValue('annecy_tl_size', JSON.stringify({ width: tl.offsetWidth, height: tl.offsetHeight }));
        }, 300);
    }).observe(tl);

    if (GM_getValue('annecy_tl_visible', '0') === '1') {
        tl.style.display = '';
        renderTimeline(true);
    }

    makeDraggable(tl, document.getElementById('annecy-tl-header'), saveTlPosition);
}

function renderTimeline(autoFit = false) {
    const tl = document.getElementById('annecy-timeline');
    if (!tl || tl.style.display === 'none') return;

    const days = getTimelineDays();
    const labelsInner = document.getElementById('tl-labels-inner');
    const grid = document.getElementById('tl-grid');
    const dayLabel = document.getElementById('tl-day-label');

    if (!days.length) {
        dayLabel.textContent = '—';
        labelsInner.innerHTML = '';
        grid.innerHTML = '<div style="padding:16px;color:#666;font-style:italic;white-space:nowrap">No sessions with dates yet.</div>';
        return;
    }

    timelineDayIndex = Math.max(0, Math.min(days.length - 1, timelineDayIndex));
    const day = days[timelineDayIndex];
    dayLabel.textContent = day;
    document.getElementById('tl-prev').style.visibility = timelineDayIndex > 0 ? '' : 'hidden';
    document.getElementById('tl-next').style.visibility = timelineDayIndex < days.length - 1 ? '' : 'hidden';

    const timed = Object.values(plan).filter(e => e.date === day && e.start && e.end);

    // Compute time range
    let minMin = Infinity, maxMin = -Infinity;
    for (const e of timed) {
        const s = toMinutes(e.start);
        const en = endMinutes(s, e.end);
        if (s !== null) minMin = Math.min(minMin, s);
        if (en !== null) maxMin = Math.max(maxMin, en);
    }
    if (!isFinite(minMin)) { minMin = 9 * 60; maxMin = 22 * 60; }
    minMin = Math.max(0, minMin - 30);
    maxMin = Math.min(24 * 60, maxMin + 30);

    const totalMin = maxMin - minMin;
    const totalW = Math.round(totalMin / 60 * pxPerHour);

    // Group by venue
    const venueMap = new Map();
    for (const e of timed) {
        const v = e.venue || 'Unknown venue';
        if (!venueMap.has(v)) venueMap.set(v, []);
        venueMap.get(v).push(e);
    }
    const venues = [...venueMap.keys()].sort();

    const startHour = Math.ceil(minMin / 60);
    const endHour = Math.floor(maxMin / 60);

    // Labels column
    labelsInner.innerHTML = venues.map(v =>
        `<div class="tl-label" title="${escHtml(v)}">${escHtml(v)}</div>`
    ).join('');

    // Time axis row
    let axisHtml = `<div class="tl-axis-row" style="width:${totalW}px">`;
    for (let h = startHour; h <= endHour; h++) {
        const left = Math.round((h * 60 - minMin) / 60 * pxPerHour);
        axisHtml += `<div class="tl-hour-mark" style="left:${left}px">${String(h).padStart(2,'0')}:00</div>`;
    }
    axisHtml += '</div>';

    // Venue tracks
    const tracksHtml = venues.map(v => {
        let html = `<div class="tl-track" style="width:${totalW}px">`;
        for (let h = startHour; h <= endHour; h++) {
            const left = Math.round((h * 60 - minMin) / 60 * pxPerHour);
            html += `<div class="tl-gridline" style="left:${left}px"></div>`;
        }
        for (const e of venueMap.get(v)) {
            const s = toMinutes(e.start);
            const en = endMinutes(s, e.end);
            const left  = Math.round((s - minMin) / 60 * pxPerHour);
            const width = Math.max(4, Math.round((en - s) / 60 * pxPerHour));
            const color = STATUS_COLOR[e.status] || STATUS_COLOR['Interested'];
            html += `<a class="tl-event" href="${escHtml(e.url)}" target="_blank"
                style="left:${left}px;width:${width}px;background:${color}"
                title="${escHtml(e.title)} · ${escHtml(e.start)}–${escHtml(e.end)} · ${escHtml(e.status)}">
                <span class="tl-event-label">${escHtml(e.title)}</span>
            </a>`;
        }
        html += '</div>';
        return html;
    }).join('');

    grid.innerHTML = axisHtml + tracksHtml;

    if (autoFit && venues.length > 0) {
        const headerH = document.getElementById('annecy-tl-header')?.offsetHeight ?? 44;
        const targetW = 120 + totalW + 18;
        const targetH = headerH + 28 + venues.length * 34 + 18;
        tl.style.width  = Math.min(targetW, window.innerWidth  - 24) + 'px';
        tl.style.height = Math.min(targetH, window.innerHeight - 24) + 'px';
    }
}

function renderPanel() {
    const body = document.getElementById('annecy-planner-body');
    if (!body) return;
    const entries = Object.values(plan);

    if (entries.length === 0) {
        body.innerHTML = `<div class="ap-empty">No sessions saved yet.<br>Browse the programme and flag sessions.</div>`;
        return;
    }

    // Sort by date then start time.
    // Date strings are "Sunday 21 June 2026" — strip the day name before parsing.
    const toDate = str => new Date(str.replace(/^\w+\s+/, ''));
    entries.sort((a, b) => {
        const d = toDate(a.date || '') - toDate(b.date || '');
        if (d !== 0) return d;
        return (a.start || '').localeCompare(b.start || '');
    });

    let html = '';

    const byDate = {};
    for (const e of entries) {
        (byDate[e.date || 'Unknown date'] ??= []).push(e);
    }

    for (const [date, group] of Object.entries(byDate)) {
        const collapsed = collapsedDays.has(date);
        html += `<div class="ap-section-title" data-day="${escHtml(date)}">
            <span class="ap-chevron">${collapsed ? '▶' : '▼'}</span>${escHtml(date)}
        </div>
        <div class="ap-day-entries" ${collapsed ? 'style="display:none"' : ''}>`;
        for (const e of group) {
            const color = STATUS_COLOR[e.status] || STATUS_COLOR['Interested'];
            const options = STATUSES.map(s =>
                `<option value="${escHtml(s)}" ${e.status === s ? 'selected' : ''}>${escHtml(s)}</option>`
            ).join('');
            html += `
                <div class="ap-entry" data-id="${escHtml(e.id)}" style="border-left-color:${color}">
                    <div class="ap-title">${e.url ? `<a href="${escHtml(e.url)}" target="_blank">${escHtml(e.title || '(no title)')}</a>` : escHtml(e.title || '(no title)')}</div>
                    <div class="ap-meta">
                        ${escHtml(e.start || '?')}–${escHtml(e.end || '?')}
                        ${e.venue ? ' · ' + escHtml(e.venue) : ''}
                    </div>
                    <div class="ap-actions">
                        <select class="ap-status" data-action="set-status">${options}</select>
                        <button class="ap-btn danger" data-action="remove">✕</button>
                    </div>
                </div>`;
        }
        html += `</div>`;
    }

    body.innerHTML = html;

    pendingNew.forEach(id => {
        body.querySelector(`[data-id="${id}"]`)?.classList.add('ap-new');
    });
    pendingNew.clear();
    applyFilter();

    body.querySelectorAll('.ap-section-title').forEach(title => {
        title.addEventListener('click', () => {
            const day = title.dataset.day;
            if (collapsedDays.has(day)) collapsedDays.delete(day);
            else collapsedDays.add(day);
            saveCollapsed();
            renderPanel();
        });
    });

    body.querySelectorAll('select[data-action="set-status"]').forEach(sel => {
        sel.addEventListener('change', () => {
            const id = sel.closest('[data-id]').dataset.id;
            setPlanEntry(id, { status: sel.value });
        });
    });

    body.querySelectorAll('button[data-action="remove"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.closest('[data-id]').dataset.id;
            removeEntryAndUnheart(id);
        });
    });

    renderTimeline();
}

function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------------------------------------------------------------------------
// PAGE INTEGRATION
// ---------------------------------------------------------------------------

function applyFilter() {
    const filterBar = document.getElementById('annecy-planner-filters');
    const barVisible = filterBar?.style.display === 'block';
    const q = barVisible ? (document.getElementById('annecy-filter-search')?.value || '').toLowerCase().trim() : '';
    document.querySelectorAll('#annecy-planner-body .ap-entry').forEach(el => {
        const e = plan[el.dataset.id];
        const match = !q || [e?.title, e?.venue, e?.type].some(f => f?.toLowerCase().includes(q));
        el.style.display = match ? '' : 'none';
    });
    document.querySelectorAll('#annecy-planner-body .ap-day-entries').forEach(dayEl => {
        const hasVisible = [...dayEl.querySelectorAll('.ap-entry')].some(e => e.style.display !== 'none');
        const title = dayEl.previousElementSibling;
        if (!hasVisible) {
            if (title) title.style.display = 'none';
            dayEl.style.display = 'none';
        } else {
            if (title) title.style.display = '';
            const day = title?.dataset.day;
            dayEl.style.display = (day && collapsedDays.has(day)) ? 'none' : '';
        }
    });
}

function removeEntryAndUnheart(id) {
    // Check for a card in the listing
    const a = document.querySelector(`article.card a[href*="${id}"]`);
    const cardHeart = a?.closest('article.card')?.querySelector('button[title*="Delete"][title*="favourites"]');
    // Check if we're on the detail page for this exact event
    const pageHeart = location.pathname.includes(id)
        ? document.querySelector('button[title*="Delete"][title*="favourites"]')
        : null;
    const heart = cardHeart || pageHeart;
    if (heart) {
        heart.click(); // syncOnHeartClick will call removePlanEntry
    } else {
        removePlanEntry(id);
    }
}

function importFavourites() {
    const cards = document.querySelectorAll('article.card');
    let added = 0;
    cards.forEach(card => {
        const heart = card.querySelector('button[title*="Delete"][title*="favourites"]');
        if (!heart) return;
        const screening = scrapeCard(card);
        if (!plan[screening.id]) {
            plan[screening.id] = { ...screening, status: 'Interested' };
            added++;
        }
    });
    if (added > 0) {
        savePlan(plan);
        renderPanel();
    }
    const btn = document.getElementById('annecy-planner-import');
    btn.textContent = added > 0 ? `✓ ${added} imported` : '✓ Nothing new';
    setTimeout(() => { btn.textContent = '⬇ Import ♥'; }, 2500);
}

function syncAcrossTabs() {
    GM_addValueChangeListener('annecy_plan', (_name, _old, newVal, remote) => {
        if (!remote) return;
        try {
            const data = JSON.parse(newVal);
            if (typeof data === 'object' && data !== null) {
                migratePlan(data);
                plan = data;
                renderPanel();
            }
        } catch {}
    });

    GM_addValueChangeListener('annecy_collapsed', (_name, _old, newVal, remote) => {
        if (!remote) return;
        try {
            const days = JSON.parse(newVal);
            if (Array.isArray(days)) {
                collapsedDays.clear();
                days.forEach(d => collapsedDays.add(d));
                renderPanel();
            }
        } catch {}
    });

    GM_addValueChangeListener('annecy_search', (_name, _old, newVal, remote) => {
        if (!remote) return;
        const input = document.getElementById('annecy-filter-search');
        if (!input) return;
        input.value = newVal || '';
        applyFilter();
    });

    GM_addValueChangeListener('annecy_search_visible', (_name, _old, newVal, remote) => {
        if (!remote) return;
        document.getElementById('annecy-planner-filters').style.display = newVal === '1' ? 'block' : 'none';
        applyFilter();
    });

    GM_addValueChangeListener('annecy_position', (_name, _old, newVal, remote) => {
        if (!remote) return;
        try {
            const pos = JSON.parse(newVal);
            if (pos) {
                const panel = document.getElementById('annecy-planner');
                if (panel) {
                    panel.style.left  = pos.left;
                    panel.style.top   = pos.top;
                    panel.style.right = 'auto';
                }
            }
        } catch {}
    });

    GM_addValueChangeListener('annecy_tl_position', (_name, _old, newVal, remote) => {
        if (!remote) return;
        try {
            const pos = JSON.parse(newVal);
            if (pos) {
                const tl = document.getElementById('annecy-timeline');
                if (tl) {
                    tl.style.left  = pos.left;
                    tl.style.top   = pos.top;
                    tl.style.right = 'auto';
                }
            }
        } catch {}
    });

    GM_addValueChangeListener('annecy_tl_visible', (_name, _old, newVal, remote) => {
        if (!remote) return;
        const tl = document.getElementById('annecy-timeline');
        if (!tl) return;
        const opening = newVal === '1';
        tl.style.display = opening ? '' : 'none';
        if (opening) renderTimeline();
    });

    GM_addValueChangeListener('annecy_tl_day', (_name, _old, newVal, remote) => {
        if (!remote) return;
        timelineDayIndex = parseInt(newVal, 10) || 0;
        renderTimeline(true);
    });

    GM_addValueChangeListener('annecy_tl_size', (_name, _old, newVal, remote) => {
        if (!remote) return;
        try {
            const size = JSON.parse(newVal);
            if (size) {
                const tl = document.getElementById('annecy-timeline');
                if (tl) {
                    tl.style.width  = size.width  + 'px';
                    tl.style.height = size.height + 'px';
                }
            }
        } catch {}
    });
}

function syncOnHeartClick() {
    // Read the heart's title BEFORE Vue flips it — "Add" means it's about to be added.
    document.addEventListener('click', e => {
        const heart = e.target.closest('button[title*="favourites"]');
        if (!heart) return;
        const adding = heart.title.includes('Add');
        const card = heart.closest('article.card');
        const screening = card ? scrapeCard(card) : scrapeDetailPage();
        if (!screening) return;
        if (adding) {
            const existing = plan[screening.id];
            setPlanEntry(screening.id, { ...screening, status: existing?.status ?? 'Interested' });
        } else {
            removePlanEntry(screening.id);
        }
    });
}

// ---------------------------------------------------------------------------
// DETAIL PAGE: MARKDOWN COPY BUTTON
// ---------------------------------------------------------------------------

function injectMdCopyButton() {
    if (!location.pathname.match(/\/event\/[a-f0-9-]{36}/)) return;

    function tryInsert() {
        if (document.getElementById('annecy-md-btn')) return true;
        const target = document.querySelector('div.column.button-wrapper') || document.querySelector('h1');
        if (!target) return false;

        const btn = document.createElement('button');
        btn.id = 'annecy-md-btn';
        btn.textContent = 'MD';
        btn.title = 'Copy markdown link to clipboard';
        btn.addEventListener('click', () => {
            const title = document.querySelector('h1')?.textContent.trim() || '';
            navigator.clipboard.writeText(`[${title}](${location.href})`).then(() => {
                btn.textContent = '✓';
                setTimeout(() => { btn.textContent = 'MD'; }, 1500);
            });
        });

        if (target.tagName === 'H1') {
            target.insertAdjacentElement('afterend', btn);
        } else {
            target.prepend(btn);
        }
        return true;
    }

    if (!tryInsert()) {
        const obs = new MutationObserver(() => { if (tryInsert()) obs.disconnect(); });
        obs.observe(document.body, { childList: true, subtree: true });
    }
}

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------

function init() {
    buildPanel();
    buildTimeline();

    const savedSearch = GM_getValue('annecy_search', '');
    const savedSearchVisible = GM_getValue('annecy_search_visible', '0');
    if (savedSearch) {
        const input = document.getElementById('annecy-filter-search');
        if (input) input.value = savedSearch;
    }
    if (savedSearchVisible === '1') {
        document.getElementById('annecy-planner-filters').style.display = 'block';
    }

    renderPanel();
    syncOnHeartClick();
    syncAcrossTabs();
    injectMdCopyButton();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
