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

const STATUS_ENTRIES = [
    ['Interested',                        '#9b59b6'],
    ['Will attend without booking',       '#3f44d0'],
    ["Can't attend due to conflict",      '#555'   ],
    ['Hope to attend different showtime', '#8a3a5c'],
    ['Want to Book',                      '#8a7500'],
    ['Backup Book',                       '#a1541c'],
    ['Booked',                            '#1e8449'],
    ['Evening Freebie',                   '#1f6e7a'],
];

const STATUSES     = STATUS_ENTRIES.map(([s]) => s);
const STATUS_COLOR = Object.fromEntries(STATUS_ENTRIES);
const UI = {
    bg:            '#1a1a2e', // panel / timeline / popup background
    bgRaised:      '#16213e', // entry card background
    bgSunken:      '#0d0d1a', // input / select background
    bgButton:      '#2a2a4a', // button background, and some subtle borders/dividers
    bgButtonHover: '#3a3a6a', // button hover background
    bgGridHeader:  '#12122a', // timeline corner/axis row background
    bgFlashStart:  '#1a4a2e', // 'just added' flash animation start color

    border:      '#555', // input / button / popup border
    borderSoft:  '#444', // outer panel/timeline border, export table dividers
    borderFaint: '#333', // timeline grid dividers
    gridline:    '#252545', // timeline hour gridlines

    text:         '#e0e0e0', // primary text
    textDim:      '#ddd',    // button/input text
    textMuted:    '#aaa',    // secondary/meta text
    textFaint:    '#666',    // empty-state / axis label text
    textFainter:  '#bbb',    // timeline venue label text
    textOnAccent: '#fff',    // text/icons on the accent-colored bar and buttons

    accent: '#3b4398', // header bar, danger button, focus ring, FAB

    hoverWash:   'rgba(255,255,255,0.4)',
    shadow:      'rgba(0,0,0,0.5)',
    shadowSoft:  'rgba(0,0,0,0.4)',
    shadowPopup: 'rgba(0,0,0,0.6)',

    // Only used in the Google-Sheets clipboard export, which is static
    // markup pasted outside the browser, so it can't reference these
    // via CSS variables - this object is the shared source of truth instead.
    exportDateBg:   '#2d1b4e',
    exportBorder:   '#ccc',
    exportLinkBlue: '#1155cc',
    exportTypeText: '#888',
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

function saveScroll(top) {
    panelScrollTop = top;
    GM_setValue('annecy_scroll', String(top));
}

function saveSearch(query) {
    GM_setValue('annecy_search', query);
}

// Returns plan keyed by screening id
let plan = loadPlan();
const pendingNew = new Set();

// Kept in sync (locally and cross-tab) so renderPanel() can restore it
// after every rebuild - body.innerHTML resets scrollTop to 0 otherwise.
let panelScrollTop = parseInt(GM_getValue('annecy_scroll', '0'), 10) || 0;

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
.annecy-window {
    transition: transform 0.22s ease-out, opacity 0.16s ease;
}
.annecy-window.annecy-hidden {
    opacity: 0;
    transform: scale(0.05);
    pointer-events: none;
}
#annecy-planner {
    position: fixed;
    top: 60px;
    right: 12px;
    width: 380px;
    max-height: calc(100vh - 80px);
    display: flex;
    flex-direction: column;
    background: ${UI.bg};
    color: ${UI.text};
    border: 1px solid ${UI.borderSoft};
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    z-index: 99999;
    box-shadow: 0 4px 24px ${UI.shadow};
    box-sizing: border-box;
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
    background: ${UI.accent};
    border-radius: 8px 8px 0 0;
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.03em;
    cursor: move;
    user-select: none;
}
#annecy-planner-import,
#annecy-planner-export {
    background: none;
    border: none;
    color: ${UI.textOnAccent};
    font-size: 16px;
    cursor: pointer;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 3px;
}
#annecy-planner-import:hover,
#annecy-planner-export:hover { background: ${UI.hoverWash}; }
#annecy-planner-filters {
    padding: 8px 14px;
    border-bottom: 1px solid ${UI.bgButton};
}
#annecy-filter-search {
    width: 100%;
    box-sizing: border-box;
    background: ${UI.bgSunken};
    border: 1px solid ${UI.border};
    border-radius: 4px;
    color: ${UI.textDim};
    padding: 5px 8px;
    font-size: 12px;
    outline: none;
}
#annecy-filter-search:focus { border-color: ${UI.accent}; }
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
    color: ${UI.textMuted};
    margin: 12px 0 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 5px;
    user-select: none;
}
#annecy-planner .ap-section-title:hover { color: ${UI.textDim}; }
#annecy-planner .ap-chevron { font-style: normal; flex-shrink: 0; }
@keyframes ap-flash-in {
    from { background-color: ${UI.bgFlashStart}; }
    to   { background-color: ${UI.bgRaised}; }
}
#annecy-planner .ap-entry {
    background: ${UI.bgRaised};
    border-radius: 5px;
    padding: 7px 10px;
    margin-bottom: 6px;
    border-left: 3px solid ${UI.accent};
}
#annecy-planner .ap-entry.ap-new { animation: ap-flash-in 1.2s ease-out forwards; }
#annecy-planner .ap-entry .ap-title  { font-weight: 600; margin-bottom: 3px; }
#annecy-planner .ap-entry .ap-title a { color: inherit; text-decoration: none; }
#annecy-planner .ap-entry .ap-title a:hover { text-decoration: underline; }
#annecy-planner .ap-entry .ap-meta   { font-size: 11px; color: ${UI.textMuted}; margin-bottom: 5px; }
#annecy-planner .ap-actions  { display: flex; gap: 6px; margin-top: 4px; align-items: center; }
#annecy-planner .ap-status {
    flex: 1;
    background: ${UI.bgSunken};
    border: 1px solid ${UI.border};
    color: ${UI.textDim};
    border-radius: 4px;
    padding: 3px 5px;
    font-size: 11px;
    cursor: pointer;
}
#annecy-planner .ap-btn {
    background: ${UI.bgButton};
    border: 1px solid ${UI.border};
    color: ${UI.textDim};
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
}
#annecy-planner .ap-btn:hover { background: ${UI.bgButtonHover}; }
#annecy-planner .ap-btn.danger { border-color: ${UI.accent}; color: ${UI.accent}; }
#annecy-planner .ap-empty { color: ${UI.textFaint}; font-style: italic; text-align: center; padding: 16px 0; }
.annecy-fab {
    position: fixed;
    bottom: 24px;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${UI.bgButton};
    color: ${UI.textOnAccent};
    border: none;
    border-radius: 50%;
    font-size: 22px;
    cursor: pointer;
    box-shadow: 0 2px 12px ${UI.shadowSoft};
    z-index: 99999;
}
.annecy-fab:hover { background: ${UI.bgButtonHover}; }
.annecy-fab.annecy-fab-active { background: ${UI.accent}; }
.annecy-fab.annecy-fab-active:hover { filter: brightness(1.15); }
#annecy-planner-fab   { right: 24px; }
#annecy-timeline-fab  { right: 84px; }
#annecy-timeline {
    position: fixed;
    top: 60px;
    right: 344px;
    width: 1500px;
    max-height: calc(100vh - 70px);
    display: flex;
    flex-direction: column;
    background: ${UI.bg};
    color: ${UI.text};
    border: 1px solid ${UI.borderSoft};
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    z-index: 99998;
    box-shadow: 0 4px 24px ${UI.shadow};
    box-sizing: border-box;
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
    background: ${UI.accent};
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
.annecy-icon-btn {
    background: none;
    border: none;
    color: ${UI.textOnAccent};
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 13px;
    line-height: 1;
}
.annecy-icon-btn:hover { background: ${UI.hoverWash}; }
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
    border-right: 1px solid ${UI.borderFaint};
    overflow: hidden;
}
.tl-corner {
    height: 28px;
    flex-shrink: 0;
    border-bottom: 1px solid ${UI.borderFaint};
    background: ${UI.bgGridHeader};
    box-sizing: border-box;
}
#tl-labels-inner { display: flex; flex-direction: column; will-change: transform; }
.tl-label {
    height: 34px;
    min-height: 34px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    padding: 0 8px;
    font-size: 11px;
    color: ${UI.textFainter};
    border-bottom: 1px solid ${UI.bgButton};
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
    border-bottom: 1px solid ${UI.borderFaint};
    background: ${UI.bgGridHeader};
    box-sizing: border-box;
}
.tl-hour-mark {
    position: absolute;
    top: 6px;
    font-size: 10px;
    color: ${UI.textFaint};
    transform: translateX(-50%);
    white-space: nowrap;
    pointer-events: none;
}
.tl-track {
    height: 34px;
    min-height: 34px;
    position: relative;
    flex-shrink: 0;
    border-bottom: 1px solid ${UI.bgButton};
    box-sizing: border-box;
}
.tl-gridline {
    position: absolute;
    top: 0; bottom: 0;
    width: 1px;
    background: ${UI.gridline};
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
    color: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
    pointer-events: none;
    user-select: none;
}
#annecy-md-btn {
    background: ${UI.bgButton};
    border: 1px solid ${UI.textFaint};
    color: ${UI.textDim};
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    font-family: system-ui, sans-serif;
    letter-spacing: 0.05em;
    vertical-align: middle;
}
#annecy-md-btn:hover { background: ${UI.bgButtonHover}; }
#tl-popup {
    position: fixed;
    z-index: 100000;
    background: ${UI.bg};
    border: 1px solid ${UI.border};
    border-radius: 6px;
    padding: 10px 12px;
    min-width: 220px;
    max-width: 300px;
    box-shadow: 0 4px 16px ${UI.shadowPopup};
    font-family: system-ui, sans-serif;
    font-size: 12px;
    color: ${UI.text};
    display: none;
}
#tl-popup .tl-popup-title {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#tl-popup .tl-popup-meta {
    font-size: 11px;
    color: ${UI.textMuted};
    margin-bottom: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
