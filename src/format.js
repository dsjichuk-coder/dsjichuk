const TZ = process.env.TZ_DISPLAY || 'Asia/Seoul';

/** SQLite 의 UTC 시각 문자열('YYYY-MM-DD HH:MM:SS')을 한국 시간으로 표시한다. */
export function fmtDate(value) {
  if (!value) return '-';
  const iso = /T/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

export const STATUS_LABELS = {
  processing: 'AI 생성 중',
  ready: '발송 가능',
  draft: '작성 필요',
  failed: '생성 실패',
};
