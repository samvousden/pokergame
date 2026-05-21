const fs = require('fs');
const path = require('path');

const cssFile = path.join(__dirname, 'packages/client/src/App.css');

const responsive = `

/* ===============================================================
   RESPONSIVE LAYOUT  —  Breakpoints: 1400 | 1100 | 768 | 480
   =============================================================== */

/* Base: make game-board-layout fill available width */
.game-board-layout {
  width: 100%;
  max-width: 1700px;
  margin: 0 auto;
  padding: 8px;
  box-sizing: border-box;
}

.game-board {
  flex: 1 1 0;
  min-width: 0;
  box-sizing: border-box;
}

/* 1400px: slightly compress item bags */
@media (max-width: 1400px) {
  .item-bag { width: 240px; }
  .item-bag-icon { font-size: 2em; }
  .item-bag-label, .item-bag-badge, .item-bag-hint { font-size: 0.75em; }
  .item-bag-slot--empty, .item-bag-slot--filled,
  .item-bag-cell-content, .item-bag-reveal-cell { min-height: 52px; }
}

/* 1100px: collapse passive bag; narrow active bag */
@media (max-width: 1100px) {
  .game-board-layout { gap: 8px; }
  .game-board-layout > .item-bag:last-child { display: none; }
  .item-bag { width: 200px; padding: 6px 4px; }
  .item-bag-grid {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: repeat(10, auto);
  }
  .item-bag-slot--empty, .item-bag-slot--filled,
  .item-bag-cell-content, .item-bag-reveal-cell { min-height: 46px; }
  .item-bag-icon { font-size: 1.6em; }
  .game-board { padding: 16px; }
  .showdown-screen { padding: 20px; }
  .item-shop { padding: 24px; }
  .items-grid { grid-template-columns: repeat(2, 1fr); }
}

/* 768px: stack layout vertically */
@media (max-width: 768px) {
  .app { padding: 8px; align-items: flex-start; }

  .game-board-layout {
    flex-direction: column;
    gap: 10px;
    padding: 4px;
  }

  .item-bag {
    width: 100%;
    position: static;
    flex-shrink: 1;
  }

  /* Horizontal scrolling strip of item cells */
  .item-bag-grid {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 4px;
    grid-template-columns: unset;
    grid-template-rows: unset;
    grid-auto-flow: unset;
    padding-bottom: 4px;
  }

  .item-bag-slot { flex-shrink: 0; width: 80px; }
  .item-bag-slot--empty, .item-bag-slot--filled,
  .item-bag-cell-content, .item-bag-reveal-cell { min-height: 80px; }

  .game-board { padding: 12px; border-radius: 8px; }
  .pot-display { margin-bottom: 16px; }
  .pot-display h2 { font-size: 1.2em; }
  .players-table { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .player-seat { padding: 10px 8px; }
  .player-seat h4 { font-size: 0.9em; }
  .player-seat p { font-size: 0.78em; }
  .card { padding: 10px 6px; min-width: 52px; font-size: 0.9em; }
  .hole-card { transform: scale(1) !important; font-size: 1em !important; }
  .action-panel { padding: 12px; margin-bottom: 12px; }
  .action-panel button { padding: 8px 14px; font-size: 0.9em; margin-right: 6px; margin-bottom: 6px; }

  .lobby { padding: 20px 16px; max-width: 100%; }
  .lobby h1 { font-size: 1.8em; }
  .join-form { flex-direction: column; gap: 8px; }
  .mode-selection { gap: 16px; }
  .mode-option { padding: 14px; }

  .item-shop { padding: 16px; max-width: 100%; }
  .items-grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .item-slot { padding: 16px; min-height: 220px; }

  .showdown-screen { padding: 16px; max-width: 100%; }
  .showdown-header h1, .winner-announcement { font-size: 1.6em; }
  .players-hands-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }

  .win-content { padding: 28px 20px; max-width: 100%; }
  .win-content h1 { font-size: 1.8em; }
}

/* 480px: phone portrait */
@media (max-width: 480px) {
  .app { padding: 4px; }
  .item-bag-slot { width: 68px; }
  .item-bag-slot--empty, .item-bag-slot--filled,
  .item-bag-cell-content, .item-bag-reveal-cell { min-height: 68px; }
  .item-bag-icon { font-size: 1.4em; }
  .item-bag-label { font-size: 0.68em; }

  .game-board { padding: 8px; border-radius: 6px; }
  .players-table { grid-template-columns: repeat(2, 1fr); gap: 6px; }
  .card { padding: 8px 4px; min-width: 42px; font-size: 0.82em; border-radius: 4px; }
  .cards { gap: 6px; }
  .action-panel button { padding: 6px 10px; font-size: 0.82em; margin-right: 4px; }
  .raise-input { flex-direction: column; }

  .items-grid { grid-template-columns: 1fr; }
  .lobby h1 { font-size: 1.5em; }
  .players-hands-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
  .showdown-header h1, .winner-announcement { font-size: 1.3em; letter-spacing: 0; }
  .win-content h1 { font-size: 1.5em; }

  .replace-sleeve-dialog { padding: 20px 16px; min-width: unset; width: 90vw; }
  .replace-sleeve-options { flex-direction: column; gap: 10px; }
}
`;

// Read current file and strip any previous partial append from the blank line onwards if needed
let current = fs.readFileSync(cssFile, 'utf8');

// Remove any previous partial append of responsive block (idempotent)
const marker = '\n/* ===============================================================\n   RESPONSIVE LAYOUT';
const markerIdx = current.indexOf(marker);
if (markerIdx !== -1) {
  current = current.slice(0, markerIdx);
}

fs.writeFileSync(cssFile, current + responsive, 'utf8');
console.log('Done — responsive CSS appended. File size:', fs.statSync(cssFile).size, 'bytes');
