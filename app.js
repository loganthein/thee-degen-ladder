// ================================================================
// app.js — Bet Ladder Core Logic
//
// This file handles everything:
//   - Navigation between tabs
//   - Reading / writing data to Firebase Firestore
//   - Rendering the Ladder, Leaderboard, History, and Admin views
//   - The "Add Bet" modal + form logic
//   - Rotation management + rung advancement
// ================================================================

// ── GLOBAL STATE ─────────────────────────────────────────────
// We keep a local copy of data so we don't re-query Firebase constantly.
let state = {
  friends:          [],    // ordered array of friend names
  currentRung:      1,
  currentPersonIdx: 0,     // index into friends array
  bets:             [],    // ALL bets across all ladders
  activeLadderId:   null,  // Firestore document ID of the active ladder doc
  laddersWon:       0,     // count of past ladders that reached rung 7
};

// Used when editing an existing bet
let editingBetId = null;

// Used when recording outcome for a bet
let recordingOutcomeBetId = null;
let recordingOutcomeResult = "won"; // "won" or "lost"

// Which leg index is currently being linked to an ESPN game
let linkingLegIndex = null;

// Temporary storage for leg data while the bet modal is open
let legDraft = []; // array of { description, gameId, sport, gameName }

// ── ENTRY POINT ───────────────────────────────────────────────
// Wait for the DOM to be fully loaded before doing anything
document.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupBetModal();
  setupESPNModal();
  setupAdminActions();
  setupEndLadderModal();
  setupRecordOutcomeModal();
  setupSyncStatus();
  setupDarkMode();
  registerServiceWorker();

  // Start listening to Firestore
  subscribeToConfig();
  subscribeToBets();
  subscribeToFeed();
});

// ================================================================
// NAVIGATION
// ================================================================

function setupNavigation() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const views   = document.querySelectorAll(".view");

  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.dataset.tab;

      // Update button states
      tabBtns.forEach(b => {
        b.classList.toggle("active", b.dataset.tab === targetTab);
        b.setAttribute("aria-selected", b.dataset.tab === targetTab);
      });

      // Show/hide views
      views.forEach(view => {
        view.classList.toggle("active", view.id === `view-${targetTab}`);
      });

      // Special: re-render leaderboard when that tab is opened
      if (targetTab === "leaderboard") renderLeaderboard();
    });
  });
}

// ================================================================
// FIRESTORE — REAL-TIME LISTENERS
// ================================================================

/**
 * Listens to the /config document in Firestore.
 * This document stores: friends list, currentRung, currentPersonIndex.
 * onSnapshot fires immediately on load, then again on every change.
 */
function subscribeToConfig() {
  db.collection("config").doc("main").onSnapshot(doc => {
    if (!doc.exists) {
      // First time: create a default config
      initializeDefaultConfig();
      return;
    }

    const data = doc.data();
    state.friends          = data.friends          || [];
    state.currentRung      = data.currentRung      || 1;
    state.currentPersonIdx = data.currentPersonIndex !== undefined
      ? data.currentPersonIndex : 0;
    state.activeLadderId   = data.activeLadderId   || null;

    renderLadderRungs();
    renderStatsBar();
    renderAdminFriendList();
    populateBetPersonSelect();
    populateEndLadderFailedBy();
  }, err => {
    console.error("Config listener error:", err);
    showToast("Error connecting to database.", "error");
  });
}

/**
 * Listens to the /bets collection, filtered by the active ladder.
 * Re-renders the bet list whenever bets are added/changed/removed.
 */
function subscribeToBets() {
  db.collection("bets").orderBy("createdAt", "asc").onSnapshot(snapshot => {
    state.bets = [];
    snapshot.forEach(doc => {
      state.bets.push({ id: doc.id, ...doc.data() });
    });
    renderBetList();
    renderStatsBar();
    startScorePolling();
  }, err => {
    console.error("Bets listener error:", err);
  });
}

// ================================================================
// FIRESTORE — WRITE OPERATIONS
// ================================================================

/** Save the friends list + rotation back to Firestore */
async function saveConfig(updates) {
  try {
    await db.collection("config").doc("main").set(updates, { merge: true });
  } catch (err) {
    console.error("saveConfig error:", err);
    showToast("Failed to save. Check your internet connection.", "error");
  }
}

