// Finds videos you've added to Neon that haven't been announced yet and sends
// ONE push notification per video to everyone subscribed to "new_videos".
//
// Run it by hand:      node notify-new-videos.js
// or automatically:    via the GitHub Actions workflow next to this file.
//
// Needs:  npm i firebase-admin pg
// Env:    DATABASE_URL, FIREBASE_SERVICE_ACCOUNT (the service-account JSON, as one string)

const admin = require('firebase-admin');
const { Pool } = require('pg');

const MAX_PER_RUN = 5; // safety net so a bulk import can't spam everyone

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const { rows: pending } = await pool.query(
    `SELECT id FROM videos
      WHERE is_published = true AND notified_at IS NULL
      ORDER BY id ASC LIMIT $1`,
    [MAX_PER_RUN]
  );
  if (pending.length === 0) {
    console.log('Nothing new to announce.');
    return;
  }

  for (const { id } of pending) {
    // Claim the row first so two overlapping runs can't both send it.
    const { rows } = await pool.query(
      `UPDATE videos SET notified_at = now()
        WHERE id = $1 AND notified_at IS NULL
        RETURNING *`,
      [id]
    );
    if (rows.length === 0) continue;

    const video = rows[0];
    delete video.notified_at;
    if (video.description && video.description.length > 400) {
      video.description = video.description.slice(0, 400); // FCM data limit is 4 KB
    }

    try {
      await admin.messaging().send({
        topic: 'new_videos',
        android: { priority: 'high' },
        data: { type: 'new_video', video_json: JSON.stringify(video) },
      });
      console.log(`Sent notification for video ${id}: ${video.title}`);
    } catch (err) {
      console.error(`Failed for video ${id}:`, err.message);
      // Release the claim so the next run retries it.
      await pool.query('UPDATE videos SET notified_at = NULL WHERE id = $1', [id]);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
