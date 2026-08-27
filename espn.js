// ================================================================
// espn.js — ESPN Score Integration
//
// Uses ESPN's undocumented-but-public JSON API to:
//   1. Search for games by sport + date
//   2. Fetch live scores for linked games
//
// The ESPN API base URL pattern:
//   https://site.api.espn.com/apis/site/v2/sports/{sport}/scoreboard?dates=YYYYMMDD
//
// Note: This API is not officially documented, but it's been publicly
// available and is used by many fan apps. It may change without warning.
// ================================================================

// Interval reference so we can clear it when needed
let scoreRefreshInterval = null;

// Maps gameId → { homeTeam, awayTeam, homeScore, awayScore, status }
// This cache is used to update bet cards without re-fetching every game
const scoreCache = {};

// ── PUBLIC: search games for a given sport + date ──────────────
/**
 * Fetches the ESPN scoreboard for a sport on a specific date.
 * @param {string} sport - e.g. "football/nfl"
 * @param {string} dateStr - ISO date like "2025-01-15"
 * @returns {Promise<Array>} array of game objects
 */
async function espnSearchGames(sport, dateStr) {
  // ESPN wants dates as YYYYMMDD (no dashes)
  const dateFormatted = dateStr.replace(/-/g, "");

  // Without a high limit, ESPN only returns a handful of "featured" games.
  // College sports also need a groups parameter — without it ESPN silently
  // filters down to just the top matchups for that day.
  const extraParams = {
    "basketball/mens-college-basketball": "&groups=50&limit=300",
    "football/college-football":          "&groups=80&limit=300",
    "basketball/womens-college-basketball": "&groups=50&limit=300",
  };
  const extra = extraParams[sport] || "&limit=300";

  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard?dates=${dateFormatted}${extra}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ESPN API returned ${response.status}`);
    const data = await response.json();

    // Extract the events array (each event = one game)
    const events = data.events || [];

    // Map each event to a simpler object we can display
    return events.map(event => {
      const competition = event.competitions?.[0];
      const competitors  = competition?.competitors || [];

      // Find home and away teams
      const home = competitors.find(c => c.homeAway === "home") || {};
      const away = competitors.find(c => c.homeAway === "away") || {};

      const status = competition?.status?.type?.description || "Unknown";
      const statusState = competition?.status?.type?.state || "pre"; // pre | in | post

      return {
        id:        event.id,
        name:      event.name,       // e.g. "Kansas City Chiefs at Buffalo Bills"
        shortName: event.shortName,  // e.g. "KC @ BUF"
        date:      event.date,       // ISO datetime string
        status,
        statusState,
        homeTeam:  home.team?.abbreviation || "HOME",
        awayTeam:  away.team?.abbreviation || "AWAY",
        homeScore: home.score || "0",
        awayScore: away.score || "0",
        venue:     competition?.venue?.fullName || "",
      };
    });

  } catch (err) {
    console.error("ESPN search error:", err);
    // Return empty array so the UI can show a "no results" message
    return [];
  }
}

// ── PUBLIC: fetch score for a single game ──────────────────────
/**
 * Fetches the current score for a specific game by its ESPN event ID.
 * @param {string} sport - e.g. "football/nfl"
 * @param {string} gameId - ESPN event ID
 * @returns {Promise<Object|null>} score object or null on error
 */
async function espnGetScore(sport, gameId) {
  // Use the event endpoint for a specific game
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/summary?event=${gameId}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ESPN score fetch returned ${response.status}`);
    const data = await response.json();

    const header = data.header || {};
    const competition = header.competitions?.[0];
    const competitors  = competition?.competitors || [];

    // The summary endpoint uses homeAway:"home"/"away", not a boolean homeTeam.
    // Using !c.homeTeam was the bug — undefined is falsy so BOTH teams matched,
    // causing the same team to show twice.
    const home = competitors.find(c => c.homeAway === "home") || competitors[0] || {};
    const away = competitors.find(c => c.homeAway === "away") || competitors[1] || {};

    const statusState = competition?.status?.type?.state || "pre";
    const statusDesc  = competition?.status?.type?.description || "";
    const clock       = competition?.status?.displayClock || "";
    const period      = competition?.status?.period || "";

    const scoreObj = {
      gameId,
      sport,
      homeTeam:  home.team?.abbreviation || "HOME",
      awayTeam:  away.team?.abbreviation || "AWAY",
      homeScore: home.score || "0",
      awayScore: away.score || "0",
      statusState,   // "pre" | "in" | "post"
      statusDesc,    // "In Progress", "Final", "Scheduled", etc.
      clock,         // e.g. "4:32"
      period,        // e.g. 3
    };

    // Update our local cache
    scoreCache[gameId] = scoreObj;
    return scoreObj;

  } catch (err) {
    console.error(`ESPN score error for game ${gameId}:`, err);
    return null;
  }
}

// ── PUBLIC: render the ESPN game search UI ─────────────────────
/**
 * Populates the #espnResults container with game rows.
 * When the user clicks a game, it calls the callback with the game object.
 * @param {Array}    games    - result from espnSearchGames()
 * @param {Function} onSelect - callback(game) when a game is chosen
 */
