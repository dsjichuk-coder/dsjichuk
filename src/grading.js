/** 단답형 비교용 정규화: 대소문자·공백·문장부호 차이는 무시한다. */
export function normalizeAnswer(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.,!?;:'"`()[\]{}<>~·・\-_/\\]/g, '');
}

export function parseQuestion(row) {
  return {
    id: row.id,
    position: row.position,
    type: row.type,
    prompt: row.prompt,
    choices: JSON.parse(row.choices || '[]'),
    answer: JSON.parse(row.answer),
    explanation: row.explanation,
  };
}

/** 문항 하나를 채점한다. question 은 parseQuestion 결과 형태. */
export function gradeQuestion(question, response) {
  if (question.type === 'mcq') {
    if (response === undefined || response === null || response === '') return false;
    return Number(response) === Number(question.answer);
  }
  const given = normalizeAnswer(response);
  if (!given) return false;
  return question.answer.some((accepted) => normalizeAnswer(accepted) === given);
}

/** 학생 응답(responses: { [questionId]: string })으로 전체 문항을 채점한다. */
export function gradeAttempt(questions, responses) {
  const results = questions.map((q) => {
    const response = responses?.[q.id] ?? '';
    return { question: q, response: String(response), isCorrect: gradeQuestion(q, response) };
  });
  const score = results.filter((r) => r.isCorrect).length;
  return { score, total: questions.length, results };
}

/** 정답을 사람이 읽을 수 있는 문자열로 표시한다. */
export function formatAnswer(question) {
  if (question.type === 'mcq') {
    const idx = Number(question.answer);
    return `${idx + 1}번. ${question.choices[idx] ?? ''}`;
  }
  return question.answer.join(' / ');
}

export function formatResponse(question, response) {
  if (response === '' || response === null || response === undefined) return '(미응답)';
  if (question.type === 'mcq') {
    const idx = Number(response);
    return `${idx + 1}번. ${question.choices[idx] ?? ''}`;
  }
  return response;
}
