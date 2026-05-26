// /api/summarize.js — Sensory Journal · Vercel Serverless Function
//
// 역할: Gemini API 호출을 서버에서 대행해 사용자(친구·솔라)의 API 키 부담 0건.
// 키 출처: Vercel 환경변수 GEMINI_API_KEY (코드에 박제 0건).
// Origin 검증: 환경변수 ALLOWED_ORIGIN (콤마 분리, 미설정 시 deny — 보안 우선).
//
// 입력 (POST JSON): { systemText: string, userText: string }
// 출력:
//   200 { text: string }
//   4xx/5xx { error: { code, message } }   // 클라이언트가 그대로 callGemini 에러 분류로 매핑
//
// 에러 코드 (클라이언트 callGemini와 동일 분류 유지):
//   - NO_KEY      : 서버에 키 미설정 (환경변수 누락)
//   - AUTH        : Google이 키 거부 (401/403, 또는 400 + API_KEY_INVALID)
//   - RATE_LIMIT  : Google 429
//   - HTTP        : 그 외 비정상 HTTP
//   - EMPTY       : 응답 본문 비어 있음
//   - PARSE       : JSON 파싱 실패
//   - NETWORK     : fetch 자체 실패 (DNS·TLS 등)
//   - BAD_REQUEST : 클라이언트 입력 누락·형식 오류
//   - FORBIDDEN_ORIGIN : Origin 검증 실패 (키 도용 차단)

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ---------- Origin 검증 ----------
// ALLOWED_ORIGIN: 콤마 분리 문자열. 예: "https://solar-selfishclub.github.io,https://sensory-journal.vercel.app"
// 환경변수 미설정 시 deny default — 절대 와일드카드 허용 안 함 (키 도용 방지).
function isAllowedOrigin(reqOrigin) {
  const env = (process.env.ALLOWED_ORIGIN || '').trim();
  if (!env) return false; // deny by default
  const allowed = env.split(',').map(s => s.trim()).filter(Boolean);
  return allowed.indexOf(reqOrigin) !== -1;
}

// ---------- 응답 헬퍼 ----------
function jsonError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

// ---------- 메인 핸들러 ----------
export default async function handler(req, res) {
  // CORS preflight — 같은 origin이라면 호출되지 않지만 안전판으로 응답.
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '';
    if (isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    return jsonError(res, 405, 'HTTP', 'POST만 허용됩니다.');
  }

  // Origin 검증 — Origin 또는 Referer로 자기 도메인 외 차단.
  // 위조 가능하지만 친구 시범 규모 안전망으로 충분 (파트너 결정 박제와 정합).
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  const refererOrigin = referer ? (() => {
    try { return new URL(referer).origin; } catch (_) { return ''; }
  })() : '';
  if (!isAllowedOrigin(origin) && !isAllowedOrigin(refererOrigin)) {
    return jsonError(res, 403, 'FORBIDDEN_ORIGIN', '허용되지 않은 출처에서의 요청입니다.');
  }
  // 같은 origin이라도 응답에 CORS 헤더 박아두면 향후 미디어 분리 시 호환.
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);

  // 환경변수 키 검증.
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return jsonError(res, 500, 'NO_KEY', '서버 설정 점검이 필요합니다. (API 키 미설정)');
  }

  // 본문 파싱 — Vercel은 application/json을 자동 파싱(req.body 객체).
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) {
      return jsonError(res, 400, 'BAD_REQUEST', '요청 본문을 읽지 못했습니다.');
    }
  }
  const systemText = body && typeof body.systemText === 'string' ? body.systemText : '';
  const userText   = body && typeof body.userText   === 'string' ? body.userText   : '';
  if (!systemText || !userText) {
    return jsonError(res, 400, 'BAD_REQUEST', 'systemText·userText가 필요합니다.');
  }

  // Gemini 호출.
  const url = `${GEMINI_URL}?key=${encodeURIComponent(key)}`;
  const payload = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }]
  };

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (networkErr) {
    return jsonError(res, 502, 'NETWORK', '상류 연결이 잠시 끊겼습니다.');
  }

  // HTTP 분류 — 클라이언트 callGemini 분류와 동일하게 매핑.
  if (upstream.status === 429) {
    return jsonError(res, 429, 'RATE_LIMIT', '오늘 무료 한도가 다 찼습니다.');
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return jsonError(res, 502, 'AUTH', '상류 인증 오류 — 서버 키 점검이 필요합니다.');
  }
  if (!upstream.ok) {
    let bodyText = '';
    try { bodyText = await upstream.text(); } catch (_) {}
    // HTTP 400 + API_KEY_INVALID → AUTH 분류 (callGemini 라인 2573 흐름 그대로).
    if (upstream.status === 400 && bodyText.indexOf('API_KEY_INVALID') !== -1) {
      return jsonError(res, 502, 'AUTH', '상류 키 거부 — 서버 키 점검이 필요합니다.');
    }
    return jsonError(res, 502, 'HTTP', `상류 응답 오류 (HTTP ${upstream.status}).`);
  }

  let data;
  try {
    data = await upstream.json();
  } catch (_) {
    return jsonError(res, 502, 'PARSE', '상류 응답을 읽지 못했습니다.');
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    return jsonError(res, 502, 'EMPTY', '상류 응답이 비어 있습니다.');
  }

  return res.status(200).json({ text });
}
