import admin from "firebase-admin";
import { getDailyQuestions } from "./question_service.js";

// 1) Read the service account JSON from env (set by GitHub Secret)
const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!svcJson) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");

const creds = JSON.parse(svcJson);

// 2) Init Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(creds),
  projectId: process.env.FIREBASE_PROJECT_ID || creds.project_id,
});
const db = admin.firestore();

// Helper: local date start (TZ is controlled by the workflow env: TZ=Africa/Nairobi)
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function fmtDateId(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildNoResponses() {
  const qs = getDailyQuestions();
  return qs.map((q) => ({
    question: q.question,
    description: q.description,
    yesScore: q.yesScore,
    noScore: q.noScore,
    answer: false,
    selectedScore: 0,
  }));
}

/**
 * Check if a user already has a report in [start, end).
 * Primary path uses a compound query (needs composite index).
 * If the project does NOT have that index, we fall back to a slower scan
 * of up to 500 recent docs for that user and compare dates in-memory.
 */
async function userHasReportForRange(userId, start, end) {
  try {
    const snap = await db
      .collection("daily_self_reports")
      .where("userId", "==", userId)
      .where("date", ">=", start)
      .where("date", "<", end)
      .limit(1)
      .get();

    return !snap.empty;
  } catch (e) {
    // Fallback: no composite index – do a capped scan on user docs
    const scan = await db
      .collection("daily_self_reports")
      .where("userId", "==", userId)
      .limit(500)
      .get();

    for (const doc of scan.docs) {
      const ts = doc.get("date");
      if (!ts) continue;
      const dt = ts.toDate();
      if (dt >= start && dt < end) return true;
    }
    return false;
  }
}

async function autoSubmitDailyReports() {
  // We run shortly after midnight local time; auto-submit for YESTERDAY.
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const todayStartUtc3 = todayStart; // naming only
  const yesterdayDateId = fmtDateId(yesterdayStart);

  console.log(`Auto-submitting for local day: ${yesterdayDateId}`);

  const usersSnap = await db.collection("users").get();
  console.log(`Found ${usersSnap.size} users`);

  let created = 0;
  for (const userDoc of usersSnap.docs) {
    const userId = userDoc.id;
    const username = userDoc.get("username") || "Unknown";

    const already = await userHasReportForRange(userId, yesterdayStart, todayStartUtc3);
    if (already) continue;

    // Create the report (use deterministic id to reduce duplicates going forward)
    const reportId = `${userId}_${yesterdayDateId}`;
    const ref = db.collection("daily_self_reports").doc(reportId);

    // Safe idempotency: if doc exists, skip
    const exists = await ref.get();
    if (exists.exists) continue;

    await ref.set({
      userId,
      username,
      autoSubmitted: true,
      date: yesterdayStart,                 // store the day (00:00) to make "date-only" checks simple
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      responses: buildNoResponses(),
      totalScore: 0,
      // Optional: add a 'day' string to make equality checks simpler in future (single-field index)
      day: yesterdayDateId
    });

    created++;
  }

  console.log(`Auto-submitted ${created} report(s).`);
}

// Run
autoSubmitDailyReports()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