/** Create a new bet document in Firestore */
async function createBet(betData) {
  try {
    await db.collection("bets").add({
      ...betData,
      ladderId:  state.activeLadderId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    showToast("Bet saved!", "success");

    // Write to activity feed
    const desc = betData.legs?.[0]?.description || betData.freeformDesc || "a bet";
    writeEvent("bet_added", {
      personName:  betData.personName,
      description: `${betData.personName} added: ${desc}`,
    });
  } catch (err) {
    console.error("createBet error:", err);
    showToast("Failed to save bet.", "error");
  }
}

/** Update an existing bet */
async function updateBet(betId, updates) {
  try {
    await db.collection("bets").doc(betId).update(updates);
    showToast("Bet updated!", "success");
  } catch (err) {
    console.error("updateBet error:", err);
    showToast("Failed to update bet.", "error");
  }
}

/** Delete a bet */
async function deleteBet(betId) {
  if (!confirm("Delete this bet? This cannot be undone.")) return;
  try {
    await db.collection("bets").doc(betId).delete();
    showToast("Bet deleted.");
  } catch (err) {
    console.error("deleteBet error:", err);
    showToast("Failed to delete bet.", "error");
  }
}

// ================================================================
// LADDER VIEW — RENDERING
// ================================================================

/**
 * Returns the friend name assigned to a given rung number.
 * Uses the current person index and rung to compute each rung's owner.
 */
function getRungPerson(rungNumber) {
  const friends = state.friends;
  if (!friends || friends.length === 0) return "—";
  const N = friends.length;
  const idx = ((state.currentPersonIdx + (rungNumber - state.currentRung)) % N + N) % N;
  return friends[idx];
}

/**
 * Renders the vertical 7-rung ladder track with person names.
 * Replaces the old progress bar + turn card + header badge.
 */
function renderLadderRungs() {
  const track   = document.getElementById("ladderTrack");
  const counter = document.getElementById("ladderRungCounter");
  const badge   = document.getElementById("headerRungBadge");

  if (!track) return;

  const totalRungs = 7;
  const current    = state.currentRung;

  // Update header badge and rung counter
  if (badge)   badge.textContent   = `Rung ${current}`;
  if (counter) counter.textContent = `Rung ${current} / ${totalRungs}`;

  track.innerHTML = "";

  for (let i = 1; i <= totalRungs; i++) {
    const isDone    = i < current;
    const isCurrent = i === current;
    const personName = state.friends.length > 0 ? getRungPerson(i) : "—";

    let stateClass = "";
    if (isDone)    stateClass = "done";
    if (isCurrent) stateClass = "current";

    const dotContent = isDone ? "✓" : i;
    const statusText = isDone    ? `<span class="ladder-rung-status">Won ✅</span>`
                     : isCurrent ? `<span class="ladder-rung-status">Current 🔥</span>`
                     : "";

    const rung = document.createElement("div");
    rung.className = `ladder-rung ${stateClass}`;
    rung.innerHTML = `
      <div class="ladder-rung-dot">${dotContent}</div>
      <div class="ladder-rung-body">
        <div class="ladder-rung-info">
          <span class="ladder-rung-num">Rung ${i}</span>
          <span class="ladder-rung-person">${escHtml(personName)}</span>
        </div>
        ${statusText}
      </div>
    `;
    track.appendChild(rung);
  }
}

/** Render the list of bet cards for the current ladder */
function renderBetList() {
  const list   = document.getElementById("betList");
  const noMsg  = document.getElementById("noBetsMsg");
  const banner = document.getElementById("liveBetBanner");

  // Filter bets to just the active ladder
  const activeBets = state.bets.filter(b =>
    !state.activeLadderId || b.ladderId === state.activeLadderId
  );

  // Update live bet banner
  if (banner) {
    const liveBets = activeBets.filter(b => b.status === "live");
    if (liveBets.length > 0) {
      const names = [...new Set(liveBets.map(b => b.personName).filter(Boolean))];
      const nameStr = names.length > 0 ? names.join(", ") : "Someone";
      banner.style.display = "block";
      banner.innerHTML = `
        <div class="live-bet-banner-card">
          <span class="live-banner-dot"></span>
          <span class="live-banner-text">🔴 Live Now — ${escHtml(nameStr)}</span>
        </div>`;
    } else {
      banner.style.display = "none";
      banner.innerHTML = "";
    }
  }

  if (activeBets.length === 0) {
    noMsg.style.display = "block";
    // Remove any existing cards
    list.querySelectorAll(".bet-card").forEach(el => el.remove());
    return;
  }

  noMsg.style.display = "none";

  // Show newest bets first (reverse chronological)
  const sorted = [...activeBets].reverse();

  // Build a set of current card IDs to remove stale ones
  const currentIds = new Set(sorted.map(b => b.id));
  list.querySelectorAll(".bet-card").forEach(el => {
    if (!currentIds.has(el.dataset.betId)) el.remove();
  });

  // Render / update each bet card
  sorted.forEach(bet => renderBetCard(bet, list));
}

/** Create or update a single bet card in the DOM */
function renderBetCard(bet, container) {
  // Check if a card already exists for this bet (update it instead of duplicating)
  let card = container.querySelector(`[data-bet-id="${bet.id}"]`);

  if (!card) {
    card = document.createElement("div");
    card.className = "bet-card";
    card.dataset.betId = bet.id;
    container.appendChild(card);
  }

  // Status class for the left-border color stripe
  card.className = `bet-card status-${bet.status || "pending"}`;
  card.dataset.betId = bet.id;

  const status = bet.status || "pending";

  // Does this bet have any ESPN-linked legs?
  const hasLinkedGame = (bet.legs || []).some(l => l.gameId);

  // ── Build legs HTML ───────────────────────────────────────────
  let descHtml = "";
  if (bet.type === "freeform") {
    descHtml = `<p class="bet-card-desc">${escHtml(bet.freeformDesc || "—")}</p>`;
  } else if (bet.legs && bet.legs.length > 0) {
    const legsHtml = bet.legs.map((leg, legIdx) => {
      // New polished score widget (empty string if no score cached yet)
      const scoreWidget = leg.gameId ? espnScoreWidget(leg.gameId) : "";

      // Hit indicator — clickable ⏳/✅/❌ per leg that has a linked game
      let hitBtn = "";
      if (leg.gameId) {
        const hitIcon = leg.hitting === true ? "✅" : leg.hitting === false ? "❌" : "⏳";
        hitBtn = `<button class="leg-hit-btn"
                          data-bet-id="${escHtml(bet.id)}"
                          data-leg-idx="${legIdx}"
                          title="Tap to toggle: hitting / not hitting / unknown">
                    ${hitIcon}
                  </button>`;
      }

      return `<li class="leg-item">
        <span class="leg-dot"></span>
        <div class="leg-content">
          <div class="leg-top">
            <span class="leg-text">${escHtml(leg.description || "—")}</span>
            ${hitBtn}
          </div>
          ${scoreWidget ? `<div class="leg-score">${scoreWidget}</div>` : ""}
        </div>
      </li>`;
    }).join("");
    descHtml = `<ul class="legs-list">${legsHtml}</ul>`;
  }

  // ── Odds / payout line ────────────────────────────────────────
  let oddsDisplay = "";
  if (bet.odds) {
    const estPayout    = calculatePayout(bet.stake || 0, bet.odds);
    const actualStr    = bet.actualPayout !== undefined
      ? ` · <strong style="color:var(--color-green)">Paid: $${Number(bet.actualPayout).toFixed(2)}</strong>`
      : "";
    oddsDisplay = `<span class="odds-line">
      Odds: <strong>${bet.odds > 0 ? "+" : ""}${bet.odds}</strong> ·
      Stake: <strong>$${(bet.stake || 0).toFixed(2)}</strong> ·
      Est. Win: <strong>$${estPayout.toFixed(2)}</strong>${actualStr}
    </span>`;
  }

  // ── Action buttons ────────────────────────────────────────────
  // "Set Live" only shows on pending bets
  const setLiveBtn = status === "pending"
    ? `<button class="btn-live" data-action="setlive" title="Mark as in-progress">🔴 Live</button>`
    : "";

  // "Record Outcome" shows on pending and live bets
  const outcomeBtn = (status === "pending" || status === "live")
    ? `<button class="btn-outcome" data-action="outcome" title="Record win/loss">📋 Outcome</button>`
    : "";

  // Per-card score refresh (only if a game is linked)
  const refreshBtn = hasLinkedGame
    ? `<button class="btn btn-sm btn-ghost" data-action="refresh" title="Refresh scores">↻</button>`
    : "";

  card.innerHTML = `
    <div class="bet-card-header">
      <span class="bet-card-person">${escHtml(bet.personName || "Unknown")}</span>
      <div class="bet-card-actions">
        ${setLiveBtn}
        ${outcomeBtn}
        ${refreshBtn}
        <button class="slip-btn" data-action="slip" title="Upload bet slip photo">📷</button>
        <input type="file" class="slip-file-input" accept="image/*" style="display:none" />
        <button class="btn btn-sm btn-ghost" data-action="edit"   title="Edit bet">✏️</button>
        <button class="btn btn-sm btn-ghost" data-action="delete" title="Delete bet">🗑️</button>
      </div>
    </div>
    <div class="bet-card-body">
      ${descHtml}
      <div class="bet-meta">
        <span class="badge badge-${status}">${capitalize(status)}</span>
        <span class="badge badge-type">${capitalize(bet.type || "straight")}</span>
        ${oddsDisplay}
      </div>
      ${bet.notes ? `<p style="margin-top:6px;font-size:0.78rem;color:var(--color-text-muted)">📝 ${escHtml(bet.notes)}</p>` : ""}
      ${bet.slipUrl ? `<div class="slip-preview"><img src="${escHtml(bet.slipUrl)}" class="slip-img" alt="Bet slip" /></div>` : ""}
    </div>
  `;

  // ── Wire up buttons ───────────────────────────────────────────
  card.querySelector("[data-action='edit']")  ?.addEventListener("click", () => openEditBetModal(bet));
  card.querySelector("[data-action='delete']")?.addEventListener("click", () => deleteBet(bet.id));

  card.querySelector("[data-action='setlive']")?.addEventListener("click", async () => {
    await updateBet(bet.id, { status: "live" });
    showToast("Bet marked as Live! 🔴");
  });

  card.querySelector("[data-action='outcome']")?.addEventListener("click", () => {
    openRecordOutcomeModal(bet);
  });

  card.querySelector("[data-action='refresh']")?.addEventListener("click", async () => {
    const linked = (bet.legs || []).filter(l => l.gameId && l.sport);
    for (const leg of linked) await espnGetScore(leg.sport, leg.gameId);
    renderBetList();
    showToast("Scores updated.");
  });

  // Slip upload
  card.querySelector("[data-action='slip']")?.addEventListener("click", () => {
    const input = card.querySelector(".slip-file-input");
    if (input) input.click();
  });
  card.querySelector(".slip-file-input")?.addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    showToast("Uploading slip…");
    await uploadBetSlip(bet.id, file);
  });

  // Slip full-size view
  card.querySelector(".slip-img")?.addEventListener("click", () => {
    window.open(bet.slipUrl, "_blank");
  });

  // Reaction buttons
  card.querySelectorAll(".reaction-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleReaction(bet.id, btn.dataset.emoji));
  });

  // Leg hit-indicator toggles
  card.querySelectorAll(".leg-hit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const legIdx = parseInt(btn.dataset.legIdx);
      const currentHitting = bet.legs[legIdx]?.hitting;
      toggleLegHitting(bet.id, bet.legs, legIdx, currentHitting);
    });
  });
}

