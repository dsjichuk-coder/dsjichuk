import path from 'node:path';
import express from 'express';
import { requireRole } from '../auth.js';
import { getMaterial, getQuestions } from '../materials.js';
import { listAssignments, listAttempts } from '../assignments.js';
import { submitAttempt, getAttemptDetail } from '../attempts.js';

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

export function studentRouter({ db }) {
  const router = express.Router();
  router.use(requireRole('student'));

  /** 로그인한 학생에게 발송된 과제만 조회한다. */
  const loadAssignment = (req) => {
    const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND student_id = ?')
      .get(Number(req.params.id), req.user.id);
    if (!a) throw notFound('학습자료를 찾을 수 없습니다.');
    return { assignment: a, material: getMaterial(db, a.material_id) };
  };

  router.get('/', (req, res) => {
    const assignments = listAssignments(db, { studentId: req.user.id });
    res.render('student/dashboard', { assignments });
  });

  router.get('/assignments/:id', (req, res) => {
    const { assignment, material } = loadAssignment(req);
    if (!assignment.studied_at) {
      db.prepare("UPDATE assignments SET studied_at = datetime('now') WHERE id = ?").run(assignment.id);
    }
    const attempts = listAttempts(db, assignment.id);
    const questionCount = getQuestions(db, material.id).length;
    res.render('student/study', { assignment, material, attempts, questionCount });
  });

  router.get('/assignments/:id/pdf', (req, res) => {
    const { material } = loadAssignment(req);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(material.original_name)}`);
    res.sendFile(path.resolve(material.pdf_path));
  });

  router.get('/assignments/:id/quiz', (req, res) => {
    const { assignment, material } = loadAssignment(req);
    const questions = material.status === 'ready' ? getQuestions(db, material.id) : [];
    res.render('student/quiz', { assignment, material, questions });
  });

  router.post('/assignments/:id/quiz', (req, res) => {
    const { assignment, material } = loadAssignment(req);
    const questions = getQuestions(db, material.id);
    if (material.status !== 'ready' || questions.length === 0) {
      return res.redirect(`/student/assignments/${assignment.id}/quiz`);
    }
    const responses = {};
    for (const q of questions) responses[q.id] = String(req.body[`q_${q.id}`] ?? '').trim();
    const attemptId = submitAttempt(db, assignment, responses);
    res.redirect(`/student/attempts/${attemptId}`);
  });

  router.get('/attempts/:id', (req, res) => {
    const attempt = getAttemptDetail(db, Number(req.params.id));
    if (!attempt || attempt.student_id !== req.user.id) throw notFound('풀이 기록을 찾을 수 없습니다.');
    const history = listAttempts(db, attempt.assignment_id);
    res.render('student/result', { attempt, history });
  });

  return router;
}
