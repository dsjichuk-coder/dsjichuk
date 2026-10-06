import { transaction } from './db.js';
import { parseQuestion } from './grading.js';

export const EMPTY_NOTES = { summary: '', key_concepts: [], sections: [] };

export function getMaterial(db, id) {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, notes: row.notes_json ? JSON.parse(row.notes_json) : EMPTY_NOTES };
}

export function getQuestions(db, materialId) {
  return db.prepare('SELECT * FROM questions WHERE material_id = ? ORDER BY position, id')
    .all(materialId).map(parseQuestion);
}

export function insertQuestion(db, materialId, q) {
  const { next } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM questions WHERE material_id = ?').get(materialId);
  db.prepare(`INSERT INTO questions (material_id, position, type, prompt, choices, answer, explanation)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(materialId, next, q.type, q.prompt, JSON.stringify(q.choices ?? []), JSON.stringify(q.answer), q.explanation ?? '');
}

/** AI 생성 결과로 노트와 문항을 교체한다. */
export function saveGenerated(db, materialId, result) {
  transaction(db, () => {
    db.prepare("UPDATE materials SET notes_json = ?, status = 'ready', error = NULL WHERE id = ?")
      .run(JSON.stringify(result.notes), materialId);
    if (result.title) {
      // 업로드 시 제목을 비워 파일명이 들어간 경우에만 AI 제목으로 교체한다.
      db.prepare('UPDATE materials SET title = ? WHERE id = ? AND title = original_name').run(result.title, materialId);
    }
    db.prepare('DELETE FROM questions WHERE material_id = ?').run(materialId);
    for (const q of result.questions) insertQuestion(db, materialId, q);
  });
}

/** 백그라운드로 AI 생성을 실행한다. 완료/실패는 materials.status 로 기록된다. */
export async function runGeneration(db, generator, materialId, options = {}) {
  const material = getMaterial(db, materialId);
  if (!material) return;
  db.prepare("UPDATE materials SET status = 'processing', error = NULL WHERE id = ?").run(materialId);
  try {
    const result = await generator.generate({ pdfPath: material.pdf_path, ...options });
    saveGenerated(db, materialId, result);
  } catch (err) {
    console.error(`[generation] material ${materialId} failed:`, err);
    db.prepare("UPDATE materials SET status = 'failed', error = ? WHERE id = ?")
      .run(err?.message || String(err), materialId);
  }
}

/** 관리자 폼 입력을 문항 객체로 변환한다. 오류가 있으면 메시지를 throw 한다. */
export function questionFromForm(body) {
  const type = body.type === 'short' ? 'short' : 'mcq';
  const prompt = String(body.prompt ?? '').trim();
  if (!prompt) throw new Error('문제 내용을 입력해 주세요.');
  const explanation = String(body.explanation ?? '').trim();
  if (type === 'mcq') {
    const choices = String(body.choices ?? '').split('\n').map((c) => c.trim()).filter(Boolean);
    if (choices.length < 2) throw new Error('객관식은 보기를 2개 이상 입력해 주세요(한 줄에 하나).');
    const answerNo = Number(body.answer);
    if (!Number.isInteger(answerNo) || answerNo < 1 || answerNo > choices.length) {
      throw new Error(`정답 번호는 1~${choices.length} 사이로 입력해 주세요.`);
    }
    return { type, prompt, choices, answer: answerNo - 1, explanation };
  }
  const accepted = String(body.answer ?? '').split(/\n|\|/).map((a) => a.trim()).filter(Boolean);
  if (accepted.length === 0) throw new Error('단답형 정답을 입력해 주세요(여러 개는 | 로 구분).');
  return { type, prompt, choices: [], answer: accepted, explanation };
}

/** 관리자 폼 입력(노트 편집)을 노트 객체로 변환한다. */
export function notesFromForm(body) {
  const lines = (v) => String(v ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const key_concepts = lines(body.key_concepts).map((line) => {
    const [term, ...rest] = line.split(':');
    return { term: term.trim(), explanation: rest.join(':').trim() };
  }).filter((c) => c.term);
  // 섹션은 "## 제목" 줄로 구분한다.
  const sections = [];
  let current = null;
  for (const line of String(body.sections ?? '').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^##\s*(.*)$/);
    if (m) {
      current = { heading: m[1].trim(), content: '' };
      sections.push(current);
    } else {
      if (!current) { current = { heading: '', content: '' }; sections.push(current); }
      current.content += (current.content ? '\n' : '') + line;
    }
  }
  for (const s of sections) s.content = s.content.trim();
  return { summary: String(body.summary ?? '').trim(), key_concepts, sections: sections.filter((s) => s.heading || s.content) };
}

export function notesToForm(notes) {
  return {
    summary: notes.summary ?? '',
    key_concepts: (notes.key_concepts ?? []).map((c) => `${c.term}: ${c.explanation}`).join('\n'),
    sections: (notes.sections ?? []).map((s) => `## ${s.heading}\n${s.content}`).join('\n\n'),
  };
}
