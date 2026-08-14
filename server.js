/**
 * Kengua Africa — Backend API (single-file version)
 * ----------------------------------------------------------------
 * Plain Node.js + Express + PostgreSQL (raw `pg`, no ORM/build step).
 * Matches kengua-africa.html's register/login modals exactly — see
 * `window.KENGUA_API_BASE_URL` in that file.
 *
 * Run locally:   npm install && npm start
 * Deploy:        Render — see README.md in this download.
 *
 * NOT implemented here (real, separate work — not faked):
 *   exercise answer-grading, AI tutor, speaking practice, payments,
 *   admin CMS, content-review endpoints. See README "What's not built yet".
 * ------------------------------------------------------------------
 */

require('dotenv/config');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Add it to your environment before starting the server.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'kengua_session';
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'true') === 'true';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

function authCookieOptions() {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    // "none" is required for a cross-site cookie (Vercel frontend + separately
    // hosted API) when secure=true. Falls back to "lax" for local http dev.
    sameSite: COOKIE_SECURE ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

function newId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Database setup — creates tables if they don't exist, then seeds languages.
// No separate migration tool: this runs once at boot and is safe to re-run.
// ---------------------------------------------------------------------------

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'LEARNER',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS languages (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      region TEXT,
      flag_emoji TEXT,
      verified BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      language_id TEXT NOT NULL REFERENCES languages(id),
      title TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'Beginner',
      order_num INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL REFERENCES courses(id),
      title TEXT NOT NULL,
      order_num INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      unit_id TEXT NOT NULL REFERENCES units(id),
      title TEXT NOT NULL,
      order_num INT NOT NULL DEFAULT 0,
      xp_reward INT NOT NULL DEFAULT 10,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      lesson_id TEXT NOT NULL REFERENCES lessons(id),
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      options JSONB,
      answer JSONB NOT NULL,
      order_num INT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      course_id TEXT NOT NULL REFERENCES courses(id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, course_id)
    );

    CREATE TABLE IF NOT EXISTS lesson_completions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      lesson_id TEXT NOT NULL REFERENCES lessons(id),
      xp_earned INT NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS user_streaks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      current_streak INT NOT NULL DEFAULT 0,
      longest_streak INT NOT NULL DEFAULT 0,
      total_xp INT NOT NULL DEFAULT 0,
      last_active_date DATE,
      timezone TEXT NOT NULL DEFAULT 'UTC'
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      plan TEXT NOT NULL DEFAULT 'FREE',
      status TEXT NOT NULL DEFAULT 'active',
      current_period_end TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS content_submissions (
      id TEXT PRIMARY KEY,
      language_id TEXT NOT NULL REFERENCES languages(id),
      contributor_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      dialect TEXT,
      region TEXT,
      status TEXT NOT NULL DEFAULT 'SUBMITTED',
      reviewer_id TEXT REFERENCES users(id),
      review_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ
    );
  `);

  await seedLanguagesIfEmpty();
}

// Matches kengua-africa.html's #langGrid exactly.
const LANGUAGE_SEED = [
  { code: 'en', name: 'English', category: 'GLOBAL', flag: '🇬🇧', verified: true },
  { code: 'fr', name: 'French', category: 'GLOBAL', flag: '🇫🇷', verified: true },
  { code: 'es', name: 'Spanish', category: 'GLOBAL', flag: '🇪🇸', verified: true },
  { code: 'de', name: 'German', category: 'GLOBAL', flag: '🇩🇪', verified: true },
  { code: 'ar', name: 'Arabic', category: 'GLOBAL', flag: '🇸🇦', verified: true },
  { code: 'zh', name: 'Chinese', category: 'GLOBAL', flag: '🇨🇳', verified: true },

  { code: 'ha', name: 'Hausa', category: 'NIGERIA', flag: '🇳🇬', verified: true },
  { code: 'yo', name: 'Yoruba', category: 'NIGERIA', flag: '🇳🇬', verified: true },
  { code: 'ig', name: 'Igbo', category: 'NIGERIA', flag: '🇳🇬', verified: true },
  { code: 'fuv', name: 'Fulfulde', category: 'NIGERIA', flag: '🇳🇬', verified: false },
  { code: 'kcg', name: 'Atyap (Kataf)', category: 'NIGERIA', flag: '🇳🇬', region: 'Kaduna', verified: false },
  { code: 'kaj', name: 'Bajju (Kaje)', category: 'NIGERIA', flag: '🇳🇬', region: 'Kaduna', verified: false },
  { code: 'kad', name: 'Adara (Kadara)', category: 'NIGERIA', flag: '🇳🇬', region: 'Kaduna', verified: false },
  { code: 'jab', name: 'Ham (Jaba)', category: 'NIGERIA', flag: '🇳🇬', region: 'Kaduna', verified: false },
  { code: 'gbr', name: 'Gbagyi (Gwari)', category: 'NIGERIA', flag: '🇳🇬', region: 'FCT', verified: false },
  { code: 'kdr', name: 'Kagoro (Agworok)', category: 'NIGERIA', flag: '🇳🇬', region: 'Kaduna', verified: false },
  { code: 'igl', name: 'Igala', category: 'NIGERIA', flag: '🇳🇬', verified: true },
  { code: 'ijc', name: 'Ijaw', category: 'NIGERIA', flag: '🇳🇬', verified: true },
  { code: 'tiv', name: 'Tiv', category: 'NIGERIA', flag: '🇳🇬', verified: true },
  { code: 'kdm', name: 'Kagoma', category: 'NIGERIA', flag: '🇳🇬', verified: false },

  { code: 'sw', name: 'Swahili', category: 'AFRICA', flag: '🇰🇪', verified: true },
  { code: 'am', name: 'Amharic', category: 'AFRICA', flag: '🇪🇹', verified: true },
  { code: 'wo', name: 'Wolof', category: 'AFRICA', flag: '🇸🇳', verified: false },
  { code: 'zu', name: 'Zulu', category: 'AFRICA', flag: '🇿🇦', verified: true },
];

async function seedLanguagesIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM languages');
  if (rows[0].count > 0) return;

  console.log('Seeding language catalog…');
  for (const lang of LANGUAGE_SEED) {
    await pool.query(
      `INSERT INTO languages (id, code, name, category, region, flag_emoji, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (code) DO NOTHING`,
      [newId(), lang.code, lang.name, lang.category, lang.region || null, lang.flag, lang.verified]
    );
  }

  // One worked example course, so the lesson/exercise/XP pipeline has real
  // data to exercise end-to-end (Yoruba · Greetings & Introductions).
  const { rows: yoRows } = await pool.query('SELECT id FROM languages WHERE code = $1', ['yo']);
  const languageId = yoRows[0].id;

  const courseId = newId();
  await pool.query(
    `INSERT INTO courses (id, language_id, title, level, order_num) VALUES ($1, $2, $3, $4, $5)`,
    [courseId, languageId, 'Yorùbá for Beginners', 'Beginner', 1]
  );

  const unitId = newId();
  await pool.query(
    `INSERT INTO units (id, course_id, title, order_num) VALUES ($1, $2, $3, $4)`,
    [unitId, courseId, 'Greetings & Introductions', 1]
  );

  const lessonId = newId();
  await pool.query(
    `INSERT INTO lessons (id, unit_id, title, order_num, xp_reward) VALUES ($1, $2, $3, $4, $5)`,
    [lessonId, unitId, 'Saying hello', 1, 10]
  );

  await pool.query(
    `INSERT INTO exercises (id, lesson_id, type, prompt, options, answer, order_num) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newId(),
      lessonId,
      'MULTIPLE_CHOICE',
      'Translate: "Good morning" → Yorùbá',
      JSON.stringify(['Ẹ kú àárọ̀', 'Ẹ kú alẹ́', 'Ó dàbọ̀']),
      JSON.stringify('Ẹ kú àárọ̀'),
      1,
    ]
  );
  await pool.query(
    `INSERT INTO exercises (id, lesson_id, type, prompt, options, answer, order_num) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newId(),
      lessonId,
      'MULTIPLE_CHOICE',
      'What does "Ẹ kú alẹ́" mean?',
      JSON.stringify(['Good morning', 'Good evening', 'Goodbye']),
      JSON.stringify('Good evening'),
      2,
    ]
  );

  console.log('Seed complete.');
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function signAuthToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function attachUser(req, _res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      // invalid/expired token — treat as unauthenticated
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'You must be logged in to do that.' });
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again in a few minutes.' },
});

const router = express.Router();

// --- Health -----------------------------------------------------------------
router.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- Auth ---------------------------------------------------------------
// POST /api/v1/auth/register  { name, email, password }
router.post(
  '/auth/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const name = (req.body?.name || '').trim();
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    if (name.length < 2) return res.status(400).json({ message: 'Please enter your full name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists. Please log in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = newId();

    await pool.query(
      'INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, name, email, passwordHash]
    );
    await pool.query('INSERT INTO user_streaks (id, user_id) VALUES ($1, $2)', [newId(), userId]);
    await pool.query('INSERT INTO subscriptions (id, user_id) VALUES ($1, $2)', [newId(), userId]);

    const token = signAuthToken({ userId, role: 'LEARNER' });
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());

    res.status(201).json({
      message: 'Account created successfully!',
      user: { id: userId, name, email, role: 'LEARNER' },
      redirectTo: '/onboarding',
    });
  })
);

// POST /api/v1/auth/login  { email, password }
router.post(
  '/auth/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Please enter a valid email address.' });
    if (!password) return res.status(400).json({ message: 'Please enter your password.' });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ message: 'Incorrect email or password.' });

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) return res.status(401).json({ message: 'Incorrect email or password.' });

    const token = signAuthToken({ userId: user.id, role: user.role });
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());

    res.status(200).json({
      message: 'Logged in successfully.',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      redirectTo: '/dashboard',
    });
  })
);

router.post('/auth/logout', (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { ...authCookieOptions(), maxAge: undefined });
  res.status(200).json({ message: 'Logged out.' });
});

router.get(
  '/auth/me',
  attachUser,
  asyncHandler(async (req, res) => {
    if (!req.user) return res.status(401).json({ message: 'Not logged in.' });
    const { rows } = await pool.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!rows[0]) return res.status(401).json({ message: 'Not logged in.' });
    res.json({ user: rows[0] });
  })
);

// --- Languages ---------------------------------------------------------
router.get(
  '/languages',
  asyncHandler(async (req, res) => {
    const category = req.query.category ? String(req.query.category).toUpperCase() : null;
    const { rows } = category
      ? await pool.query('SELECT * FROM languages WHERE category = $1 ORDER BY category, name', [category])
      : await pool.query('SELECT * FROM languages ORDER BY category, name');
    res.json({ languages: rows });
  })
);

router.get(
  '/languages/:code',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM languages WHERE code = $1', [req.params.code]);
    const language = rows[0];
    if (!language) return res.status(404).json({ message: 'Language not found.' });

    const courses = await pool.query('SELECT * FROM courses WHERE language_id = $1 ORDER BY order_num', [
      language.id,
    ]);
    res.json({ language: { ...language, courses: courses.rows } });
  })
);

// --- Courses & lessons ---------------------------------------------------------
router.get(
  '/courses/:courseId',
  asyncHandler(async (req, res) => {
    const courseRes = await pool.query(
      `SELECT c.*, row_to_json(l.*) AS language
       FROM courses c JOIN languages l ON l.id = c.language_id
       WHERE c.id = $1`,
      [req.params.courseId]
    );
    const course = courseRes.rows[0];
    if (!course) return res.status(404).json({ message: 'Course not found.' });

    const unitsRes = await pool.query('SELECT * FROM units WHERE course_id = $1 ORDER BY order_num', [course.id]);
    const units = [];
    for (const unit of unitsRes.rows) {
      const lessonsRes = await pool.query(
        'SELECT id, title, order_num, xp_reward FROM lessons WHERE unit_id = $1 ORDER BY order_num',
        [unit.id]
      );
      units.push({ ...unit, lessons: lessonsRes.rows });
    }

    res.json({ course: { ...course, units } });
  })
);

router.get(
  '/lessons/:lessonId',
  asyncHandler(async (req, res) => {
    const lessonRes = await pool.query('SELECT * FROM lessons WHERE id = $1', [req.params.lessonId]);
    const lesson = lessonRes.rows[0];
    if (!lesson) return res.status(404).json({ message: 'Lesson not found.' });

    // Answers are deliberately excluded — never shipped to the client.
    const exercisesRes = await pool.query(
      'SELECT id, lesson_id, type, prompt, options, order_num FROM exercises WHERE lesson_id = $1 ORDER BY order_num',
      [lesson.id]
    );

    res.json({ lesson: { ...lesson, exercises: exercisesRes.rows } });
  })
);

router.post(
  '/courses/:courseId/enroll',
  attachUser,
  requireAuth,
  asyncHandler(async (req, res) => {
    const courseRes = await pool.query('SELECT id FROM courses WHERE id = $1', [req.params.courseId]);
    if (!courseRes.rows[0]) return res.status(404).json({ message: 'Course not found.' });

    const { rows } = await pool.query(
      `INSERT INTO enrollments (id, user_id, course_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, course_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [newId(), req.user.userId, req.params.courseId]
    );

    res.status(200).json({ message: 'Enrolled.', enrollment: rows[0] });
  })
);