#tl-popup .tl-popup-actions { display: flex; flex-direction: column; gap: 6px; }
#tl-popup-open {
    display: block;
    text-align: center;
    background: ${UI.bgButton};
    border: 1px solid ${UI.border};
    color: ${UI.textDim};
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 11px;
    cursor: pointer;
    text-decoration: none;
}
#tl-popup-open:hover { background: ${UI.bgButtonHover}; color: ${UI.textOnAccent}; }
#tl-popup-status {
    width: 100%;
    background: ${UI.bgSunken};
    border: 1px solid ${UI.border};
    color: ${UI.textDim};
    border-radius: 4px;
    padding: 3px 5px;
    font-size: 11px;
    cursor: pointer;
    box-sizing: border-box;
}
`);

// Sets a window's visibility and puts its summoning button into the
// matching active/inactive look - the single place both of those stay
// in sync, whether set instantly (initial page state) or animated below.
function setWindowOpen(win, anchorBtn, open) {
    win.classList.toggle('annecy-hidden', !open);
    anchorBtn.classList.toggle('annecy-fab-active', open);
}

// Shows/hides a floating window with a "genie" effect anchored at the
// button that summoned it - scales/fades toward that button's actual
// on-screen position, rather than just its own corner, so it visually
// comes out of / goes back into wherever that button currently sits.
function toggleWindow(win, anchorBtn, opening) {
    // getBoundingClientRect() reflects the current CSS transform - if we're
    // about to open a window that's currently .annecy-hidden (scaled down
    // to 5%), measuring it now would give us that shrunk box instead of the
    // natural one it's opening to. Briefly drop the hidden state (with
    // transitions off, so nothing flashes) to measure the real box, then
    // restore it before actually animating via setWindowOpen below.
    if (opening) {
        win.style.transition = 'none';
        win.classList.remove('annecy-hidden');
    }

    const ar = anchorBtn.getBoundingClientRect();
    const wr = win.getBoundingClientRect();
    if (wr.width && wr.height) {
        const originX = ((ar.left + ar.width / 2) - wr.left) / wr.width * 100;
        const originY = ((ar.top + ar.height / 2) - wr.top) / wr.height * 100;
        win.style.transformOrigin = `${originX}% ${originY}%`;
    }

    if (opening) {
        win.classList.add('annecy-hidden');
        void win.offsetWidth; // force a reflow so the transition re-engages
        win.style.transition = '';
    }

    setWindowOpen(win, anchorBtn, opening);
    // A window being summoned locally should render above the other one,
    // same as dragging/resizing it. Remote opens (synced from another tab)
    // go through setWindowOpenInstant() instead, skipping the animation -
    // their stacking position is synced separately via annecy_top_win.
    if (opening) bringToFront(win);
}

// Applies open/closed state instantly, with no genie animation - used when
// mirroring another tab's visibility change, since that transition already
// played (or is playing) over there and shouldn't replay again here too.
function setWindowOpenInstant(win, anchorBtn, open) {
    win.style.transition = 'none';
    setWindowOpen(win, anchorBtn, open);
    void win.offsetWidth; // force a reflow so the transition re-engages next time
    win.style.transition = '';
}

function createFab(id, emoji, title) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = 'annecy-fab';
    btn.textContent = emoji;
    btn.title = title;
    document.body.appendChild(btn);
    return btn;
}

function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'annecy-planner';
    panel.className = 'annecy-window';
    panel.innerHTML = `
        <header id="annecy-planner-header">
            Annecy Planner
            <div style="display:flex;gap:6px;align-items:center;">
                <button id="annecy-planner-export" title="Copy all data to clipboard (can be pasted into Google Sheets)">📋</button>
                <button id="annecy-planner-import" title="Import all hearted events visible on this page">Import</button>
                <button id="annecy-planner-toggle" class="annecy-icon-btn">✕</button>
            </div>
        </header>
        <div id="annecy-planner-filters">
            <input id="annecy-filter-search" type="text" placeholder="🔎 Search title, venue, type…" />
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

    // Permanent corner button to toggle the panel minimised/open, and one
    // next to it for the timeline - same element shape, same styling.
    const fab = createFab('annecy-planner-fab', '📅', 'Toggle Annecy Planner');
    fab.classList.add('annecy-fab-active'); // panel starts open
    fab.addEventListener('click', toggleMinimised);

    const timelineFab = createFab('annecy-timeline-fab', '📊', 'Toggle timeline');
    timelineFab.addEventListener('click', () => {
        const tl = document.getElementById('annecy-timeline');
        const opening = tl.classList.contains('annecy-hidden');
        toggleWindow(tl, timelineFab, opening);
        saveTlVisible(opening);
        if (opening) renderTimeline(true);
    });

    document.getElementById('annecy-planner-import').addEventListener('click', importFavourites);
    document.getElementById('annecy-planner-export').addEventListener('click', exportToClipboard);

    const searchInput = document.getElementById('annecy-filter-search');
    searchInput.addEventListener('input', () => {
        saveSearch(searchInput.value);
        applyFilter();
    });

    const body = document.getElementById('annecy-planner-body');
    let scrollTimer = null;
    body.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            if (body.scrollTop !== panelScrollTop) {
                saveScroll(body.scrollTop);
            }
        }, 300);
    });

    document.getElementById('annecy-planner-toggle').addEventListener('click', toggleMinimised);

    function toggleMinimised() {
        const opening = panel.classList.contains('annecy-hidden');
        toggleWindow(panel, fab, opening);
        GM_setValue('annecy_minimised', opening ? '0' : '1');
    }

    makeResizable(panel, 'annecy_size');
    makeDraggable(panel, document.getElementById('annecy-planner-header'));
    return panel;
}