// ================================================================
// LADDER — PROGRESSION LOGIC
// ================================================================

/**
 * Checks all bets for the current rung.
 * If all are resolved (won or lost), offers to advance the rung or end the ladder.
 */
async function checkRungCompletion() {
  const activeBets = state.bets.filter(b =>
    !state.activeLadderId || b.ladderId === state.activeLadderId
  );

  if (activeBets.length === 0) return;

  const allResolved = activeBets.every(b => b.status === "won" || b.status === "lost");
  if (!allResolved) return;

  const anyLost = activeBets.some(b => b.status === "lost");

  if (anyLost) {
    if (confirm(`A bet was lost. End the ladder at rung ${state.currentRung}?`)) {
      openEndLadderModal();
    }
  } else {
    // All bets won — advance to next rung!
    if (state.currentRung >= 7) {
      showToast("🎉 You completed all 7 rungs! Amazing!", "success");
      return;
    }
    if (confirm(`All bets won! Advance to rung ${state.currentRung + 1}?`)) {
      await advanceRung();
    }
  }
}

/** Move to the next rung and rotate to the next person */
async function advanceRung() {
  const nextRung = state.currentRung + 1;
  const nextIdx  = (state.currentPersonIdx + 1) % state.friends.length;

  await saveConfig({
    currentRung:         nextRung,
    currentPersonIndex:  nextIdx,
  });

  const nextName = state.friends[nextIdx];
  showToast(`Rung ${nextRung} — ${nextName}'s turn!`, "success");

  if (nextRung > 7) {
    fireConfetti("ladder_complete");
    writeEvent("ladder_won", { description: "🎉 YOU COMPLETED ALL 7 RUNGS! INCREDIBLE!" });
  } else {
    fireConfetti("rung");
    writeEvent("rung_advanced", {
      description: `Rung ${nextRung - 1} complete! Moving to Rung ${nextRung} — ${nextName}'s turn`,
    });
  }
}

// ================================================================
// BET MODAL — OPEN / CLOSE / SAVE
// ================================================================

function setupBetModal() {
  // Open modal from the "+ Add Bet" button
  document.getElementById("btnAddBet").addEventListener("click", () => openAddBetModal());

  // Close buttons
  document.getElementById("betModalClose").addEventListener("click",  closeBetModal);
  document.getElementById("betModalCancel").addEventListener("click", closeBetModal);

  // Close if clicking outside the modal card
  document.getElementById("betModal").addEventListener("click", e => {
    if (e.target === document.getElementById("betModal")) closeBetModal();
  });

  // Save
  document.getElementById("betModalSave").addEventListener("click", saveBet);

  // Bet type toggle
  document.getElementById("betType").addEventListener("change", onBetTypeChange);

  // Add leg button
  document.getElementById("btnAddLeg").addEventListener("click", addLegRow);

  // Refresh scores button (Ladder view)
  document.getElementById("btnRefreshScores").addEventListener("click", () => {
    startScorePolling();
    showToast("Scores refreshed.");
  });
}

function openAddBetModal() {
  editingBetId = null;
  legDraft     = [];
  resetBetForm();
  document.getElementById("betModalTitle").textContent = "Add Bet";
  document.getElementById("statusGroup").style.display = "none";
  // Add a default empty leg for straight bets
  addLegRow();
  openModal("betModal");
}

function openEditBetModal(bet) {
  editingBetId = bet.id;
  legDraft     = bet.legs ? bet.legs.map(l => ({ ...l })) : [];

  resetBetForm();
  document.getElementById("betModalTitle").textContent = "Edit Bet";
  document.getElementById("statusGroup").style.display = "block";

  // Populate fields
  document.getElementById("betType").value    = bet.type    || "straight";
  document.getElementById("betPerson").value  = bet.personName || "";
  document.getElementById("betStake").value   = bet.stake   || "";
  document.getElementById("betOdds").value    = bet.odds    || "";
  document.getElementById("betNotes").value   = bet.notes   || "";
  document.getElementById("betStatus").value  = bet.status  || "pending";

  if (bet.type === "freeform") {
    document.getElementById("betFreeformDesc").value = bet.freeformDesc || "";
  }

  onBetTypeChange();
  renderLegRows();
  openModal("betModal");
}

function closeBetModal() {
  closeModal("betModal");
  editingBetId = null;
  legDraft     = [];
}

/** Clears all form fields */
function resetBetForm() {
  document.getElementById("betType").value         = "straight";
  document.getElementById("betPerson").value       = "";
  document.getElementById("betStake").value        = "";
  document.getElementById("betOdds").value         = "";
  document.getElementById("betNotes").value        = "";
  document.getElementById("betStatus").value       = "pending";
  document.getElementById("betFreeformDesc").value = "";
  document.getElementById("legsList").innerHTML    = "";
  onBetTypeChange();
}

/** Show/hide sections based on bet type */
function onBetTypeChange() {
  const type       = document.getElementById("betType").value;
  const isFreeform = type === "freeform";

  document.getElementById("legsSection").style.display   = isFreeform ? "none" : "block";
  document.getElementById("freeformGroup").style.display = isFreeform ? "block" : "none";
  document.getElementById("oddsGroup").style.display     = "block"; // always show odds
}

/** Add a new leg input row to the bet modal */
function addLegRow() {
  const idx = legDraft.length;
  legDraft.push({ description: "", gameId: null, sport: null, gameName: null });
  renderLegRows();
}

