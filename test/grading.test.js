import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeQuestion, gradeAttempt, normalizeAnswer, formatAnswer } from '../src/grading.js';
import { normalizeGenerated } from '../src/generator.js';
import { questionFromForm, notesFromForm, notesToForm } from '../src/materials.js';

const mcq = { id: 1, type: 'mcq', prompt: 'Q', choices: ['a', 'b', 'c'], answer: 1, explanation: '' };
const short = { id: 2, type: 'short', prompt: 'Q', choices: [], answer: ['광합성', 'photosynthesis'], explanation: '' };

test('객관식 채점', () => {
  assert.equal(gradeQuestion(mcq, '1'), true);
  assert.equal(gradeQuestion(mcq, '0'), false);
  assert.equal(gradeQuestion(mcq, ''), false);
});

test('단답형 채점은 공백·대소문자·문장부호를 무시한다', () => {
  assert.equal(gradeQuestion(short, ' 광 합성. '), true);
  assert.equal(gradeQuestion(short, 'PhotoSynthesis'), true);
  assert.equal(gradeQuestion(short, '호흡'), false);
  assert.equal(gradeQuestion(short, ''), false);
  assert.equal(normalizeAnswer('Ｈ２Ｏ'), 'h2o');
});

test('전체 채점과 정답 표시', () => {
  const r = gradeAttempt([mcq, short], { 1: '1', 2: '호흡' });
  assert.equal(r.score, 1);
  assert.equal(r.total, 2);
  assert.equal(formatAnswer(mcq), '2번. b');
  assert.equal(formatAnswer(short), '광합성 / photosynthesis');
});

test('AI 출력 정리: 잘못된 문항은 버린다', () => {
  const out = normalizeGenerated({
    title: 'T', summary: 's', key_concepts: [], sections: [],
    questions: [
      { type: 'mcq', prompt: 'ok', choices: ['a', 'b'], answer_index: 0, accepted_answers: [], explanation: 'e' },
      { type: 'mcq', prompt: 'bad index', choices: ['a', 'b'], answer_index: 5, accepted_answers: [], explanation: '' },
      { type: 'short', prompt: 'no answer', choices: [], answer_index: -1, accepted_answers: [], explanation: '' },
      { type: 'short', prompt: 'ok2', choices: [], answer_index: -1, accepted_answers: ['x'], explanation: '' },
    ],
  });
  assert.deepEqual(out.questions.map((q) => q.prompt), ['ok', 'ok2']);
});

test('관리자 문항 폼 변환', () => {
  assert.deepEqual(questionFromForm({ type: 'mcq', prompt: 'p', choices: 'a\nb\n\nc', answer: '3', explanation: '' }).answer, 2);
  assert.deepEqual(questionFromForm({ type: 'short', prompt: 'p', answer: 'x | y' }).answer, ['x', 'y']);
  assert.throws(() => questionFromForm({ type: 'mcq', prompt: 'p', choices: 'a\nb', answer: '3' }));
});

test('학습 노트 폼 왕복 변환', () => {
  const notes = { summary: '요약', key_concepts: [{ term: 'A', explanation: '설명: 상세' }], sections: [{ heading: '1장', content: '내용\n\n둘째 문단' }] };
  assert.deepEqual(notesFromForm(notesToForm(notes)), notes);
});