// Both floating windows share a stacking context; whichever one the user
// last dragged, resized, or opened should render on top of the other -
// and that ordering is synced across tabs via annecy_top_win below. topZ
// only ever increases, so each local bring-to-front is guaranteed higher
// than whatever came before (including the windows' CSS base z-indexes).
let topZ = 99999;
function bringToFrontLocal(win) {
    win.style.zIndex = String(++topZ);
}
function bringToFront(win) {
    bringToFrontLocal(win);
    GM_setValue('annecy_top_win', win.id);
}

// Resizes applied by applyRemoteSize() (i.e. synced from another tab)
// shouldn't count as "the user resized this window" for bringToFront
// purposes - this tracks which elements' next ResizeObserver firing
// should be treated as such a sync rather than a real interaction.
const pendingRemoteResize = new WeakSet();

function makeDraggable(el, handle, onDragEnd = savePosition) {
    let ox = 0, oy = 0;
    handle.addEventListener('mousedown', e => {
        e.preventDefault();
        bringToFront(el);
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

// Restores a persisted size on load and saves it (debounced) whenever the
// element is resized via its `resize: both` handle - the resize counterpart
// to makeDraggable's position persistence.
function makeResizable(el, storageKey) {
    const saved = JSON.parse(GM_getValue(storageKey, 'null'));
    if (saved) {
        el.style.width  = saved.width  + 'px';
        el.style.height = saved.height + 'px';
    }

    let resizeTimer = null;
    // ResizeObserver fires once immediately on observe(), with no user
    // interaction involved - skip bringToFront for that first firing too.
    let firstObservation = true;
    new ResizeObserver(() => {
        if (firstObservation || pendingRemoteResize.has(el)) {
            firstObservation = false;
            pendingRemoteResize.delete(el);
        } else {
            bringToFront(el);
        }
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            GM_setValue(storageKey, JSON.stringify({ width: el.offsetWidth, height: el.offsetHeight }));
        }, 300);
    }).observe(el);
}

// Applies a size received from another tab, but only if it actually
// differs from the current one. Both windows are box-sizing: border-box
// now, so offsetWidth/offsetHeight and style.width/height round-trip
// losslessly - this skip is just insurance against triggering this tab's
// own ResizeObserver (and thus a redundant GM_setValue) for a no-op.
function applyRemoteSize(el, size) {
    if (!el || !size) return;
    if (el.offsetWidth === size.width && el.offsetHeight === size.height) return;
    pendingRemoteResize.add(el);
    el.style.width  = size.width  + 'px';
    el.style.height = size.height + 'px';
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
    tl.className = 'annecy-window annecy-hidden';
    tl.innerHTML = `
        <header id="annecy-tl-header">
            <div id="tl-day-nav">
                <button class="annecy-icon-btn" id="tl-prev">◀</button>
                <span id="tl-day-label">—</span>
                <button class="annecy-icon-btn" id="tl-next">▶</button>
            </div>
            <div style="display:flex;gap:4px;">
                <button class="annecy-icon-btn" id="tl-close">✕</button>
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
        toggleWindow(tl, document.getElementById('annecy-timeline-fab'), false);
        saveTlVisible(false);
        document.getElementById('tl-popup').style.display = 'none';
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

    // Event popup
    const popup = document.createElement('div');
    popup.id = 'tl-popup';
    popup.innerHTML = `
        <div class="tl-popup-title"></div>
        <div class="tl-popup-meta"></div>
        <div class="tl-popup-actions">
            <a id="tl-popup-open" target="_blank">Open event page ↗</a>
            <select id="tl-popup-status"></select>
        </div>
    `;
    document.body.appendChild(popup);
    popup.addEventListener('click', e => e.stopPropagation());

    document.getElementById('tl-popup-open').addEventListener('click', () => {
        popup.style.display = 'none';
    });

    tlRight.addEventListener('click', e => {
        const evEl = e.target.closest('.tl-event');
        if (!evEl) { popup.style.display = 'none'; return; }
        e.stopPropagation();

        const entry = plan[evEl.dataset.id];
        if (!entry) return;

        popup.querySelector('.tl-popup-title').textContent = entry.title || '(no title)';
        popup.querySelector('.tl-popup-meta').textContent =
            [entry.start && entry.end ? `${entry.start}–${entry.end}` : null, entry.venue || null]
                .filter(Boolean).join(' · ');

        const openLink = document.getElementById('tl-popup-open');
        openLink.href = entry.url || '#';

        const statusSel = document.getElementById('tl-popup-status');
        statusSel.innerHTML = statusOptions(entry.status);
        const initBg = STATUS_COLOR[entry.status] || STATUS_COLOR['Interested'];
        statusSel.style.background = initBg;
        statusSel.style.color = textColorForBg(initBg);
        statusSel.onchange = () => {
            const bg = STATUS_COLOR[statusSel.value] || STATUS_COLOR['Interested'];
            statusSel.style.background = bg;
            statusSel.style.color = textColorForBg(bg);
            setPlanEntry(entry.id, { status: statusSel.value });
            popup.style.display = 'none';
        };

        const pw = 240;
        popup.style.left = Math.min(e.clientX + 8, window.innerWidth  - pw - 8) + 'px';
        popup.style.top  = Math.min(e.clientY + 8, window.innerHeight - 130)    + 'px';
        popup.style.display = 'block';
    });

    document.addEventListener('click', () => { popup.style.display = 'none'; });

    const savedTlPos = JSON.parse(GM_getValue('annecy_tl_position', 'null'));
    if (savedTlPos) {
        tl.style.left  = savedTlPos.left;
        tl.style.top   = savedTlPos.top;
        tl.style.right = 'auto';
    }

    makeResizable(tl, 'annecy_tl_size');

    timelineDayIndex = parseInt(GM_getValue('annecy_tl_day', '0'), 10) || 0;

    if (GM_getValue('annecy_tl_visible', '0') === '1') {
        setWindowOpen(tl, document.getElementById('annecy-timeline-fab'), true);
        renderTimeline(true);
    }

    makeDraggable(tl, document.getElementById('annecy-tl-header'), saveTlPosition);
}

function renderTimeline(autoFit = false) {
    const tl = document.getElementById('annecy-timeline');
    if (!tl || tl.classList.contains('annecy-hidden')) return;

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
    // No upper clamp here - an event ending after midnight (endMinutes()
    // already added 24h to its end time) should extend the view instead
    // of getting cut off at the day boundary.
    maxMin = maxMin + 30;

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

    // Measure label column width from actual text
    const _ctx = (renderTimeline._canvas ??= document.createElement('canvas')).getContext('2d');
    _ctx.font = '11px system-ui, sans-serif';
    const labelColW = venues.length
        ? Math.max(80, ...venues.map(v => Math.ceil(_ctx.measureText(v).width) + 16))
        : 120;
    document.getElementById('tl-labels-col').style.width = labelColW + 'px';

    // Labels column
    labelsInner.innerHTML = venues.map(v =>
        `<div class="tl-label" title="${escHtml(v)}">${escHtml(v)}</div>`
    ).join('');

    // Time axis row
    let axisHtml = `<div class="tl-axis-row" style="width:${totalW}px">`;
    for (let h = startHour; h <= endHour; h++) {
        const left = Math.round((h * 60 - minMin) / 60 * pxPerHour);
        // h can run past 24 once the view extends past midnight - wrap the
        // label back to 00:00-23:00 so it still reads as a normal hour.
        axisHtml += `<div class="tl-hour-mark" style="left:${left}px">${String(h % 24).padStart(2,'0')}:00</div>`;
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
            const fg = textColorForBg(color);
            html += `<div class="tl-event" data-id="${escHtml(e.id)}"
                style="left:${left}px;width:${width}px;background:${color};color:${fg}"
                title="${escHtml(e.title)} · ${escHtml(e.start)}–${escHtml(e.end)} · ${escHtml(e.status)}">
                <span class="tl-event-label">${escHtml(e.title)}</span>
            </div>`;
        }
        html += '</div>';
        return html;
    }).join('');

    grid.innerHTML = axisHtml + tracksHtml;

    if (autoFit && venues.length > 0) {
        const headerH = document.getElementById('annecy-tl-header')?.offsetHeight ?? 44;
        const targetW = labelColW + totalW + 18;
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
            const selFg = textColorForBg(color);
            html += `
                <div class="ap-entry" data-id="${escHtml(e.id)}" style="border-left-color:${color}">
                    <div class="ap-title">${e.url ? `<a href="${escHtml(e.url)}" target="_blank">${escHtml(e.title || '(no title)')}</a>` : escHtml(e.title || '(no title)')}</div>
                    <div class="ap-meta">
                        ${escHtml(e.start || '?')}–${escHtml(e.end || '?')}
                        ${e.venue ? ' · ' + escHtml(e.venue) : ''}
                    </div>
                    <div class="ap-actions">
                        <select class="ap-status" data-action="set-status" style="background:${color};color:${selFg}">${statusOptions(e.status)}</select>
                        <button class="ap-btn danger" data-action="remove">✕</button>
                    </div>
                </div>`;
        }
        html += `</div>`;
    }

    body.innerHTML = html;
    body.scrollTop = panelScrollTop; // innerHTML above just reset it to 0

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
            const bg = STATUS_COLOR[sel.value] || STATUS_COLOR['Interested'];
            sel.style.background = bg;
            sel.style.color = textColorForBg(bg);
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

function statusOptions(selected) {
    return STATUS_ENTRIES.map(([s, bg]) => {
        const fg = textColorForBg(bg);
        return `<option value="${escHtml(s)}" ${selected === s ? 'selected' : ''} style="background:${bg};color:${fg}">${escHtml(s)}</option>`;
    }).join('');
}

// ---------------------------------------------------------------------------
// PAGE INTEGRATION
// ---------------------------------------------------------------------------

function applyFilter() {
    const q = (document.getElementById('annecy-filter-search')?.value || '').toLowerCase().trim();
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

function textColorForBg(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#000' : '#fff';
}

async function exportToClipboard() {
    const btn = document.getElementById('annecy-planner-export');

    const toDate = str => new Date(str.replace(/^\w+\s+/, ''));
    const entries = Object.values(plan).sort((a, b) => {
        const d = toDate(a.date || '') - toDate(b.date || '');
        return d !== 0 ? d : (a.start || '').localeCompare(b.start || '');
    });

    if (!entries.length) {
        btn.textContent = '✗';
        setTimeout(() => { btn.textContent = '📋'; }, 2000);
        return;
    }

    const byDate = {};
    for (const e of entries) (byDate[e.date || 'Unknown'] ??= []).push(e);

    const td = (content, style = '') =>
        `<td style="padding:5px 9px;border:1px solid ${UI.exportBorder};vertical-align:middle;${style}">${content}</td>`;

    const headerRow = `<tr style="background:${UI.bg};color:${UI.textOnAccent};font-weight:bold">
        ${['Status', 'Start', 'End', 'Title', 'Venue', 'Type'].map(h =>
            `<th style="padding:6px 9px;border:1px solid ${UI.border};text-align:left;white-space:nowrap">${h}</th>`
        ).join('')}
    </tr>`;

    const bodyRows = [];
    for (const [date, group] of Object.entries(byDate)) {
        bodyRows.push(`<tr style="background:${UI.exportDateBg}">
            <td colspan="6" style="padding:4px 9px;font-weight:bold;color:${UI.exportBorder};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;border:1px solid ${UI.borderSoft}">${date}</td>
        </tr>`);
        for (const e of group) {
            const bg = STATUS_COLOR[e.status] || STATUS_COLOR['Interested'];
            const fg = textColorForBg(bg);
            const titleHtml = e.url
                ? `<a href="${e.url}" style="color:${UI.exportLinkBlue};text-decoration:none">${e.title || '(no title)'}</a>`
                : (e.title || '(no title)');
            bodyRows.push(`<tr>
                ${td(e.status || '—', `background:${bg};color:${fg};font-weight:600;white-space:nowrap`)}
                ${td(e.start  || '—', 'white-space:nowrap')}
                ${td(e.end    || '—', 'white-space:nowrap')}
                ${td(titleHtml)}
                ${td(e.venue  || '—')}
                ${td(e.type   || '—', `color:${UI.exportTypeText};font-size:11px`)}
            </tr>`);
        }
    }

    const html = `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px">
        <thead>${headerRow}</thead>
        <tbody>${bodyRows.join('')}</tbody>
    </table>`;

    const tsv = [
        ['Date', 'Start', 'End', 'Title', 'URL', 'Venue', 'Type', 'Status'].join('\t'),
        ...entries.map(e => [
            e.date || '', e.start || '', e.end || '',
            e.title || '', e.url || '', e.venue || '',
            e.type || '', e.status || '',
        ].join('\t')),
    ].join('\n');

    try {
        await navigator.clipboard.write([new ClipboardItem({
            'text/html':  new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([tsv],  { type: 'text/plain' }),
        })]);
        btn.textContent = `✓ ${entries.length}`;
    } catch {
        btn.textContent = '✗';
    }
    setTimeout(() => { btn.textContent = '📋'; }, 2500);
}

function markConflictsWithBooked() {
    const booked = Object.values(plan).filter(e => e.status === 'Booked');
    let count = 0;
    for (const e of Object.values(plan)) {
        if (e.status === 'Booked') continue;
        if (booked.some(b => overlaps(b, e))) {
            plan[e.id].status = "Can't attend due to conflict";
            count++;
        }
    }
    return count;
}

function importFavourites() {
    const isReservations = location.search.includes('reservations=true');
    const cards = document.querySelectorAll('article.card');
    let added = 0, booked = 0, conflicted = 0;

    cards.forEach(card => {
        if (!isReservations) {
            const heart = card.querySelector('button[title*="Delete"][title*="favourites"]');
            if (!heart) return;
        }
        const screening = scrapeCard(card);
        if (!plan[screening.id]) {
            plan[screening.id] = { ...screening, status: isReservations ? 'Booked' : 'Interested' };
            added++;
        } else if (isReservations && plan[screening.id].status !== 'Booked') {
            plan[screening.id] = { ...plan[screening.id], status: 'Booked' };
            booked++;
        }
    });

    if (isReservations) conflicted = markConflictsWithBooked();

    const total = added + booked + conflicted;
    if (total > 0) {
        savePlan(plan);
        renderPanel();
    }
    const btn = document.getElementById('annecy-planner-import');
    const parts = [];
    if (added)      parts.push(`${added} added`);
    if (booked)     parts.push(`${booked} marked Booked`);
    if (conflicted) parts.push(`${conflicted} marked conflict`);
    btn.textContent = parts.length ? `✓ ${parts.join(', ')}` : '✓ Nothing new';
    setTimeout(() => { btn.textContent = 'Import'; }, 2500);
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
        const timelineFab = document.getElementById('annecy-timeline-fab');
        if (!tl || !timelineFab) return;
        const opening = newVal === '1';
        setWindowOpenInstant(tl, timelineFab, opening);
        if (opening) renderTimeline();
    });

    GM_addValueChangeListener('annecy_tl_day', (_name, _old, newVal, remote) => {
        if (!remote) return;
        timelineDayIndex = parseInt(newVal, 10) || 0;
        renderTimeline(true);
    });

    GM_addValueChangeListener('annecy_scroll', (_name, _old, newVal, remote) => {
        if (!remote) return;
        panelScrollTop = parseInt(newVal, 10) || 0;
        const body = document.getElementById('annecy-planner-body');
        if (body) body.scrollTop = panelScrollTop;
    });

    GM_addValueChangeListener('annecy_size', (_name, _old, newVal, remote) => {
        if (!remote) return;
        try { applyRemoteSize(document.getElementById('annecy-planner'), JSON.parse(newVal)); } catch {}
    });

    GM_addValueChangeListener('annecy_tl_size', (_name, _old, newVal, remote) => {
        if (!remote) return;
        try { applyRemoteSize(document.getElementById('annecy-timeline'), JSON.parse(newVal)); } catch {}
    });

    // Just the stacking order - open/closed state and geometry are synced
    // by their own listeners above/below, so this only ever moves whichever
    // window newVal names above the other one, nothing else.
    GM_addValueChangeListener('annecy_top_win', (_name, _old, newVal, remote) => {
        if (!remote) return;
        const win = document.getElementById(newVal);
        if (win) bringToFrontLocal(win);
    });

    GM_addValueChangeListener('annecy_minimised', (_name, _old, newVal, remote) => {
        if (!remote) return;
        const panel = document.getElementById('annecy-planner');
        const fab = document.getElementById('annecy-planner-fab');
        if (!panel || !fab) return;
        setWindowOpenInstant(panel, fab, newVal !== '1');
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
    const panel = buildPanel();
    buildTimeline();

    if (GM_getValue('annecy_minimised', '0') === '1') {
        setWindowOpen(panel, document.getElementById('annecy-planner-fab'), false);
    }

    const savedSearch = GM_getValue('annecy_search', '');
    if (savedSearch) {
        const input = document.getElementById('annecy-filter-search');
        if (input) input.value = savedSearch;
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