/** Re-render all leg input rows */
function renderLegRows() {
  const container = document.getElementById("legsList");
  container.innerHTML = "";

  legDraft.forEach((leg, idx) => {
    const row = document.createElement("div");
    row.className = "leg-row";
    row.dataset.legIdx = idx;

    const isLinked = !!leg.gameId;

    row.innerHTML = `
      <input type="text" class="text-input leg-desc-input"
             placeholder="e.g. Chiefs -6.5"
             value="${escHtml(leg.description || "")}" />
      <button class="leg-link-btn ${isLinked ? "linked" : ""}"
              title="${isLinked ? "Game linked: " + (leg.gameName || leg.gameId) : "Link a game"}">
        ${isLinked ? "✓ Linked" : "🔗 Game"}
      </button>
      <button class="leg-remove-btn" title="Remove leg">✕</button>
    `;

    // Sync text input to legDraft
    row.querySelector(".leg-desc-input").addEventListener("input", e => {
      legDraft[idx].description = e.target.value;
    });

    // Open ESPN game search for this leg
    row.querySelector(".leg-link-btn").addEventListener("click", () => {
      linkingLegIndex = idx;
      openESPNModal();
    });

    // Remove leg
    row.querySelector(".leg-remove-btn").addEventListener("click", () => {
      legDraft.splice(idx, 1);
      renderLegRows();
    });

    container.appendChild(row);
  });
}

/** Called when the user clicks Save in the bet modal */
async function saveBet() {
  const type       = document.getElementById("betType").value;
  const personName = document.getElementById("betPerson").value.trim();
  const stake      = parseFloat(document.getElementById("betStake").value) || 0;
  const odds       = parseInt(document.getElementById("betOdds").value)    || 0;
  const notes      = document.getElementById("betNotes").value.trim();
  const status     = document.getElementById("betStatus").value || "pending";
  const freeformDesc = document.getElementById("betFreeformDesc").value.trim();

  // Basic validation
  if (!personName) { showToast("Please select a person.", "error"); return; }

  // Sync any typed text from inputs to legDraft before saving
  document.querySelectorAll(".leg-desc-input").forEach((input, i) => {
    if (legDraft[i]) legDraft[i].description = input.value;
  });

  const betData = {
    type,
    personName,
    stake,
    odds,
    notes,
    status,
    payout: calculatePayout(stake, odds),
    legs:   type !== "freeform" ? legDraft.filter(l => l.description || l.gameId) : [],
    freeformDesc: type === "freeform" ? freeformDesc : "",
  };

  if (editingBetId) {
    await updateBet(editingBetId, betData);
    // Check if the update resolves the rung
    await checkRungCompletion();
  } else {
    await createBet(betData);
  }

  closeBetModal();
}

// ================================================================
// ESPN MODAL
// ================================================================

function setupESPNModal() {
  document.getElementById("espnModalClose").addEventListener("click", closeESPNModal);
  document.getElementById("espnModal").addEventListener("click", e => {
    if (e.target === document.getElementById("espnModal")) closeESPNModal();
  });

  // Set today's date as default in the date picker
  const dateInput = document.getElementById("espnDate");
  dateInput.value = new Date().toISOString().split("T")[0];

  document.getElementById("btnSearchGames").addEventListener("click", async () => {
    const sport = document.getElementById("espnSport").value;
    const date  = document.getElementById("espnDate").value;

    if (!date) { showToast("Pick a date first.", "error"); return; }

    const btn = document.getElementById("btnSearchGames");
    btn.textContent = "Searching…";
    btn.disabled = true;

    const games = await espnSearchGames(sport, date);

    btn.textContent = "Search Games";
    btn.disabled = false;

    espnRenderResults(games, (game) => {
      // User selected a game — link it to the current leg
      if (linkingLegIndex !== null && legDraft[linkingLegIndex] !== undefined) {
        legDraft[linkingLegIndex].gameId   = game.id;
        legDraft[linkingLegIndex].sport    = sport;
        legDraft[linkingLegIndex].gameName = game.shortName || game.name;
      }
      closeESPNModal();
      renderLegRows(); // refresh leg buttons to show "✓ Linked"
    });
  });
}

function openESPNModal()  { openModal("espnModal"); }
function closeESPNModal() {
  closeModal("espnModal");
  document.getElementById("espnResults").innerHTML = "";
  linkingLegIndex = null;
}

// ================================================================
// SCORE POLLING
// ================================================================

/** Find all linked games in active bets and start polling their scores */
function startScorePolling() {
  const activeBets = state.bets.filter(b =>
    !state.activeLadderId || b.ladderId === state.activeLadderId
  );

  const linkedGames = [];
  activeBets.forEach(bet => {
    (bet.legs || []).forEach(leg => {
      if (leg.gameId && leg.sport) {
        linkedGames.push({ gameId: leg.gameId, sport: leg.sport });
      }
    });
  });

  espnStartPolling(linkedGames, (gameId, score) => {
    // Re-render just the bet cards that show this game
    renderBetList();
  });
}

// ================================================================
// LEADERBOARD
// ================================================================

function renderLeaderboard() {
  // Calculate stats from all bets
  const stats = {}; // { personName: { wins, losses, net } }

  state.friends.forEach(name => {
    stats[name] = { wins: 0, losses: 0, net: 0 };
  });

  state.bets.forEach(bet => {
    const name = bet.personName;
    if (!name) return;
    if (!stats[name]) stats[name] = { wins: 0, losses: 0, net: 0 };

    if (bet.status === "won") {
      stats[name].wins++;
      // Use actual payout if recorded, otherwise fall back to estimated payout
      const paid = bet.actualPayout !== undefined ? Number(bet.actualPayout) : (bet.payout || 0);
      stats[name].net += paid - (bet.stake || 0);
    } else if (bet.status === "lost") {
      stats[name].losses++;
      stats[name].net -= (bet.stake || 0);
    }
  });

  // ── Team summary ──────────────────────────────────────────
  let totalWins   = 0;
  let totalLosses = 0;
  let totalNet    = 0;

  Object.values(stats).forEach(s => {
    totalWins   += s.wins;
    totalLosses += s.losses;
    totalNet    += s.net;
  });

  const totalBets = totalWins + totalLosses;
  const winPct    = totalBets > 0 ? ((totalWins / totalBets) * 100).toFixed(1) : "0.0";

  document.getElementById("teamStats").innerHTML = `
    <div class="stat-block">
      <div class="stat-value">${totalWins}–${totalLosses}</div>
      <div class="stat-label">Record</div>
    </div>
    <div class="stat-block">
      <div class="stat-value">${winPct}%</div>
      <div class="stat-label">Win Rate</div>
    </div>
    <div class="stat-block">
      <div class="stat-value" style="color:${totalNet >= 0 ? "var(--color-green)" : "var(--color-red)"}">
        ${totalNet >= 0 ? "+" : ""}$${Math.abs(totalNet).toFixed(0)}
      </div>
      <div class="stat-label">Net Profit</div>
    </div>
  `;

  // ── Per-person table ──────────────────────────────────────
  const tbody = document.getElementById("statsTableBody");
  tbody.innerHTML = "";

  // Sort by wins descending
  const sortedNames = Object.keys(stats).sort((a, b) => {
    const wa = stats[a].wins + stats[a].losses > 0
      ? stats[a].wins / (stats[a].wins + stats[a].losses) : 0;
    const wb = stats[b].wins + stats[b].losses > 0
      ? stats[b].wins / (stats[b].wins + stats[b].losses) : 0;
    return wb - wa;
  });

  if (sortedNames.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No data yet.</td></tr>`;
    return;
  }

  const streaks = computeStreaks(state.bets, Object.keys(stats));

  sortedNames.forEach(name => {
    const s  = stats[name];
    const total = s.wins + s.losses;
    const pct = total > 0 ? ((s.wins / total) * 100).toFixed(1) : "—";
    const netClass = s.net >= 0 ? "net-positive" : "net-negative";
    const netStr   = `${s.net >= 0 ? "+" : ""}$${Math.abs(s.net).toFixed(0)}`;

    // Streak badge
    const streak = streaks[name];
    let streakBadge = "";
    if (streak && streak.current >= 2) {
      if (streak.type === "won") {
        streakBadge = `<span class="streak-badge streak-hot">🔥${streak.current}</span>`;
      } else {
        streakBadge = `<span class="streak-badge streak-cold">🧊${streak.current}</span>`;
      }
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escHtml(name)}${streakBadge}</td>
      <td>${s.wins}</td>
      <td>${s.losses}</td>
      <td>${pct}${pct !== "—" ? "%" : ""}</td>
      <td class="${netClass}">${netStr}</td>
    `;
    tbody.appendChild(tr);
  });

  // Render the records/trends section below the table
  renderRecords(stats, streaks);
}

