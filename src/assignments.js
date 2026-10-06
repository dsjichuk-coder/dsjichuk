/** 발송 목록과 각 발송의 풀이 요약(시도 횟수, 최근/최고 점수)을 조회한다. */
export function listAssignments(db, { studentId, materialId } = {}) {
  const where = [];
  const params = [];
  if (studentId) { where.push('a.student_id = ?'); params.push(studentId); }
  if (materialId) { where.push('a.material_id = ?'); params.push(materialId); }
  return db.prepare(`
    SELECT a.*, m.title AS material_title, m.status AS material_status,
           u.name AS student_name, u.username AS student_username,
           (SELECT COUNT(*) FROM attempts t WHERE t.assignment_id = a.id) AS attempt_count,
           (SELECT t.id FROM attempts t WHERE t.assignment_id = a.id ORDER BY t.id DESC LIMIT 1) AS last_attempt_id,
           (SELECT t.score FROM attempts t WHERE t.assignment_id = a.id ORDER BY t.id DESC LIMIT 1) AS last_score,
           (SELECT t.total FROM attempts t WHERE t.assignment_id = a.id ORDER BY t.id DESC LIMIT 1) AS last_total,
           (SELECT t.submitted_at FROM attempts t WHERE t.assignment_id = a.id ORDER BY t.id DESC LIMIT 1) AS last_submitted_at,
           (SELECT MAX(CAST(t.score AS REAL) / NULLIF(t.total, 0)) FROM attempts t WHERE t.assignment_id = a.id) AS best_ratio
    FROM assignments a
    JOIN materials m ON m.id = a.material_id
    JOIN users u ON u.id = a.student_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.assigned_at DESC, a.id DESC`).all(...params);
}

export function listAttempts(db, assignmentId) {
  return db.prepare('SELECT * FROM attempts WHERE assignment_id = ? ORDER BY id DESC').all(assignmentId);
}

/** 학습 진행 상태 라벨 */
export function progressLabel(a) {
  if (a.attempt_count > 0) return { key: 'done', text: '풀이 완료' };
  if (a.studied_at) return { key: 'studying', text: '학습 중' };
  return { key: 'new', text: '미학습' };
}
