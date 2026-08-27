// Cloud Functions — real cross-device push notifications for the bet ladder.
//
// NOT DEPLOYED. Deploying this requires the Firebase project to be on the
// Blaze (pay-as-you-go) plan — Cloud Functions isn't available on the free
// Spark plan. Once you're ready:
//   firebase deploy --only functions
//
// These mirror the same messages the client already fires locally
// (see maybeNotify() calls in index.html) but fan them out server-side to
// every device registered in the `pushTokens` collection, so notifications
// arrive even when nobody has the app open.

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

const fmt = n => "$" + (parseFloat(n) || 0).toFixed(2);

async function sendToAllDevices(title, body) {
  const tokensSnap = await db.collection("pushTokens").get();
  const tokens = tokensSnap.docs.map(d => d.id).filter(t => t && !t.startsWith("manual-"));
  if (!tokens.length) return;

  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
  });

  // Clean up tokens FCM reports as dead (uninstalled app, revoked permission, etc.)
  const stale = [];
  res.responses.forEach((r, i) => {
    const code = r.error?.code;
    if (!r.success && (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token")) {
      stale.push(tokens[i]);
    }
  });
  await Promise.all(stale.map(t => db.collection("pushTokens").doc(t).delete()));
}

exports.onBetCreated = onDocumentCreated("bets/{betId}", async event => {
  const bet = event.data.data();
  await sendToAllDevices(
    `🎲 ${bet.person} placed a bet`,
    `${bet.desc || "Bet"}${bet.odds ? ` at ${bet.odds}` : ""} (${fmt(bet.amount)})`
  );
});

exports.onBetUpdated = onDocumentUpdated("bets/{betId}", async event => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === after.status) return; // only fire on an actual status change

  if (after.status === "won") {
    const [betsSnap, rotSnap] = await Promise.all([
      db.collection("bets").orderBy("createdAt", "asc").get(),
      db.collection("rotation").doc("order").get(),
    ]);
    const bets = betsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const rotation = rotSnap.exists ? (rotSnap.data().names || []) : [];
    const goal = Math.max(2, rotation.length || 6);
    const wonCount = bets.filter(b => b.status === "won").length;
    const rungIdx = bets.findIndex(b => b.id === event.params.betId);

    if (wonCount >= goal) {
      const totalPayout = bets
        .filter(b => b.status === "won")
        .reduce((s, b) => s + (parseFloat(b.payout) || 0), 0);
      await sendToAllDevices(
        "🏆 LADDER COMPLETE!",
        `${after.person} sealed it with ${after.desc || "the final bet"}. ${fmt(totalPayout)} in the pot! Cash it out! 💰`
      );
    } else {
      const idx = rotation.findIndex(n => n.toLowerCase() === (after.person || "").toLowerCase());
      const nextPerson = rotation.length ? rotation[(idx + 1 + rotation.length) % rotation.length] : "";
      await sendToAllDevices(
        `✅ ${after.person} won rung ${rungIdx + 1}!`,
        `${after.desc || "Bet"} hit 🔥${nextPerson ? ` ${nextPerson} is up ${fmt(after.payout)} to bet — keep it rolling` : ` Payout: ${fmt(after.payout)}`}`
      );
    }
  } else if (after.status === "lost") {
    await sendToAllDevices(`❌ ${after.person} lost`, `${after.desc || "Bet"} didn't land. Ladder resets from $20.`);
  }
});
