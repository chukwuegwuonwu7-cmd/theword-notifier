// Announces new content to everyone subscribed to the "new_videos" topic:
//   1. New VIDEOS / PLAYLISTS — rows you add to the Neon `videos` table (is_published = true).
//      Standalone videos are announced individually; a new playlist (new group_key)
//      is announced once with its title and video count.
//   2. New POSTS    — image files you upload to the Backblaze folder `videoposts/`
//
// Each item is announced exactly once. Run by hand with `node notify-new-videos.js`
// or automatically through the GitHub Actions workflow next to this file.
//
// Needs:  npm i firebase-admin pg
// Env:    DATABASE_URL, FIREBASE_SERVICE_ACCOUNT        (videos)
//         B2_KEY_ID, B2_APP_KEY                          (posts; if missing, posts are skipped)
//         B2_BUCKET_NAME  optional, defaults to THEWORD

const MAX_PER_RUN = 5;              // safety net so a bulk import can't spam everyone
const POSTS_PREFIX = 'videoposts/'; // same folder the app's feed reads
const IMAGE_EXT = /\.(jpg|jpeg|png|webp)$/i;

// ---------------------------------------------------------------- videos
// A video with no group_key is announced by itself ("New Revelation").
// Videos that share a group_key form a playlist: the playlist is announced ONCE,
// the first time it appears ("New playlist: <title> - N videos"). Videos you add
// to a playlist that was already announced are recorded silently.
async function announceVideos(pool, messaging) {
  const { rows: pending } = await pool.query(
    `SELECT id, group_key FROM videos
      WHERE is_published = true AND notified_at IS NULL
      ORDER BY id ASC LIMIT 100`
  );
  if (pending.length === 0) {
    console.log('Videos: nothing new to announce.');
    return;
  }

  // One batch per standalone video, one batch per playlist (in order of first appearance).
  const batches = [];
  const seenGroups = new Set();
  for (const { id, group_key } of pending) {
    if (group_key && group_key.trim()) {
      if (seenGroups.has(group_key)) continue;
      seenGroups.add(group_key);
      batches.push({ group: group_key });
    } else {
      batches.push({ id });
    }
  }

  let sent = 0;
  for (const batch of batches) {
    if (sent >= MAX_PER_RUN) break;
    const didSend = batch.group
      ? await announcePlaylist(pool, messaging, batch.group)
      : await announceSingleVideo(pool, messaging, batch.id);
    if (didSend) sent++;
  }
}

async function announceSingleVideo(pool, messaging, id) {
  // Claim the row first so two overlapping runs can't both send it.
  const { rows } = await pool.query(
    `UPDATE videos SET notified_at = now()
      WHERE id = $1 AND notified_at IS NULL
      RETURNING *`,
    [id]
  );
  if (rows.length === 0) return false;

  const video = rows[0];
  delete video.notified_at;
  if (video.description && video.description.length > 400) {
    video.description = video.description.slice(0, 400); // FCM data limit is 4 KB
  }

  try {
    await messaging.send({
      topic: 'new_videos',
      android: { priority: 'high' },
      data: { type: 'new_video', video_json: JSON.stringify(video) },
    });
    console.log(`Videos: sent notification for ${id}: ${video.title}`);
    return true;
  } catch (err) {
    console.error(`Videos: failed for ${id}:`, err.message);
    await pool.query('UPDATE videos SET notified_at = NULL WHERE id = $1', [id]);
    return false;
  }
}

async function announcePlaylist(pool, messaging, groupKey) {
  // A playlist is "new" only if none of its videos has been announced before.
  const prior = await pool.query(
    `SELECT 1 FROM videos WHERE group_key = $1 AND notified_at IS NOT NULL LIMIT 1`,
    [groupKey]
  );
  const isNew = prior.rows.length === 0;

  // Claim every waiting video of this playlist in one go.
  const claimed = await pool.query(
    `UPDATE videos SET notified_at = now()
      WHERE group_key = $1 AND is_published = true AND notified_at IS NULL
      RETURNING id, group_title, thumbnail_b2_key, sort_order`,
    [groupKey]
  );
  if (claimed.rows.length === 0) return false; // another run got it

  if (!isNew) {
    console.log(`Playlists: ${claimed.rows.length} video(s) added to existing playlist "${groupKey}" (no notification).`);
    return false;
  }

  const total = (
    await pool.query(
      `SELECT count(*)::int AS n FROM videos WHERE group_key = $1 AND is_published = true`,
      [groupKey]
    )
  ).rows[0].n;

  const rows = claimed.rows.slice().sort((a, b) => {
    const sa = a.sort_order == null ? Infinity : a.sort_order;
    const sb = b.sort_order == null ? Infinity : b.sort_order;
    return sa - sb || a.id - b.id;
  });
  const first = rows[0];
  const title = (rows.find((r) => r.group_title && r.group_title.trim()) || {}).group_title || groupKey;

  try {
    await messaging.send({
      topic: 'new_videos',
      android: { priority: 'high' },
      data: {
        type: 'new_playlist',
        group_key: groupKey,
        group_title: title,
        video_count: String(total),
        thumbnail_key: first.thumbnail_b2_key || '',
      },
    });
    console.log(`Playlists: sent notification for "${title}" (${total} videos)`);
    return true;
  } catch (err) {
    console.error(`Playlists: failed for "${groupKey}":`, err.message);
    await pool.query('UPDATE videos SET notified_at = NULL WHERE id = ANY($1::int[])', [
      claimed.rows.map((r) => r.id),
    ]);
    return false;
  }
}

