// ================================================================
// firebase-config.js
//
// HOW TO FILL THIS IN:
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (or open an existing one)
// 3. Click the gear icon ⚙ → Project Settings
// 4. Scroll down to "Your apps" → click the </> (Web) icon
// 5. Register the app (give it a nickname like "bet-ladder")
// 6. Firebase will show you a config object — copy each value below
// 7. Save this file and reload the app
// ================================================================

const firebaseConfig = {
  apiKey: "AIzaSyBs-HJz0s9dMcauLPT7H5OPB1k9Ax3vtA0",
  authDomain: "thee-degen-ladder.firebaseapp.com",
  projectId: "thee-degen-ladder",
  storageBucket: "thee-degen-ladder.firebasestorage.app",
  messagingSenderId: "27262663189",
  appId: "1:27262663189:web:5cfbe84bd81435e5122c1c"
};

// Initialize Firebase — this makes `firebase` available globally
firebase.initializeApp(firebaseConfig);

// Create a reference to Firestore (our database)
window.db = firebase.firestore();

// Create a reference to Firebase Storage (for bet slip photo uploads)
// NOTE: You need to enable Storage in the Firebase Console first:
//   Build → Storage → Get Started → Start in test mode
window.storage = firebase.storage();

// ── FIRESTORE SECURITY RULES (paste these in Firebase Console) ──
// Go to Firestore → Rules and replace the default rules with:
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     // Allow read/write to everyone for now (fine for a private group app)
//     match /{document=**} {
//       allow read, write: if true;
//     }
//   }
// }
//
// For better security later, add authentication.
