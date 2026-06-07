/**
 * One-time migration: copies every document (recursively, including
 * subcollections) from the custom-named "default" Firestore database into
 * the project's reserved "(default)" database.
 *
 * WHY THIS EXISTS:
 *   This project's Firestore data has been living in a database with the
 *   *literal* ID "default" — a named/custom database — rather than the
 *   special reserved "(default)" database that all of Firestore's SDKs
 *   connect to when you don't specify a database ID. That's been causing:
 *     - The Admin SDK on the server (admin.firestore()) to silently read
 *       from/write to an empty "(default)" database (confirmed via
 *       scripts/diagnose-firestore.js — every op returned "5 NOT_FOUND").
 *     - The Firebase JS compat SDK on the live website (firebase.firestore())
 *       to do the exact same thing — and compat CANNOT be pointed at a named
 *       database (verified by inspecting the shipped SDK source: its
 *       firestore-compat factory always calls getImmediate() with no
 *       identifier, hard-wiring it to "(default)").
 *
 *   Rather than rewrite all client-side Firestore calls in index.html from
 *   the v8/compat chained API to the v9 modular API (a risky rewrite of
 *   live, working code), the chosen permanent fix is to move the DATA to
 *   where every SDK already expects to find it — the reserved "(default)"
 *   database — so all existing code (server AND client) just works with NO
 *   further changes once this migration runs and the temporary
 *   getFirestore(app, 'default') overrides are reverted back to bare
 *   admin.firestore() / firebase.firestore().
 *
 * SAFETY:
 *   - This is a COPY, not a move. The source "default" database is left
 *     completely untouched — nothing is deleted. You can re-run this
 *     script safely (it overwrites destination docs with source data again,
 *     which is idempotent for a straight copy).
 *   - Only Firestore documents are copied. Firebase Auth users/custom claims
 *     are a separate system (not per-database) and need no migration.
 *
 * Setup:
 *   Same service account file you've been using for set-enrolled.js / the
 *   diagnostics — Firebase Console → Project Settings → Service Accounts
 *   → Generate new private key.
 *
 * Usage:
 *   node scripts/migrate-firestore-default-db.js <path-to-service-account.json> [--dry-run]
 *
 * Example:
 *   node scripts/migrate-firestore-default-db.js "C:\Users\joshu\Desktop\claude-certification-testing-firebase-adminsdk-fbsvc-2b928948bb.json"
 *
 * Add --dry-run to walk and print everything that WOULD be copied without
 * writing anything — recommended as a first pass to sanity-check the plan.
 */

const admin = require('firebase-admin');
const path  = require('path');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter(a => a !== '--dry-run');

if (positional.length < 1) {
  console.error('\nUsage: node scripts/migrate-firestore-default-db.js <service-account.json> [--dry-run]\n');
  process.exit(1);
}

const serviceAccountPath = path.resolve(positional[0]);

let sa;
try {
  sa = require(serviceAccountPath);
} catch (e) {
  console.error('\nERROR: Could not load service account file:', serviceAccountPath);
  console.error(e.message, '\n');
  process.exit(1);
}

console.log('Project:', sa.project_id);
console.log('Mode:', dryRun ? 'DRY RUN (no writes)' : 'LIVE (will write to "(default)")');
console.log('');

admin.initializeApp({ credential: admin.credential.cert(sa) });
const app = admin.app();

const sourceDb = getFirestore(app, 'default');     // where your real data lives
const destDb   = getFirestore(app, '(default)');   // the reserved DB every SDK defaults to

let docsCopied = 0;
let collectionsVisited = 0;

/**
 * Recursively copies every document in `sourceRef` (a CollectionReference in
 * sourceDb) to the equivalent path in destDb, then recurses into each
 * document's subcollections.
 */
async function copyCollection(sourceColRef, destColRef, depth) {
  collectionsVisited++;
  const indent = '  '.repeat(depth);
  const snap = await sourceColRef.get();
  console.log(`${indent}Collection "${sourceColRef.path}" — ${snap.size} doc(s)`);

  for (const doc of snap.docs) {
    const data = doc.data();
    console.log(`${indent}  → doc "${doc.id}": ${JSON.stringify(data)}`);
    docsCopied++;
    if (!dryRun) {
      await destColRef.doc(doc.id).set(data, { merge: true });
    }

    // Recurse into this document's subcollections, if any.
    const subCols = await doc.ref.listCollections();
    for (const subCol of subCols) {
      await copyCollection(subCol, destColRef.doc(doc.id).collection(subCol.id), depth + 2);
    }
  }
}

(async () => {
  try {
    const rootCollections = await sourceDb.listCollections();
    if (rootCollections.length === 0) {
      console.log('No root collections found in the "default" database — nothing to migrate.');
    }
    for (const col of rootCollections) {
      await copyCollection(col, destDb.collection(col.id), 0);
    }
    console.log('');
    console.log(`Done. Collections visited: ${collectionsVisited}, documents ${dryRun ? 'that would be copied' : 'copied'}: ${docsCopied}`);
    if (dryRun) {
      console.log('\nThis was a DRY RUN — nothing was written. Re-run without --dry-run to perform the copy.');
    } else {
      console.log('\nNext steps:');
      console.log('  1. Open the Firebase console and spot-check the "(default)" database');
      console.log('     now has the same data as the "default" database.');
      console.log('  2. Once satisfied, the temporary getFirestore(app, \'default\') overrides');
      console.log('     in stripe-webhook.js / set-enrolled.js / netlify function can be');
      console.log('     reverted back to bare admin.firestore() — ask Claude to do this.');
      console.log('  3. The live website (index.html) needs NO changes — its compat SDK');
      console.log('     was always targeting "(default)"; it will simply start seeing data.');
      console.log('  4. Keep the old "default" database around for a while as a backup;');
      console.log('     delete it later via Firebase console once you\'re fully confident.');
    }
    process.exit(0);
  } catch (e) {
    console.error('\nMigration failed:', e.message);
    console.error(e);
    process.exit(1);
  }
})();
