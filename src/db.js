import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'student')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- status: processing(AI 생성 중) | ready(배포 가능) | draft(수동 작성 필요) | failed(생성 실패)
CREATE TABLE IF NOT EXISTS materials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL,
  pdf_path      TEXT NOT NULL,
  notes_json    TEXT,
  status        TEXT NOT NULL DEFAULT 'processing',
  error         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- type: mcq(객관식) | short(단답형)
-- answer: mcq -> 정답 보기 번호(0부터), short -> 허용 정답 문자열 JSON 배열
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('mcq', 'short')),
  prompt      TEXT NOT NULL,
  choices     TEXT NOT NULL DEFAULT '[]',
  answer      TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT ''
);

-- 학습자료 발송 기록 (학생 1명 x 자료 1건)
CREATE TABLE IF NOT EXISTS assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     TEXT NOT NULL DEFAULT '',
  due_date    TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  studied_at  TEXT,
  UNIQUE (material_id, student_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  score         INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  submitted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 제출 시점의 문항을 스냅샷으로 저장해, 이후 문항을 수정해도 과거 결과가 바뀌지 않게 한다.
CREATE TABLE IF NOT EXISTS attempt_answers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id        INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id       INTEGER,
  position          INTEGER NOT NULL,
  question_snapshot TEXT NOT NULL,
  response          TEXT NOT NULL DEFAULT '',
  is_correct        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_material ON questions(material_id, position);
CREATE INDEX IF NOT EXISTS idx_assignments_student ON assignments(student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_assignment ON attempts(assignment_id);
CREATE INDEX IF NOT EXISTS idx_answers_attempt ON attempt_answers(attempt_id, position);
`;

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** 여러 쓰기 작업을 하나의 트랜잭션으로 묶는다. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
