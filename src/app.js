import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { sessionMiddleware, createSession, destroySession, verifyPassword, hashPassword } from './auth.js';
import { adminRouter } from './routes/admin.js';
import { studentRouter } from './routes/student.js';
import { percent } from './attempts.js';
import { progressLabel } from './assignments.js';
import { fmtDate, STATUS_LABELS } from './format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {object} deps
 * @param {import('node:sqlite').DatabaseSync} deps.db
 * @param {{enabled: boolean, generate: Function}} deps.generator
 * @param {string} deps.uploadDir
 */
export function createApp({ db, generator, uploadDir, secureCookies = false }) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use('/static', express.static(path.join(ROOT, 'public')));
  app.use(sessionMiddleware(db));
  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.percent = percent;
    res.locals.progressLabel = progressLabel;
    res.locals.fmtDate = fmtDate;
    res.locals.STATUS_LABELS = STATUS_LABELS;
    res.locals.aiEnabled = generator.enabled;
    res.locals.flash = req.query.msg ? String(req.query.msg) : null;
    res.locals.flashError = req.query.err ? String(req.query.err) : null;
    next();
  });

  const home = (user) => (user.role === 'admin' ? '/admin' : '/student');

  app.get('/', (req, res) => res.redirect(req.user ? home(req.user) : '/login'));

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect(home(req.user));
    res.render('login', { error: null, username: '' });
  });

  app.post('/login', (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!row || !verifyPassword(String(req.body.password ?? ''), row.password_hash)) {
      return res.status(401).render('login', { error: '아이디 또는 비밀번호가 올바르지 않습니다.', username });
    }
    createSession(db, res, row.id, { secure: secureCookies });
    res.redirect(home(row));
  });

  app.post('/logout', (req, res) => {
    destroySession(db, req, res);
    res.redirect('/login');
  });

  app.get('/account', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.render('account', { error: null });
  });

  app.post('/account', (req, res) => {
    if (!req.user) return res.redirect('/login');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const { current = '', next = '', confirm = '' } = req.body;
    let error = null;
    if (!verifyPassword(current, row.password_hash)) error = '현재 비밀번호가 올바르지 않습니다.';
    else if (next.length < 6) error = '새 비밀번호는 6자 이상이어야 합니다.';
    else if (next !== confirm) error = '새 비밀번호 확인이 일치하지 않습니다.';
    if (error) return res.status(400).render('account', { error });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    res.redirect(`${home(req.user)}?msg=${encodeURIComponent('비밀번호를 변경했습니다.')}`);
  });

  app.use('/admin', adminRouter({ db, generator, uploadDir }));
  app.use('/student', studentRouter({ db }));

  app.use((req, res) => res.status(404).render('error', { message: '페이지를 찾을 수 없습니다.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).render('error', { message: status === 500 ? '서버 오류가 발생했습니다.' : err.message });
  });

  return app;
}
