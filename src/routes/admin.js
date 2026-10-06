import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { requireRole, hashPassword } from '../auth.js';
import { transaction } from '../db.js';
import {
  getMaterial, getQuestions, insertQuestion, runGeneration,
  questionFromForm, notesFromForm, notesToForm,
} from '../materials.js';
import { listAssignments, listAttempts } from '../assignments.js';
import { getAttemptDetail } from '../attempts.js';
import { formatAnswer } from '../grading.js';

const MAX_PDF_BYTES = 32 * 1024 * 1024;

const back = (res, url, { msg, err } = {}) => {
  const q = msg ? `?msg=${encodeURIComponent(msg)}` : err ? `?err=${encodeURIComponent(err)}` : '';
  res.redirect(`${url}${q}`);
};

function notFound(message = '찾을 수 없습니다.') {
  return Object.assign(new Error(message), { status: 404 });
}

export function adminRouter({ db, generator, uploadDir }) {
  const router = express.Router();
  router.use(requireRole('admin'));

  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pdf`),
    }),
    defParamCharset: 'utf8', // 한글 파일명 보존
    limits: { fileSize: MAX_PDF_BYTES },
    fileFilter: (req, file, cb) => {
      const ok = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
      cb(ok ? null : Object.assign(new Error('PDF 파일만 업로드할 수 있습니다.'), { status: 400 }), ok);
    },
  });

  const loadMaterial = (req) => {
    const material = getMaterial(db, Number(req.params.id));
    if (!material) throw notFound('학습자료를 찾을 수 없습니다.');
    return material;
  };

  const loadStudent = (req) => {
    const student = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
    if (!student) throw notFound('학생을 찾을 수 없습니다.');
    return student;
  };

  // ── 대시보드 ───────────────────────────────────────────────
  router.get('/', (req, res) => {
    const stats = {
      students: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student'").get().n,
      materials: db.prepare('SELECT COUNT(*) AS n FROM materials').get().n,
      assignments: db.prepare('SELECT COUNT(*) AS n FROM assignments').get().n,
      completed: db.prepare('SELECT COUNT(DISTINCT assignment_id) AS n FROM attempts').get().n,
    };
    const recent = db.prepare(`
      SELECT at.*, m.title AS material_title, u.name AS student_name, u.id AS student_id
      FROM attempts at
      JOIN assignments a ON a.id = at.assignment_id
      JOIN materials m ON m.id = a.material_id
      JOIN users u ON u.id = a.student_id
      ORDER BY at.id DESC LIMIT 15`).all();
    res.render('admin/dashboard', { stats, recent });
  });

  // ── 학생 관리 ──────────────────────────────────────────────
  router.get('/students', (req, res) => {
    const students = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM assignments a WHERE a.student_id = u.id) AS assigned,
        (SELECT COUNT(DISTINCT a.id) FROM assignments a JOIN attempts t ON t.assignment_id = a.id
          WHERE a.student_id = u.id) AS completed,
        (SELECT AVG(CAST(t.score AS REAL) / NULLIF(t.total, 0)) FROM attempts t
          JOIN assignments a ON a.id = t.assignment_id WHERE a.student_id = u.id) AS avg_ratio
      FROM users u WHERE u.role = 'student' ORDER BY u.name`).all();
    res.render('admin/students', { students, form: {}, error: null });
  });

  router.post('/students', (req, res) => {
    const form = {
      name: String(req.body.name ?? '').trim(),
      username: String(req.body.username ?? '').trim(),
      password: String(req.body.password ?? ''),
    };
    let error = null;
    if (!form.name || !form.username) error = '이름과 아이디를 입력해 주세요.';
    else if (!/^[A-Za-z0-9_.-]{3,30}$/.test(form.username)) error = '아이디는 영문/숫자/._- 3~30자로 입력해 주세요.';
    else if (form.password.length < 6) error = '비밀번호는 6자 이상이어야 합니다.';
    else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(form.username)) error = '이미 사용 중인 아이디입니다.';
    if (error) {
      const students = db.prepare("SELECT u.*, 0 AS assigned, 0 AS completed, NULL AS avg_ratio FROM users u WHERE role = 'student' ORDER BY name").all();
      return res.status(400).render('admin/students', { students, form, error });
    }
    db.prepare("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, 'student')")
      .run(form.username, hashPassword(form.password), form.name);
    back(res, '/admin/students', { msg: `${form.name} 학생을 등록했습니다.` });
  });

  router.get('/students/:id', (req, res) => {
    const student = loadStudent(req);
    const assignments = listAssignments(db, { studentId: student.id })
      .map((a) => ({ ...a, attempts: listAttempts(db, a.id) }));
    const materials = db.prepare(`
      SELECT m.id, m.title FROM materials m
      WHERE m.status = 'ready' AND m.id NOT IN (SELECT material_id FROM assignments WHERE student_id = ?)
      ORDER BY m.id DESC`).all(student.id);
    res.render('admin/student_detail', { student, assignments, materials });
  });

  router.post('/students/:id/assign', (req, res) => {
    const student = loadStudent(req);
    const materialId = Number(req.body.material_id);
    const material = getMaterial(db, materialId);
    if (!material || material.status !== 'ready') {
      return back(res, `/admin/students/${student.id}`, { err: '발송할 수 있는 학습자료를 선택해 주세요.' });
    }
    db.prepare(`INSERT OR IGNORE INTO assignments (material_id, student_id, message, due_date) VALUES (?, ?, ?, ?)`)
      .run(materialId, student.id, String(req.body.message ?? '').trim(), req.body.due_date || null);
    back(res, `/admin/students/${student.id}`, { msg: `「${material.title}」을(를) 발송했습니다.` });
  });

  router.post('/students/:id/password', (req, res) => {
    const student = loadStudent(req);
    const password = String(req.body.password ?? '');
    if (password.length < 6) return back(res, `/admin/students/${student.id}`, { err: '비밀번호는 6자 이상이어야 합니다.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), student.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(student.id);
    back(res, `/admin/students/${student.id}`, { msg: '비밀번호를 초기화했습니다.' });
  });

  router.post('/students/:id/delete', (req, res) => {
    const student = loadStudent(req);
    db.prepare('DELETE FROM users WHERE id = ?').run(student.id);
    back(res, '/admin/students', { msg: `${student.name} 학생을 삭제했습니다.` });
  });

  // ── 학습자료 ───────────────────────────────────────────────
  router.get('/materials', (req, res) => {
    const materials = db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM questions q WHERE q.material_id = m.id) AS question_count,
        (SELECT COUNT(*) FROM assignments a WHERE a.material_id = m.id) AS assigned,
        (SELECT COUNT(DISTINCT a.id) FROM assignments a JOIN attempts t ON t.assignment_id = a.id
          WHERE a.material_id = m.id) AS completed
      FROM materials m ORDER BY m.id DESC`).all();
    res.render('admin/materials', { materials });
  });

  router.post('/materials', (req, res) => {
    upload.single('pdf')(req, res, (err) => {
      if (err) {
        const message = err.code === 'LIMIT_FILE_SIZE' ? 'PDF는 32MB 이하만 업로드할 수 있습니다.' : err.message;
        return back(res, '/admin/materials', { err: message });
      }
      if (!req.file) return back(res, '/admin/materials', { err: 'PDF 파일을 선택해 주세요.' });
      const originalName = req.file.originalname;
      const title = String(req.body.title ?? '').trim() || originalName;
      const status = generator.enabled ? 'processing' : 'draft';
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO materials (title, description, original_name, pdf_path, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(title, String(req.body.description ?? '').trim(), originalName, req.file.path, status, req.user.id);
      const id = Number(lastInsertRowid);
      if (generator.enabled) {
        const questionCount = Math.min(Math.max(Number(req.body.question_count) || 10, 1), 30);
        runGeneration(db, generator, id, { questionCount, instructions: String(req.body.instructions ?? '').trim() });
      }
      back(res, `/admin/materials/${id}`, {
        msg: generator.enabled ? 'AI가 학습 노트와 문제를 생성하고 있습니다.' : '업로드했습니다. 학습 노트와 문항을 직접 작성해 주세요.',
      });
    });
  });

  router.get('/materials/:id', (req, res) => {
    const material = loadMaterial(req);
    const questions = getQuestions(db, material.id).map((q) => ({ ...q, answerText: formatAnswer(q) }));
    const assignments = listAssignments(db, { materialId: material.id });
    const assignedIds = new Set(assignments.map((a) => a.student_id));
    const students = db.prepare("SELECT id, name, username FROM users WHERE role = 'student' ORDER BY name").all()
      .filter((s) => !assignedIds.has(s.id));
    res.render('admin/material_detail', {
      material, questions, assignments, students, notesForm: notesToForm(material.notes),
    });
  });

  router.get('/materials/:id/status', (req, res) => {
    const material = loadMaterial(req);
    res.json({ status: material.status, error: material.error });
  });

  router.get('/materials/:id/pdf', (req, res) => {
    const material = loadMaterial(req);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(material.original_name)}`);
    res.sendFile(path.resolve(material.pdf_path));
  });

  router.post('/materials/:id/regenerate', (req, res) => {
    const material = loadMaterial(req);
    if (!generator.enabled) return back(res, `/admin/materials/${material.id}`, { err: 'AI 생성이 설정되지 않았습니다(ANTHROPIC_API_KEY).' });
    if (material.status === 'processing') return back(res, `/admin/materials/${material.id}`);
    const questionCount = Math.min(Math.max(Number(req.body.question_count) || 10, 1), 30);
    db.prepare("UPDATE materials SET status = 'processing' WHERE id = ?").run(material.id);
    runGeneration(db, generator, material.id, { questionCount, instructions: String(req.body.instructions ?? '').trim() });
    back(res, `/admin/materials/${material.id}`, { msg: '다시 생성하고 있습니다. 기존 노트와 문항은 교체됩니다.' });
  });

  router.post('/materials/:id/info', (req, res) => {
    const material = loadMaterial(req);
    const title = String(req.body.title ?? '').trim();
    if (!title) return back(res, `/admin/materials/${material.id}`, { err: '제목을 입력해 주세요.' });
    db.prepare('UPDATE materials SET title = ?, description = ? WHERE id = ?')
      .run(title, String(req.body.description ?? '').trim(), material.id);
    back(res, `/admin/materials/${material.id}`, { msg: '자료 정보를 저장했습니다.' });
  });

  const markReadyIfDraft = (id) => {
    const hasQuestions = db.prepare('SELECT 1 FROM questions WHERE material_id = ?').get(id);
    if (hasQuestions) db.prepare("UPDATE materials SET status = 'ready', error = NULL WHERE id = ? AND status IN ('draft', 'failed')").run(id);
  };

  router.post('/materials/:id/notes', (req, res) => {
    const material = loadMaterial(req);
    db.prepare('UPDATE materials SET notes_json = ? WHERE id = ?').run(JSON.stringify(notesFromForm(req.body)), material.id);
    back(res, `/admin/materials/${material.id}`, { msg: '학습 노트를 저장했습니다.' });
  });

  router.post('/materials/:id/questions', (req, res) => {
    const material = loadMaterial(req);
    try {
      insertQuestion(db, material.id, questionFromForm(req.body));
    } catch (e) {
      return back(res, `/admin/materials/${material.id}#questions`, { err: e.message });
    }
    markReadyIfDraft(material.id);
    back(res, `/admin/materials/${material.id}`, { msg: '문항을 추가했습니다.' });
  });

  router.post('/materials/:id/questions/:qid', (req, res) => {
    const material = loadMaterial(req);
    let q;
    try {
      q = questionFromForm(req.body);
    } catch (e) {
      return back(res, `/admin/materials/${material.id}`, { err: e.message });
    }
    db.prepare(`UPDATE questions SET type = ?, prompt = ?, choices = ?, answer = ?, explanation = ?
                WHERE id = ? AND material_id = ?`)
      .run(q.type, q.prompt, JSON.stringify(q.choices), JSON.stringify(q.answer), q.explanation, Number(req.params.qid), material.id);
    back(res, `/admin/materials/${material.id}`, { msg: '문항을 수정했습니다.' });
  });

  router.post('/materials/:id/questions/:qid/delete', (req, res) => {
    const material = loadMaterial(req);
    db.prepare('DELETE FROM questions WHERE id = ? AND material_id = ?').run(Number(req.params.qid), material.id);
    back(res, `/admin/materials/${material.id}`, { msg: '문항을 삭제했습니다.' });
  });

  router.post('/materials/:id/assign', (req, res) => {
    const material = loadMaterial(req);
    if (material.status !== 'ready') {
      return back(res, `/admin/materials/${material.id}`, { err: '문항이 준비된 자료만 발송할 수 있습니다.' });
    }
    const ids = [].concat(req.body.student_ids ?? []).map(Number).filter(Boolean);
    if (ids.length === 0) return back(res, `/admin/materials/${material.id}`, { err: '발송할 학생을 선택해 주세요.' });
    const message = String(req.body.message ?? '').trim();
    const due = req.body.due_date || null;
    const insert = db.prepare(`INSERT OR IGNORE INTO assignments (material_id, student_id, message, due_date)
      SELECT ?, id, ?, ? FROM users WHERE id = ? AND role = 'student'`);
    const sent = transaction(db, () => ids.reduce((n, id) => n + Number(insert.run(material.id, message, due, id).changes), 0));
    back(res, `/admin/materials/${material.id}`, { msg: `${sent}명에게 발송했습니다.` });
  });

  router.post('/materials/:id/delete', (req, res) => {
    const material = loadMaterial(req);
    db.prepare('DELETE FROM materials WHERE id = ?').run(material.id);
    fs.rm(material.pdf_path, { force: true }, () => {});
    back(res, '/admin/materials', { msg: `「${material.title}」을(를) 삭제했습니다.` });
  });

  // ── 발송/풀이 결과 ─────────────────────────────────────────
  router.post('/assignments/:id/delete', (req, res) => {
    const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(Number(req.params.id));
    if (!a) throw notFound();
    db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
    const to = req.body.return_to === 'student' ? `/admin/students/${a.student_id}` : `/admin/materials/${a.material_id}`;
    back(res, to, { msg: '발송을 취소했습니다.' });
  });

  router.get('/attempts/:id', (req, res) => {
    const attempt = getAttemptDetail(db, Number(req.params.id));
    if (!attempt) throw notFound('풀이 기록을 찾을 수 없습니다.');
    const history = listAttempts(db, attempt.assignment_id);
    res.render('admin/attempt_detail', { attempt, history });
  });

  return router;
}
