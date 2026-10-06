import { transaction } from './db.js';
import { gradeAttempt, formatAnswer, formatResponse } from './grading.js';
import { getQuestions } from './materials.js';

/** 학생 응답을 채점하고 시도 기록을 저장한다. 새 attempt id 를 반환한다. */
export function submitAttempt(db, assignment, responses) {
  const questions = getQuestions(db, assignment.material_id);
  const graded = gradeAttempt(questions, responses);
  return transaction(db, () => {
    const { lastInsertRowid } = db.prepare('INSERT INTO attempts (assignment_id, score, total) VALUES (?, ?, ?)')
      .run(assignment.id, graded.score, graded.total);
    const insert = db.prepare(`INSERT INTO attempt_answers
      (attempt_id, question_id, position, question_snapshot, response, is_correct) VALUES (?, ?, ?, ?, ?, ?)`);
    graded.results.forEach((r, i) => {
      insert.run(lastInsertRowid, r.question.id, i + 1, JSON.stringify(r.question), r.response, r.isCorrect ? 1 : 0);
    });
    return Number(lastInsertRowid);
  });
}

/** 시도 1건의 상세(학생·자료·문항별 결과)를 불러온다. */
export function getAttemptDetail(db, attemptId) {
  const attempt = db.prepare(`
    SELECT at.*, a.student_id, a.material_id, a.id AS assignment_id,
           m.title AS material_title, u.name AS student_name, u.username AS student_username
    FROM attempts at
    JOIN assignments a ON a.id = at.assignment_id
    JOIN materials m ON m.id = a.material_id
    JOIN users u ON u.id = a.student_id
    WHERE at.id = ?`).get(attemptId);
  if (!attempt) return null;
  const answers = db.prepare('SELECT * FROM attempt_answers WHERE attempt_id = ? ORDER BY position').all(attemptId)
    .map((row) => {
      const question = JSON.parse(row.question_snapshot);
      return {
        position: row.position,
        question,
        response: row.response,
        isCorrect: row.is_correct === 1,
        answerText: formatAnswer(question),
        responseText: formatResponse(question, row.response),
      };
    });
  return { ...attempt, answers };
}

export function percent(score, total) {
  return total > 0 ? Math.round((score / total) * 100) : 0;
}