// ----------------------------------------------------------------- posts
/** "videoposts/desert_vision_03.jpg" -> "Desert Vision 03" (same rule as the app's Post.java) */
function deriveCaption(key) {
  let name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  name = name.replace(/[_-]/g, ' ').trim();
  if (!name) return 'From the Archive';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Lists the image files in the posts folder straight from Backblaze. */
async function listB2Posts(env) {
  const basic = Buffer.from(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`).toString('base64');
  const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!authRes.ok) throw new Error(`B2 authorize failed: ${authRes.status}`);
  const auth = await authRes.json();

  let bucketId = auth.allowed && auth.allowed.bucketId;
  if (!bucketId) {
    const lb = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
      method: 'POST',
      headers: { Authorization: auth.authorizationToken },
      body: JSON.stringify({ accountId: auth.accountId, bucketName: env.B2_BUCKET_NAME || 'THEWORD' }),
    });
    if (!lb.ok) throw new Error(`B2 list_buckets failed: ${lb.status}`);
    const buckets = (await lb.json()).buckets || [];
    if (buckets.length === 0) throw new Error('B2 bucket not found');
    bucketId = buckets[0].bucketId;
  }

  const files = [];
  let startFileName = null;
  do {
    const body = { bucketId, prefix: POSTS_PREFIX, maxFileCount: 1000 };
    if (startFileName) body.startFileName = startFileName;
    const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
      method: 'POST',
      headers: { Authorization: auth.authorizationToken },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`B2 list_file_names failed: ${res.status}`);
    const json = await res.json();
    for (const f of json.files) {
      if (f.action && f.action !== 'upload') continue;
      if (!IMAGE_EXT.test(f.fileName)) continue;
      files.push({ fileName: f.fileName, uploadTimestamp: f.uploadTimestamp || 0 });
    }
    startFileName = json.nextFileName || null;
  } while (startFileName);

  return files;
}

async function announcePosts(pool, messaging, listPosts) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS notified_posts (
       file_name   text PRIMARY KEY,
       notified_at timestamptz NOT NULL DEFAULT now())`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS notifier_state (key text PRIMARY KEY, value text)`
  );

  const files = await listPosts();

  // First ever run: remember everything already in the folder WITHOUT
  // notifying, so your existing posts don't all fire at once.
  const seeded = await pool.query(`SELECT 1 FROM notifier_state WHERE key = 'posts_seeded'`);
  if (seeded.rows.length === 0) {
    for (const f of files) {
      await pool.query(
        `INSERT INTO notified_posts (file_name) VALUES ($1) ON CONFLICT DO NOTHING`,
        [f.fileName]
      );
    }
    await pool.query(
      `INSERT INTO notifier_state (key, value) VALUES ('posts_seeded', 'yes') ON CONFLICT DO NOTHING`
    );
    console.log(`Posts: first run — remembered ${files.length} existing posts, no notifications sent.`);
    return;
  }

  const known = new Set(
    (await pool.query(`SELECT file_name FROM notified_posts`)).rows.map((r) => r.file_name)
  );
  const fresh = files
    .filter((f) => !known.has(f.fileName))
    .sort((a, b) => a.uploadTimestamp - b.uploadTimestamp)
    .slice(0, MAX_PER_RUN);

  if (fresh.length === 0) {
    console.log('Posts: nothing new to announce.');
    return;
  }

  for (const f of fresh) {
    const claim = await pool.query(
      `INSERT INTO notified_posts (file_name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING file_name`,
      [f.fileName]
    );
    if (claim.rows.length === 0) continue; // another run got it

    try {
      await messaging.send({
        topic: 'new_videos',
        android: { priority: 'high' },
        data: {
          type: 'new_post',
          post_key: f.fileName,
          post_caption: deriveCaption(f.fileName),
        },
      });
      console.log(`Posts: sent notification for ${f.fileName}`);
    } catch (err) {
      console.error(`Posts: failed for ${f.fileName}:`, err.message);
      await pool.query('DELETE FROM notified_posts WHERE file_name = $1', [f.fileName]);
    }
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const admin = require('firebase-admin');
  const { Pool } = require('pg');

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
  const messaging = admin.messaging();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await announceVideos(pool, messaging);

    if (process.env.B2_KEY_ID && process.env.B2_APP_KEY) {
      try {
        await announcePosts(pool, messaging, () => listB2Posts(process.env));
      } catch (e) {
        // A posts problem must never stop video notifications.
        console.error('Posts step failed:', e.message);
        process.exitCode = 1;
      }
    } else {
      console.log('Posts: skipped (B2_KEY_ID / B2_APP_KEY not set).');
    }
  } finally {
    await pool.end();
  }
}

module.exports = { announcePosts, announceVideos, deriveCaption };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