function espnRenderResults(games, onSelect) {
  const container = document.getElementById("espnResults");
  container.innerHTML = "";

  if (games.length === 0) {
    container.innerHTML = `<p class="empty-state">No games found for that date.</p>`;
    return;
  }

  games.forEach(game => {
    const row = document.createElement("div");
    row.className = "espn-game-row";

    // Determine what to show for status
    let statusBadge = "";
    if (game.statusState === "in") {
      statusBadge = `<span class="badge badge-live">LIVE</span>`;
    } else if (game.statusState === "post") {
      statusBadge = `<span class="badge badge-final">${game.awayScore}–${game.homeScore} Final</span>`;
    } else {
      // Pre-game: show time
      const localTime = new Date(game.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      statusBadge = `<span style="font-size:0.78rem;color:var(--color-text-muted)">${localTime}</span>`;
    }

    row.innerHTML = `
      <div class="espn-game-info">
        <div class="espn-game-teams">${game.awayTeam} @ ${game.homeTeam}</div>
        <div class="espn-game-detail">${game.name}</div>
      </div>
      ${statusBadge}
      <button class="btn btn-sm btn-primary" data-game-id="${game.id}">Link</button>
    `;

    // Wire up the "Link" button
    row.querySelector("button").addEventListener("click", () => onSelect(game));
    container.appendChild(row);
  });
}

// ── PUBLIC: format a score for display on a bet card ──────────
/**
 * Returns a short display string — kept for backwards compatibility.
 * New code should use espnScoreWidget() instead.
 */
function espnFormatScore(gameId) {
  const s = scoreCache[gameId];
  if (!s) return null;
  if (s.statusState === "pre")  return `${s.awayTeam} @ ${s.homeTeam}`;
  if (s.statusState === "in")   return `${s.awayTeam} ${s.awayScore} – ${s.homeTeam} ${s.homeScore}`;
  return `${s.awayTeam} ${s.awayScore} – ${s.homeTeam} ${s.homeScore} (F)`;
}

// ── PUBLIC: render a polished score widget for a bet card leg ──
/**
 * Returns an HTML string for a mini scoreboard widget.
 * Returns empty string if no score is cached yet for this game.
 * @param {string} gameId
 */
function espnScoreWidget(gameId) {
  const s = scoreCache[gameId];
  if (!s) {
    return `<div class="score-widget score-widget-loading">
      <span class="sw-loading-text">Loading score…</span>
    </div>`;
  }

  // ── Upcoming ─────────────────────────────────────────────────
  if (s.statusState === "pre") {
    return `
      <div class="score-widget score-widget-pre">
        <div class="sw-teams">
          <span class="sw-abbr">${s.awayTeam}</span>
          <span class="sw-sep">@</span>
          <span class="sw-abbr">${s.homeTeam}</span>
        </div>
        <div class="sw-divider"></div>
        <div class="sw-info">
          <span class="sw-upcoming-text">Upcoming</span>
        </div>
      </div>`;
  }

  // Determine winner for final highlighting
  const awayNum  = parseInt(s.awayScore) || 0;
  const homeNum  = parseInt(s.homeScore) || 0;
  const awayWins = s.statusState === "post" && awayNum > homeNum;
  const homeWins = s.statusState === "post" && homeNum > awayNum;

  const awayScoreClass = awayWins ? "sw-score sw-winning" : homeWins ? "sw-score sw-losing" : "sw-score";
  const homeScoreClass = homeWins ? "sw-score sw-winning" : awayWins ? "sw-score sw-losing" : "sw-score";

  // ── Live ──────────────────────────────────────────────────────
  if (s.statusState === "in") {
    const periodLabel = s.period ? `Q${s.period}` : "";
    const clockLabel  = s.clock  ? s.clock         : "";
    return `
      <div class="score-widget score-widget-live">
        <div class="sw-teams">
          <span class="sw-team">
            <span class="sw-abbr">${s.awayTeam}</span>
            <span class="${awayScoreClass}">${s.awayScore}</span>
          </span>
          <span class="sw-sep">—</span>
          <span class="sw-team">
            <span class="sw-abbr">${s.homeTeam}</span>
            <span class="${homeScoreClass}">${s.homeScore}</span>
          </span>
        </div>
        <div class="sw-divider"></div>
        <div class="sw-info">
          <span class="sw-live-dot"></span>
          <span>${periodLabel} ${clockLabel}</span>
        </div>
      </div>`;
  }

  // ── Final ─────────────────────────────────────────────────────
  return `
    <div class="score-widget score-widget-final">
      <div class="sw-teams">
        <span class="sw-team">
          <span class="sw-abbr">${s.awayTeam}</span>
          <span class="${awayScoreClass}">${s.awayScore}</span>
        </span>
        <span class="sw-sep">—</span>
        <span class="sw-team">
          <span class="sw-abbr">${s.homeTeam}</span>
          <span class="${homeScoreClass}">${s.homeScore}</span>
        </span>
      </div>
      <div class="sw-divider"></div>
      <div class="sw-info">
        <span class="sw-final-text">Final</span>
      </div>
    </div>`;
}

// ── PUBLIC: start polling scores for all active bets ──────────
/**
 * Fetches scores every 30 seconds for any bet leg that has a linked game.
 * Calls the provided callback with { gameId, scoreObj } whenever scores update.
 * @param {Array}    linkedGames - array of { gameId, sport }
 * @param {Function} onUpdate    - called when scores change
 */
function espnStartPolling(linkedGames, onUpdate) {
  // Clear any previous interval
  espnStopPolling();

  if (!linkedGames || linkedGames.length === 0) return;

  // Also fetch immediately (don't wait 30s on first load)
  fetchAllScores();

  // Then poll every 30 seconds
  scoreRefreshInterval = setInterval(fetchAllScores, 30_000);

  async function fetchAllScores() {
    for (const { gameId, sport } of linkedGames) {
      const score = await espnGetScore(sport, gameId);
      if (score && onUpdate) onUpdate(gameId, score);
    }
  }
}

// ── PUBLIC: stop polling ──────────────────────────────────────
function espnStopPolling() {
  if (scoreRefreshInterval) {
    clearInterval(scoreRefreshInterval);
    scoreRefreshInterval = null;
  }
}
