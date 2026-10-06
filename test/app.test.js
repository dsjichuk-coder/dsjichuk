import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { ensureAdmin } from '../src/auth.js';
import { createApp } from '../src/app.js';

const fakeGenerator = {
  enabled: true,
  calls: 0,
  async generate({ pdfPath, questionCount }) {
    this.calls += 1;
    assert.ok(fs.existsSync(pdfPath));
    assert.equal(questionCount, 2);
    return {
      title: '광합성 단원',
      notes: { summary: '식물은 빛으로 양분을 만든다.', key_concepts: [{ term: '엽록체', explanation: '광합성이 일어나는 곳' }], sections: [{ heading: '광합성', content: '빛 에너지를 화학 에너지로' }] },
      questions: [
        { type: 'mcq', prompt: '광합성이 일어나는 곳은?', choices: ['핵', '엽록체', '미토콘드리아'], answer: 1, explanation: '엽록체에서 일어난다.' },
        { type: 'short', prompt: '광합성에 필요한 기체는?', choices: [], answer: ['이산화탄소', 'CO2'], explanation: '이산화탄소를 흡수한다.' },
      ],
    };
  },
};

let server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-test-'));
  const db = openDatabase(':memory:');
  ensureAdmin(db, { username: 'admin', password: 'admin1234' });
  const app = createApp({ db, generator: fakeGenerator, uploadDir: path.join(dir, 'uploads') });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 쿠키를 유지하는 간단한 클라이언트 */
function client() {
  let cookie = '';
  const req = async (url, opts = {}) => {
    const res = await fetch(base + url, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const form = (url, data) => req(url, {
    method: 'POST', body: new URLSearchParams(data).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  return { req, form, login: (u, p) => form('/login', { username: u, password: p }) };
}

test('전체 흐름: 업로드 → AI 생성 → 발송 → 학습 → 풀이 → 채점/해설 → 관리자 확인', async () => {
  const admin = client();
  let res = await admin.login('admin', 'wrong');
  assert.equal(res.status, 401);
  res = await admin.login('admin', 'admin1234');
  assert.equal(res.headers.get('location'), '/admin');

  // 학생 등록
  res = await admin.form('/admin/students', { name: '김학생', username: 'kim', password: 'pass1234' });
  assert.equal(res.status, 302);
  res = await admin.form('/admin/students', { name: '이학생', username: 'lee', password: 'pass1234' });
  assert.equal(res.status, 302);

  // PDF 업로드
  const fd = new FormData();
  fd.append('pdf', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), '광합성.pdf');
  fd.append('title', '');
  fd.append('question_count', '2');
  res = await admin.req('/admin/materials', { method: 'POST', body: fd });
  assert.equal(res.status, 302);
  const materialUrl = res.headers.get('location').split('?')[0];
  const materialId = materialUrl.split('/').pop();

  // 생성 완료 대기
  let status;
  for (let i = 0; i < 50; i++) {
    status = (await (await admin.req(`${materialUrl}/status`)).json()).status;
    if (status !== 'processing') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(status, 'ready');
  let html = await (await admin.req(materialUrl)).text();
  assert.match(html, /광합성 단원/); // 파일명 대신 AI 제목
  assert.match(html, /엽록체/);

  // 학생 1명에게 발송
  const kimId = html.match(/name="student_ids" value="(\d+)"> 김학생/)[1];
  res = await admin.form(`${materialUrl}/assign`, { student_ids: kimId, message: '금요일까지!', due_date: '2026-12-31' });
  assert.match(decodeURIComponent(res.headers.get('location')), /1명에게 발송/);

  // 다른 학생은 볼 수 없음
  const lee = client();
  await lee.login('lee', 'pass1234');
  html = await (await lee.req('/student')).text();
  assert.match(html, /아직 받은 학습자료가 없습니다/);

  // 학생 학습
  const kim = client();
  await kim.login('kim', 'pass1234');
  html = await (await kim.req('/student')).text();
  assert.match(html, /광합성 단원/);
  const assignmentId = html.match(/\/student\/assignments\/(\d+)"/)[1];
  assert.equal((await lee.req(`/student/assignments/${assignmentId}`)).status, 404);
  html = await (await kim.req(`/student/assignments/${assignmentId}`)).text();
  assert.match(html, /금요일까지!/);
  assert.match(html, /빛 에너지를 화학 에너지로/);
  res = await kim.req(`/student/assignments/${assignmentId}/pdf`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');

  // 학생은 관리자 페이지 접근 불가
  assert.equal((await kim.req('/admin')).status, 403);

  // 문제 풀이 및 제출 (1번 정답, 2번 표기 차이 있는 정답)
  html = await (await kim.req(`/student/assignments/${assignmentId}/quiz`)).text();
  const qids = [...html.matchAll(/name="q_(\d+)"/g)].map((m) => m[1]);
  const [q1, q2] = [...new Set(qids)];
  res = await kim.form(`/student/assignments/${assignmentId}/quiz`, { [`q_${q1}`]: '0', [`q_${q2}`]: 'co 2' });
  const resultUrl = res.headers.get('location');
  assert.match(resultUrl, /^\/student\/attempts\/\d+$/);
  html = await (await kim.req(resultUrl)).text();
  assert.match(html, /2문항 중 1문항을 맞혔어요/);
  assert.match(html, /엽록체에서 일어난다\./); // 해설
  assert.match(html, /이산화탄소를 흡수한다\./);
  assert.equal((await lee.req(resultUrl)).status, 404);

  // 관리자: 문항 수정 후에도 기존 결과는 스냅샷 유지
  res = await admin.form(`${materialUrl}/questions/${q1}`, { type: 'mcq', prompt: '바뀐 문제', choices: 'x\ny', answer: '1', explanation: '' });
  assert.equal(res.status, 302);

  // 관리자: 학생별 결과 확인
  html = await (await admin.req(`/admin/students/${kimId}`)).text();
  assert.match(html, /광합성 단원/);
  assert.match(html, /1\/2 \(50점\)/);
  const attemptId = resultUrl.split('/').pop();
  html = await (await admin.req(`/admin/attempts/${attemptId}`)).text();
  assert.match(html, /김학생/);
  assert.match(html, /광합성이 일어나는 곳은\?/);
  assert.doesNotMatch(html, /바뀐 문제/);
  html = await (await admin.req(`/admin/materials/${materialId}`)).text();
  assert.match(html, /최근 풀이 \(총 1회\)/);
  html = await (await admin.req('/admin')).text();
  assert.match(html, /김학생/);
  assert.equal(fakeGenerator.calls, 1);
});

test('PDF가 아닌 파일은 거부한다', async () => {
  const admin = client();
  await admin.login('admin', 'admin1234');
  const fd = new FormData();
  fd.append('pdf', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  const res = await admin.req('/admin/materials', { method: 'POST', body: fd });
  assert.match(decodeURIComponent(res.headers.get('location')), /PDF 파일만/);
});