// ================================================================
// HISTORY
// ================================================================

/** Load archived ladders and render them */
function subscribeToHistory() {
  db.collection("ladders").orderBy("endDate", "desc").onSnapshot(snapshot => {
    const list  = document.getElementById("historyList");
    const noMsg = document.getElementById("noHistoryMsg");

    // Count how many ladders were completed (reached rung 7 without failing)
    let laddersWon = 0;
    snapshot.forEach(doc => {
      const d = doc.data();
      if (!d.failedBy && d.rungs >= 7) laddersWon++;
    });
    state.laddersWon = laddersWon;
    renderStatsBar();

    if (snapshot.empty) {
      noMsg.style.display = "block";
      list.querySelectorAll(".history-card").forEach(el => el.remove());
      return;
    }

    noMsg.style.display = "none";
    list.querySelectorAll(".history-card").forEach(el => el.remove());

    snapshot.forEach(doc => {
      const d = doc.data();
      const card = document.createElement("div");
      card.className = "history-card";

      const start = d.startDate?.toDate?.()?.toLocaleDateString() || "?";
      const end   = d.endDate?.toDate?.()?.toLocaleDateString()   || "?";

      card.innerHTML = `
        <div class="history-card-header">
          <span class="history-card-title">Ladder — Rung ${d.rungs || "?"} reached</span>
          <span class="history-card-date">${start} → ${end}</span>
        </div>
        <p class="history-card-meta">
          ${d.failedBy ? `❌ Failed by: <strong>${escHtml(d.failedBy)}</strong>` : "✅ Completed"}
          ${d.notes    ? ` · ${escHtml(d.notes)}`                                 : ""}
        </p>
      `;

      list.appendChild(card);
    });
  });
}

// ================================================================
// ADMIN — FRIENDS + ROTATION
// ================================================================

