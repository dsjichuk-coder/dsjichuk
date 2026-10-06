import fs from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';

// Claude 구조화 출력(JSON schema). 모든 필드는 required 이고 추가 속성은 허용하지 않는다.
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'key_concepts', 'sections', 'questions'],
  properties: {
    title: { type: 'string', description: '학습자료의 제목' },
    summary: { type: 'string', description: '자료 전체를 3~5문장으로 요약' },
    key_concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'explanation'],
        properties: { term: { type: 'string' }, explanation: { type: 'string' } },
      },
    },
    sections: {
      type: 'array',
      description: '학습자가 순서대로 읽을 수 있는 학습 노트 섹션',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'content'],
        properties: { heading: { type: 'string' }, content: { type: 'string' } },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'prompt', 'choices', 'answer_index', 'accepted_answers', 'explanation'],
        properties: {
          type: { type: 'string', enum: ['mcq', 'short'] },
          prompt: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' }, description: 'mcq 는 보기 4~5개, short 는 빈 배열' },
          answer_index: { type: 'integer', description: 'mcq 정답 보기의 0부터 시작하는 번호, short 는 -1' },
          accepted_answers: { type: 'array', items: { type: 'string' }, description: 'short 의 허용 정답들, mcq 는 빈 배열' },
          explanation: { type: 'string', description: '정답 근거와 오답이 틀린 이유를 포함한 해설' },
        },
      },
    },
  },
};

function buildPrompt({ questionCount, instructions }) {
  return [
    '첨부한 PDF는 학생에게 발송할 학습자료입니다. 이 자료만을 근거로 다음을 한국어로 작성해 주세요.',
    '',
    '1. summary: 자료 전체 요약',
    '2. key_concepts: 핵심 개념과 그 설명',
    '3. sections: 학생이 원문을 보지 않고도 공부할 수 있도록 자료의 흐름을 따라 정리한 학습 노트. 각 content 는 문단 구분에 빈 줄을 쓰는 일반 텍스트로 작성',
    `4. questions: 학습 내용을 확인하는 문제 ${questionCount}개. 객관식(mcq)을 중심으로 하되 핵심 용어를 묻는 단답형(short)을 일부 섞어 주세요.`,
    '',
    '문제 작성 기준:',
    '- 자료에서 확인할 수 있는 내용만 출제하고, 단순 암기보다 이해를 확인하는 문제를 우선합니다.',
    '- 객관식은 보기 4~5개, 정답은 정확히 하나이며 정답 위치를 고르게 분산합니다.',
    '- 단답형은 답이 한 단어 또는 짧은 구로 명확히 정해지는 문제만 내고, 같은 뜻의 표기(약어, 영문 등)를 accepted_answers 에 모두 넣습니다.',
    '- explanation 에는 정답의 근거가 되는 자료 내용과, 객관식의 경우 주요 오답이 틀린 이유를 적습니다.',
    instructions ? `\n관리자 추가 요청: ${instructions}` : '',
  ].join('\n');
}

/** 모델 출력을 검증·정리해 DB에 넣을 수 있는 형태로 바꾼다. 잘못된 문항은 버린다. */
export function normalizeGenerated(raw) {
  const questions = [];
  for (const q of raw.questions ?? []) {
    const prompt = String(q.prompt ?? '').trim();
    if (!prompt) continue;
    if (q.type === 'mcq') {
      const choices = (q.choices ?? []).map((c) => String(c).trim()).filter(Boolean);
      const idx = Number(q.answer_index);
      if (choices.length < 2 || !Number.isInteger(idx) || idx < 0 || idx >= choices.length) continue;
      questions.push({ type: 'mcq', prompt, choices, answer: idx, explanation: String(q.explanation ?? '') });
    } else if (q.type === 'short') {
      const accepted = (q.accepted_answers ?? []).map((a) => String(a).trim()).filter(Boolean);
      if (accepted.length === 0) continue;
      questions.push({ type: 'short', prompt, choices: [], answer: accepted, explanation: String(q.explanation ?? '') });
    }
  }
  return {
    title: String(raw.title ?? '').trim(),
    notes: {
      summary: String(raw.summary ?? ''),
      key_concepts: (raw.key_concepts ?? []).filter((c) => c?.term),
      sections: (raw.sections ?? []).filter((s) => s?.heading || s?.content),
    },
    questions,
  };
}

/**
 * Claude API 로 PDF 학습자료에서 학습 노트와 문제를 생성한다.
 * ANTHROPIC_API_KEY(또는 SDK가 인식하는 다른 인증 수단)가 필요하다.
 */
export function createClaudeGenerator({ client = new Anthropic(), model = DEFAULT_MODEL } = {}) {
  return {
    enabled: true,
    async generate({ pdfPath, questionCount = 10, instructions = '' }) {
      const data = (await fs.readFile(pdfPath)).toString('base64');
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
            { type: 'text', text: buildPrompt({ questionCount, instructions }) },
          ],
        }],
      });
      const message = await stream.finalMessage();

      if (message.stop_reason === 'refusal') {
        throw new Error('AI가 이 자료의 처리를 거절했습니다. 내용을 확인하거나 문항을 직접 작성해 주세요.');
      }
      if (message.stop_reason === 'max_tokens') {
        throw new Error('자료가 너무 길어 생성이 중간에 끊겼습니다. 문항 수를 줄이거나 자료를 나누어 올려 주세요.');
      }
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('AI 응답을 해석하지 못했습니다. 다시 생성해 주세요.');
      }
      const result = normalizeGenerated(raw);
      if (result.questions.length === 0) throw new Error('유효한 문항이 생성되지 않았습니다.');
      return result;
    },
  };
}

/** API 키가 없을 때 사용: 생성 없이 관리자가 직접 노트와 문항을 작성한다. */
export const manualGenerator = { enabled: false, async generate() { throw new Error('AI 생성이 비활성화되어 있습니다.'); } };

export function generatorFromEnv(env = process.env) {
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return manualGenerator;
  return createClaudeGenerator({ model: env.CLAUDE_MODEL || DEFAULT_MODEL });
}
