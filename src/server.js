import path from 'node:path';
import { openDatabase } from './db.js';
import { ensureAdmin } from './auth.js';
import { generatorFromEnv } from './generator.js';
import { createApp } from './app.js';

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || 'data');
const db = openDatabase(path.join(dataDir, 'app.db'));

const adminUser = env.ADMIN_USERNAME || 'admin';
const adminPass = env.ADMIN_PASSWORD || 'admin1234';
if (ensureAdmin(db, { username: adminUser, password: adminPass })) {
  console.log(`관리자 계정을 만들었습니다: ${adminUser} / ${env.ADMIN_PASSWORD ? '(ADMIN_PASSWORD)' : adminPass}`);
  if (!env.ADMIN_PASSWORD) console.log('※ 로그인 후 [내 계정]에서 비밀번호를 꼭 변경하세요.');
}

// 서버가 생성 도중 재시작된 경우 멈춘 작업을 실패로 표시한다.
db.prepare("UPDATE materials SET status = 'failed', error = '서버 재시작으로 생성이 중단되었습니다. 다시 생성해 주세요.' WHERE status = 'processing'").run();

const generator = generatorFromEnv(env);
if (!generator.enabled) {
  console.log('ANTHROPIC_API_KEY 가 없어 AI 생성이 꺼져 있습니다. 학습 노트와 문항은 직접 작성할 수 있습니다.');
}

const app = createApp({
  db,
  generator,
  uploadDir: path.join(dataDir, 'uploads'),
  secureCookies: env.COOKIE_SECURE === 'true',
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => console.log(`http://localhost:${port} 에서 실행 중`));