/** Render the draggable friend list in the Admin tab */
function renderAdminFriendList() {
  const list = document.getElementById("friendList");
  list.innerHTML = "";

  state.friends.forEach((name, idx) => {
    const li = document.createElement("li");
    li.className = "friend-item";
    li.draggable = true;
    li.dataset.idx = idx;

    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="friend-name">${escHtml(name)}</span>
      ${idx === state.currentPersonIdx
        ? `<span class="badge badge-pending" title="Current turn">Current</span>`
        : ""}
      <button class="friend-remove" data-idx="${idx}" title="Remove ${escHtml(name)}">✕</button>
    `;

    // ── DRAG-AND-DROP ──────────────────────────────────────
    li.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", idx);
      li.classList.add("dragging");
    });

    li.addEventListener("dragend", () => li.classList.remove("dragging"));

    li.addEventListener("dragover", e => {
      e.preventDefault();
      li.classList.add("drag-over");
    });

    li.addEventListener("dragleave", () => li.classList.remove("drag-over"));

    li.addEventListener("drop", async e => {
      e.preventDefault();
      li.classList.remove("drag-over");
      const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
      const toIdx   = parseInt(li.dataset.idx);
      if (fromIdx === toIdx) return;

      // Reorder the array
      const newFriends = [...state.friends];
      const [moved]    = newFriends.splice(fromIdx, 1);
      newFriends.splice(toIdx, 0, moved);

      await saveConfig({ friends: newFriends });
    });

    // Remove button
    li.querySelector(".friend-remove").addEventListener("click", async () => {
      if (!confirm(`Remove ${name} from the group?`)) return;
      const newFriends = state.friends.filter((_, i) => i !== idx);
      // Adjust currentPersonIdx if needed
      let newIdx = state.currentPersonIdx;
      if (idx < newIdx)           newIdx--;
      if (newIdx >= newFriends.length) newIdx = 0;
      await saveConfig({ friends: newFriends, currentPersonIndex: newIdx });
    });

    list.appendChild(li);
  });
}

/** Populate the person selector in the bet modal */
function populateBetPersonSelect() {
  const sel = document.getElementById("betPerson");
  const current = sel.value;
  sel.innerHTML = "";

  state.friends.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });

  // Try to restore selection
  if (current) sel.value = current;

  // Default to the current person
  if (!sel.value && state.friends[state.currentPersonIdx]) {
    sel.value = state.friends[state.currentPersonIdx];
  }
}

function populateEndLadderFailedBy() {
  const sel = document.getElementById("endLadderFailedBy");
  sel.innerHTML = "";
  state.friends.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}

/** Add friend button */
function setupAdminActions() {
  document.getElementById("btnAddFriend").addEventListener("click", addFriend);
  document.getElementById("newFriendInput").addEventListener("keydown", e => {
    if (e.key === "Enter") addFriend();
  });

  document.getElementById("btnStartLadder").addEventListener("click", startNewLadder);
  document.getElementById("btnEndLadder").addEventListener("click",   openEndLadderModal);

  // Subscribe to history when admin tab might show history
  subscribeToHistory();
}

async function addFriend() {
  const input = document.getElementById("newFriendInput");
  const name  = input.value.trim();

  if (!name) { showToast("Enter a name first.", "error"); return; }
  if (state.friends.includes(name)) {
    showToast(`${name} is already in the group.`, "error");
    return;
  }

  const newFriends = [...state.friends, name];
  await saveConfig({ friends: newFriends });
  input.value = "";
  showToast(`${name} added!`, "success");
}

/** Archive current ladder and reset state */
async function startNewLadder() {
  if (!confirm("Start a new ladder? This will archive all current bets.")) return;

  try {
    // Archive the current ladder data
    await db.collection("ladders").add({
      startDate: firebase.firestore.FieldValue.serverTimestamp(),
      endDate:   firebase.firestore.FieldValue.serverTimestamp(),
      rungs:     state.currentRung,
      failedBy:  null,
      notes:     "Started new ladder",
    });

    // Reset config
    const newLadderId = db.collection("ladders").doc().id;
    await saveConfig({
      currentRung:        1,
      currentPersonIndex: 0,
      activeLadderId:     newLadderId,
    });

    showToast("New ladder started! 🚀", "success");
    writeEvent("ladder_started", { description: "🚀 New ladder started! Let's get it." });
  } catch (err) {
    console.error("startNewLadder error:", err);
    showToast("Failed to start new ladder.", "error");
  }
}

// ================================================================
// END LADDER MODAL
// ================================================================

function setupEndLadderModal() {
  document.getElementById("endLadderClose").addEventListener("click",   closeEndLadderModal);
  document.getElementById("endLadderCancel").addEventListener("click",  closeEndLadderModal);
  document.getElementById("endLadderConfirm").addEventListener("click", confirmEndLadder);

  document.getElementById("endLadderModal").addEventListener("click", e => {
    if (e.target === document.getElementById("endLadderModal")) closeEndLadderModal();
  });
}

function openEndLadderModal()  { openModal("endLadderModal"); }
function closeEndLadderModal() { closeModal("endLadderModal"); }

async function confirmEndLadder() {
  const failedBy = document.getElementById("endLadderFailedBy").value;
  const notes    = document.getElementById("endLadderNotes").value.trim();

  try {
    // Save archived ladder record
    await db.collection("ladders").add({
      startDate: firebase.firestore.FieldValue.serverTimestamp(),
      endDate:   firebase.firestore.FieldValue.serverTimestamp(),
      rungs:     state.currentRung,
      failedBy:  failedBy || null,
      notes:     notes || null,
    });

    // Reset the active ladder
    const newLadderId = db.collection("ladders").doc().id;
    await saveConfig({
      currentRung:        1,
      currentPersonIndex: 0,
      activeLadderId:     newLadderId,
    });

    closeEndLadderModal();
    showToast(`Ladder ended. Better luck next time!`);
    writeEvent("ladder_ended", {
      description: `🏁 Ladder ended at Rung ${state.currentRung}. Failed by: ${failedBy || "unknown"}`,
    });
  } catch (err) {
    console.error("confirmEndLadder error:", err);
    showToast("Failed to end ladder.", "error");
  }
}

// ================================================================
// FIRST-RUN SETUP
// ================================================================

/** Called the very first time a user opens the app — creates default data */
async function initializeDefaultConfig() {
  const firstLadderId = db.collection("ladders").doc().id;

  await db.collection("config").doc("main").set({
    friends:            [],
    currentRung:        1,
    currentPersonIndex: 0,
    activeLadderId:     firstLadderId,
  });
}

// ================================================================
// UTILITY FUNCTIONS
// ================================================================

/**
 * Calculate the payout for a bet given stake + American odds.
 * @param {number} stake  - amount wagered in dollars
 * @param {number} odds   - American odds (e.g. -110 or +150)
 * @returns {number} payout amount (profit only, not including stake return)
 */
function calculatePayout(stake, odds) {
  if (!stake || !odds) return 0;
  if (odds > 0) {
    // Underdog: bet $100 to win $odds
    return (stake * odds) / 100;
  } else {
    // Favorite: bet $|odds| to win $100
    return (stake / Math.abs(odds)) * 100;
  }
}

/** Open a modal by ID */
function openModal(id) {
  document.getElementById(id).classList.add("open");
}

/** Close a modal by ID */
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

/**
 * Show a brief toast notification at the bottom of the screen.
 * @param {string} message
 * @param {"success"|"error"|""} type
 */
function showToast(message, type = "") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className   = `toast show ${type ? "toast-" + type : ""}`;

  // Auto-hide after 2.5 seconds
  setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

/** Capitalize the first letter of a string */
function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Escape HTML special characters to prevent XSS.
 * Always use this when inserting user-provided text into innerHTML.
 */
function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ================================================================
// SERVICE WORKER REGISTRATION (PWA)
// ================================================================

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js")
      .then(() => console.log("Service worker registered ✓"))
      .catch(err => console.warn("SW registration failed:", err));
  }
}

// ================================================================
// DARK MODE
// ================================================================

function setupDarkMode() {
  // Restore saved preference
  if (localStorage.getItem("betladder_darkmode") === "true") {
    document.body.classList.add("dark-mode");
    document.getElementById("darkModeBtn").textContent = "☀️";
    updateThemeColor(true);
  }

  document.getElementById("darkModeBtn").addEventListener("click", toggleDarkMode);
}

function toggleDarkMode() {
  const isDark = document.body.classList.toggle("dark-mode");
  document.getElementById("darkModeBtn").textContent = isDark ? "☀️" : "🌙";
  localStorage.setItem("betladder_darkmode", isDark);
  updateThemeColor(isDark);
}

function updateThemeColor(isDark) {
  const meta = document.getElementById("themeColorMeta");
  if (meta) meta.content = isDark ? "#0f172a" : "#2563eb";
}

// ================================================================
// CONFETTI CELEBRATIONS
// ================================================================

/**
 * Fire confetti based on the event type.
 * @param {"win"|"rung"|"ladder_complete"} type
 */
function fireConfetti(type) {
  if (typeof confetti === "undefined") return; // CDN not loaded yet

  if (type === "win") {
    // Small burst from the top
    confetti({
      particleCount: 60,
      spread: 70,
      origin: { y: 0.3 },
      colors: ["#16a34a", "#86efac", "#ffffff"],
    });
  } else if (type === "rung") {
    // Two side bursts
    confetti({ particleCount: 80, angle: 60,  spread: 55, origin: { x: 0 } });
    confetti({ particleCount: 80, angle: 120, spread: 55, origin: { x: 1 } });
  } else if (type === "ladder_complete") {
    // Full celebration — multiple bursts
    let count = 0;
    const interval = setInterval(() => {
      confetti({
        particleCount: 50,
        angle: Math.random() * 360,
        spread: 80,
        origin: { x: Math.random(), y: Math.random() * 0.5 },
      });
      if (++count >= 6) clearInterval(interval);
    }, 300);
  }
}

// ================================================================
// ACTIVITY FEED
// ================================================================

/** Listen to the events collection and re-render feed on any change */
function subscribeToFeed() {
  db.collection("events")
    .orderBy("createdAt", "desc")
    .limit(40)
    .onSnapshot(snapshot => {
      renderFeed(snapshot);
    }, err => console.error("Feed listener error:", err));
}

/** Render event items into the feed list */
function renderFeed(snapshot) {
  const list  = document.getElementById("feedList");
  const noMsg = document.getElementById("noFeedMsg");

  if (!list) return;

  if (snapshot.empty) {
    noMsg.style.display = "block";
    list.querySelectorAll(".feed-item").forEach(el => el.remove());
    return;
  }

  noMsg.style.display = "none";
  list.querySelectorAll(".feed-item").forEach(el => el.remove());

  snapshot.forEach(doc => {
    const d = doc.data();
    const item = document.createElement("div");
    item.className = "feed-item";

    const icons = {
      bet_added:     "🎰",
      bet_won:       "✅",
      bet_lost:      "❌",
      bet_live:      "🔴",
      rung_advanced: "🪜",
      ladder_started:"🚀",
      ladder_ended:  "🏁",
      ladder_won:    "🎉",
    };

    const icon = icons[d.type] || "📌";
    const time = d.createdAt ? timeAgo(d.createdAt.toDate()) : "";

    item.innerHTML = `
      <span class="feed-icon">${icon}</span>
      <div class="feed-body">
        <div class="feed-text">${escHtml(d.description || "")}</div>
        <div class="feed-time">${time}</div>
      </div>
    `;

    list.appendChild(item);
  });
}

/**
 * Write a new event to the Firestore events collection.
 * @param {string} type  - event type key
 * @param {Object} data  - extra fields (description, personName, etc.)
 */
async function writeEvent(type, data = {}) {
  try {
    await db.collection("events").add({
      type,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      ...data,
    });
  } catch (err) {
    // Non-critical: don't show an error to the user if feed write fails
    console.warn("writeEvent error:", err);
  }
}

/**
 * Return a human-friendly "time ago" string from a Date object.
 * e.g. "just now", "5 mins ago", "2 hours ago", "yesterday"
 */
function timeAgo(date) {
  if (!date) return "";
  const secs = Math.floor((new Date() - date) / 1000);
  if (secs < 60)  return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 172800) return "yesterday";
  return date.toLocaleDateString();
}

// ================================================================
// EMOJI REACTIONS
// ================================================================

const REACTION_EMOJIS = ["🔥", "😬", "💀", "👑", "💸"];

/**
 * Returns the HTML string for the reaction row on a bet card.
 */
function renderReactionsHtml(bet) {
  const reactions = bet.reactions || {};
  const btns = REACTION_EMOJIS.map(emoji => {
    const count   = reactions[emoji] || 0;
    const reacted = hasReacted(bet.id, emoji);
    return `<button class="reaction-btn ${reacted ? "reacted" : ""}" data-emoji="${emoji}">
      ${emoji}${count > 0 ? ` <span>${count}</span>` : ""}
    </button>`;
  }).join("");

  return `<div class="reaction-row">${btns}</div>`;
}

/** Check if this device has already reacted with a given emoji on a bet */
function hasReacted(betId, emoji) {
  const key   = `rxn_${betId}`;
  const saved = JSON.parse(localStorage.getItem(key) || "[]");
  return saved.includes(emoji);
}

/** Toggle a reaction — increment or decrement in Firestore, track in localStorage */
async function toggleReaction(betId, emoji) {
  const key   = `rxn_${betId}`;
  const saved = JSON.parse(localStorage.getItem(key) || "[]");
  const already = saved.includes(emoji);

  // Optimistic localStorage update
  const updated = already ? saved.filter(e => e !== emoji) : [...saved, emoji];
  localStorage.setItem(key, JSON.stringify(updated));

  // Firestore atomic increment/decrement
  const delta = already ? -1 : 1;
  try {
    await db.collection("bets").doc(betId).update({
      [`reactions.${emoji}`]: firebase.firestore.FieldValue.increment(delta),
    });
  } catch (err) {
    // Roll back localStorage if Firestore fails
    localStorage.setItem(key, JSON.stringify(saved));
    console.error("Reaction error:", err);
  }
}

// ================================================================
// BET SLIP PHOTO UPLOAD
// ================================================================

/**
 * Upload a photo to Firebase Storage and save the URL on the bet.
 * NOTE: Enable Firebase Storage in your console first:
 *   Build → Storage → Get Started → Start in test mode
 */
async function uploadBetSlip(betId, file) {
  try {
    const ref  = window.storage.ref(`slips/${betId}_${Date.now()}`);
    await ref.put(file);
    const url  = await ref.getDownloadURL();
    await updateBet(betId, { slipUrl: url });
    showToast("Slip uploaded! 📷", "success");
  } catch (err) {
    console.error("uploadBetSlip error:", err);
    showToast("Upload failed. Enable Firebase Storage in your console.", "error");
  }
}

// ================================================================
// STREAKS + RECORDS
// ================================================================

/**
 * Compute current streak and longest win streak for each person.
 * Returns { name: { current, type, longestWin } }
 */
function computeStreaks(bets, names) {
  const results = {};

  names.forEach(name => {
    // Get this person's resolved bets sorted oldest → newest
    const resolved = bets
      .filter(b => b.personName === name && (b.status === "won" || b.status === "lost"))
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));

    if (resolved.length === 0) {
      results[name] = { current: 0, type: null, longestWin: 0 };
      return;
    }

    // Current streak: count from most recent going backwards
    const lastStatus = resolved[resolved.length - 1].status;
    let current = 0;
    for (let i = resolved.length - 1; i >= 0; i--) {
      if (resolved[i].status === lastStatus) current++;
      else break;
    }

    // Longest win streak ever
    let longestWin = 0, tempWin = 0;
    resolved.forEach(b => {
      if (b.status === "won") { tempWin++; longestWin = Math.max(longestWin, tempWin); }
      else tempWin = 0;
    });

    results[name] = { current, type: lastStatus, longestWin };
  });

  return results;
}

/**
 * Render the Records & Trends grid on the Leaderboard tab.
 */
function renderRecords(stats, streaks) {
  const container = document.getElementById("recordsList");
  if (!container) return;

  const bets = state.bets.filter(b => b.status === "won" || b.status === "lost");
  if (bets.length === 0) {
    container.innerHTML = `<p class="empty-state" style="padding:12px 0">Records will appear once bets are settled.</p>`;
    return;
  }

  const names = Object.keys(stats);

  // ── Individual records ────────────────────────────────────────

  // Most wins
  const mostWins = names.reduce((best, n) =>
    stats[n].wins > (stats[best]?.wins || 0) ? n : best, names[0]);

  // Win rate leader (min 2 bets)
  const winRateLeader = names
    .filter(n => stats[n].wins + stats[n].losses >= 2)
    .reduce((best, n) => {
      const rate = n => stats[n].wins / (stats[n].wins + stats[n].losses);
      return !best || rate(n) > rate(best) ? n : best;
    }, null);

  // Biggest single payout (actualPayout or estimated payout)
  const biggestWin = state.bets
    .filter(b => b.status === "won")
    .reduce((best, b) => {
      const amt = b.actualPayout !== undefined ? Number(b.actualPayout) : (b.payout || 0);
      return amt > (best?.amt || 0) ? { name: b.personName, amt } : best;
    }, null);

  // Best odds ever hit
  const bestOdds = state.bets
    .filter(b => b.status === "won" && b.odds)
    .reduce((best, b) => {
      const val = b.odds > 0 ? b.odds : 0; // only underdogs
      return val > (best?.val || 0) ? { name: b.personName, val: b.odds } : best;
    }, null);

  // Most bets placed
  const mostBets = names.reduce((best, n) => {
    const count = state.bets.filter(b => b.personName === n).length;
    return count > (best?.count || 0) ? { name: n, count } : best;
  }, null);

  // Hottest current streak
  const hotStreak = names.reduce((best, n) => {
    const s = streaks[n];
    if (!s || s.type !== "won") return best;
    return s.current > (best?.current || 0) ? { name: n, current: s.current } : best;
  }, null);

  // Longest win streak ever
  const longestEver = names.reduce((best, n) => {
    const s = streaks[n];
    return (s?.longestWin || 0) > (best?.count || 0)
      ? { name: n, count: s.longestWin } : best;
  }, null);

  // Biggest loss
  const biggestLoss = state.bets
    .filter(b => b.status === "lost")
    .reduce((best, b) => {
      const amt = b.stake || 0;
      return amt > (best?.amt || 0) ? { name: b.personName, amt } : best;
    }, null);

  // ── Build records grid ────────────────────────────────────────
  const records = [
    mostWins && {
      icon: "👑", label: "Most Wins",
      name: mostWins, value: `${stats[mostWins].wins} wins`,
    },
    winRateLeader && {
      icon: "🎯", label: "Highest Win %",
      name: winRateLeader,
      value: `${((stats[winRateLeader].wins / (stats[winRateLeader].wins + stats[winRateLeader].losses)) * 100).toFixed(0)}%`,
    },
    biggestWin && {
      icon: "💰", label: "Biggest Win",
      name: biggestWin.name, value: `$${biggestWin.amt.toFixed(0)}`,
    },
    bestOdds && {
      icon: "🎲", label: "Best Odds Hit",
      name: bestOdds.name, value: `+${bestOdds.val}`,
    },
    hotStreak?.current >= 2 && {
      icon: "🔥", label: "Hot Streak",
      name: hotStreak.name, value: `${hotStreak.current} in a row`,
    },
    longestEver?.count >= 2 && {
      icon: "⚡", label: "Longest Win Run",
      name: longestEver.name, value: `${longestEver.count} straight`,
    },
    mostBets && {
      icon: "🎰", label: "Most Active",
      name: mostBets.name, value: `${mostBets.count} bets placed`,
    },
    biggestLoss && {
      icon: "💀", label: "Biggest L",
      name: biggestLoss.name, value: `$${biggestLoss.amt.toFixed(0)} lost`,
    },
  ].filter(Boolean);

  container.innerHTML = `<div class="records-grid">${
    records.map(r => `
      <div class="record-item">
        <span class="record-icon">${r.icon}</span>
        <div class="record-name">${escHtml(r.name)}</div>
        <div class="record-value">${r.label}: ${escHtml(r.value)}</div>
      </div>
    `).join("")
  }</div>`;
}

// ================================================================
// SYNC STATUS INDICATOR
// ================================================================

/** Shows ⚡ Live (green) when online, ⚠ Offline (red) when not */
function setupSyncStatus() {
  function update() {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    if (navigator.onLine) {
      el.textContent = "⚡ Live";
      el.className   = "sync-status sync-online";
    } else {
      el.textContent = "⚠ Offline";
      el.className   = "sync-status sync-offline";
    }
  }
  window.addEventListener("online",  update);
  window.addEventListener("offline", update);
  update(); // set immediately on load
}

// ================================================================
// STATS BAR
// ================================================================

/**
 * Calculates and renders the 4 stat chips above the bet list:
 * At Stake | All-Time Won | All-Time Lost | Ladders Won
 */
function renderStatsBar() {
  // At Stake — only current ladder's unsettled bets
  const atStake = state.bets
    .filter(b => b.ladderId === state.activeLadderId &&
                 (b.status === "pending" || b.status === "live"))
    .reduce((sum, b) => sum + (b.stake || 0), 0);

  // All-time winnings — use actual payout if recorded, else estimated
  const allWon = state.bets
    .filter(b => b.status === "won")
    .reduce((sum, b) => {
      const paid = b.actualPayout !== undefined ? Number(b.actualPayout) : (b.payout || 0);
      return sum + paid;
    }, 0);

  // All-time losses — sum of stakes on all lost bets
  const allLost = state.bets
    .filter(b => b.status === "lost")
    .reduce((sum, b) => sum + (b.stake || 0), 0);

  const el = (id, val) => {
    const node = document.getElementById(id);
    if (node) node.textContent = val;
  };

  el("statAtStake",    `$${atStake.toFixed(0)}`);
  el("statAllTimeWon", `$${allWon.toFixed(0)}`);
  el("statAllTimeLost",`$${allLost.toFixed(0)}`);
  el("statLaddersWon", state.laddersWon || 0);
}

// ================================================================
// RECORD OUTCOME MODAL
// ================================================================

function setupRecordOutcomeModal() {
  document.getElementById("outcomeModalClose") .addEventListener("click", closeRecordOutcomeModal);
  document.getElementById("outcomeModalCancel").addEventListener("click", closeRecordOutcomeModal);
  document.getElementById("outcomeModalConfirm").addEventListener("click", confirmRecordOutcome);

  document.getElementById("outcomeModal").addEventListener("click", e => {
    if (e.target === document.getElementById("outcomeModal")) closeRecordOutcomeModal();
  });

  // Won / Lost toggle buttons
  document.querySelectorAll(".outcome-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".outcome-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      recordingOutcomeResult = btn.dataset.outcome;

      // Hide payout field when lost (no payout to record)
      document.getElementById("actualPayoutGroup").style.display =
        recordingOutcomeResult === "won" ? "block" : "none";
    });
  });
}

function openRecordOutcomeModal(bet) {
  recordingOutcomeBetId  = bet.id;
  recordingOutcomeResult = "won";

  // Reset toggle to "Won"
  document.querySelectorAll(".outcome-btn").forEach(b => b.classList.remove("active"));
  document.querySelector(".outcome-btn.outcome-won").classList.add("active");
  document.getElementById("actualPayoutGroup").style.display = "block";
  document.getElementById("actualPayout").value = "";

  // Show estimated payout as a hint
  const est = calculatePayout(bet.stake || 0, bet.odds || 0);
  document.getElementById("outcomeModalInfo").textContent =
    `${escHtml(bet.personName)} · Est. payout: $${est.toFixed(2)}`;

  openModal("outcomeModal");
}

function closeRecordOutcomeModal() {
  closeModal("outcomeModal");
  recordingOutcomeBetId  = null;
  recordingOutcomeResult = "won";
}

async function confirmRecordOutcome() {
  if (!recordingOutcomeBetId) return;

  const actualPayout = parseFloat(document.getElementById("actualPayout").value) || undefined;

  const updates = {
    status: recordingOutcomeResult,
    ...(recordingOutcomeResult === "won" && actualPayout !== undefined
      ? { actualPayout }
      : {}),
  };

  // Get bet details before updating for feed message
  const bet = state.bets.find(b => b.id === recordingOutcomeBetId);

  await updateBet(recordingOutcomeBetId, updates);

  if (recordingOutcomeResult === "won") {
    fireConfetti("win");
    const paid = actualPayout !== undefined ? `$${Number(actualPayout).toFixed(0)}` : "a bet";
    writeEvent("bet_won", {
      personName:  bet?.personName,
      description: `✅ ${bet?.personName || "Someone"} won ${paid}!`,
    });
  } else {
    writeEvent("bet_lost", {
      personName:  bet?.personName,
      description: `❌ ${bet?.personName || "Someone"}'s bet lost ($${(bet?.stake || 0).toFixed(0)})`,
    });
  }

  closeRecordOutcomeModal();
  await checkRungCompletion();
}

// ================================================================
// LEG HIT INDICATOR TOGGLE
// ================================================================

/**
 * Cycles a leg's hitting status: null (unknown) → true (hitting) → false (not hitting) → null
 * Saves the updated legs array back to Firestore.
 */
async function toggleLegHitting(betId, legs, legIdx, currentHitting) {
  // Cycle: unknown → hitting → not hitting → unknown
  let next;
  if (currentHitting === null || currentHitting === undefined) next = true;
  else if (currentHitting === true)  next = false;
  else next = null;

  const newLegs = legs.map((leg, i) =>
    i === legIdx ? { ...leg, hitting: next } : leg
  );

  await updateBet(betId, { legs: newLegs });
}