// --- Progress (server-authoritative XP & streaks) ---------------------------------------------------------
router.get(
  '/progress/me',
  attachUser,
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    const streakRes = await pool.query('SELECT * FROM user_streaks WHERE user_id = $1', [userId]);
    const enrollRes = await pool.query(
      `SELECT e.*, row_to_json(c.*) AS course
       FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.user_id = $1`,
      [userId]
    );
    const recentRes = await pool.query(
      `SELECT lc.*, l.title AS lesson_title
       FROM lesson_completions lc JOIN lessons l ON l.id = lc.lesson_id
       WHERE lc.user_id = $1
       ORDER BY lc.completed_at DESC
       LIMIT 10`,
      [userId]
    );

    res.json({
      streak: streakRes.rows[0] || { current_streak: 0, longest_streak: 0, total_xp: 0, last_active_date: null },
      enrollments: enrollRes.rows,
      recentCompletions: recentRes.rows,
    });
  })
);

router.post(
  '/progress/complete-lesson',
  attachUser,
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const lessonId = req.body?.lessonId;
    if (!lessonId) return res.status(400).json({ message: 'lessonId is required.' });

    const lessonRes = await pool.query('SELECT * FROM lessons WHERE id = $1', [lessonId]);
    const lesson = lessonRes.rows[0];
    if (!lesson) return res.status(404).json({ message: 'Lesson not found.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'INSERT INTO lesson_completions (id, user_id, lesson_id, xp_earned) VALUES ($1, $2, $3, $4)',
        [newId(), userId, lessonId, lesson.xp_reward]
      );

      const existingRes = await client.query('SELECT * FROM user_streaks WHERE user_id = $1 FOR UPDATE', [userId]);
      let streak = existingRes.rows[0];

      if (!streak) {
        const insertRes = await client.query(
          `INSERT INTO user_streaks (id, user_id, current_streak, longest_streak, total_xp, last_active_date)
           VALUES ($1, $2, 1, 1, $3, CURRENT_DATE)
           RETURNING *`,
          [newId(), userId, lesson.xp_reward]
        );
        streak = insertRes.rows[0];
      } else {
        const { rows: dayDiffRows } = await client.query(
          `SELECT
             (last_active_date IS NOT NULL AND last_active_date = CURRENT_DATE) AS same_day,
             (last_active_date IS NOT NULL AND last_active_date = CURRENT_DATE - INTERVAL '1 day') AS is_yesterday
           FROM user_streaks WHERE user_id = $1`,
          [userId]
        );
        const { same_day, is_yesterday } = dayDiffRows[0];

        let currentStreak = streak.current_streak;
        let longestStreak = streak.longest_streak;

        if (same_day) {
          // already active today — streak unchanged, XP still accrues
        } else if (is_yesterday) {
          currentStreak += 1;
          longestStreak = Math.max(longestStreak, currentStreak);
        } else if (streak.last_active_date) {
          currentStreak = 1;
          longestStreak = Math.max(longestStreak, 1);
        }

        const updateRes = await client.query(
          `UPDATE user_streaks
           SET current_streak = $1, longest_streak = $2, total_xp = total_xp + $3, last_active_date = CURRENT_DATE
           WHERE user_id = $4
           RETURNING *`,
          [currentStreak, longestStreak, lesson.xp_reward, userId]
        );
        streak = updateRes.rows[0];
      }

      await client.query('COMMIT');

      res.status(200).json({
        message: 'Lesson completed.',
        xpEarned: lesson.xp_reward,
        streak: {
          currentStreak: streak.current_streak,
          longestStreak: streak.longest_streak,
          totalXp: streak.total_xp,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

app.use('/api/v1', router);

app.use((_req, res) => res.status(404).json({ message: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed.' });
  }
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on our end. Please try again shortly.' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kengua Africa API listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
