// moves.js
// 기술 사전
// power: 기본 위력 (0이면 랭크 전용 기술)
// type: 기술 타입
// accuracy: 명중률 (0~100, 퍼센트)
// alwaysHit: true = 회피율 무시하고 반드시 명중
// effect: 부가효과 (없으면 null)
//   - chance: 발동 확률 (0.0~1.0)
//   - status: 상태이상 ("독" / "화상" / "마비" / "얼음")
//   - volatile: 상태변화 ("혼란" / "풀죽음")
// rank: 랭크 변화 (없으면 undefined)
//   자신 대상: atk / def / spd (양수 = 랭크업)
//   상대 대상: targetAtk / targetDef / targetSpd (음수 = 랭크다운)
//   chance: 발동 확률 (없으면 100%)
//   turns: 지속 턴 (없으면 기본 2턴)
//   ※ power: 0 → 자신 대상이면 accuracy만 판정, 상대 대상이면 회피까지 판정
//   ※ power > 0 → 데미지 후 rank가 있으면 확률적으로 추가 적용

export const moves = {
  // ───── 랭크 기술 ─────
  "칼춤":     { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { atk: 3 } },
  "코튼가드": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { def: 2 } },
  "고속이동": { power: 0, type: "노말", accuracy: 100, alwaysHit: true, effect: null,
                rank: { spd: 3 } },

  // ───── 노말 ─────
  "전광석화":       { power: 30, type: "노말", accuracy: 100, alwaysHit: true,  effect: null },
  "몸통박치기":     { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, volatile: "풀죽음" } },
  "하이퍼보이스":   { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "할퀴기":         { power: 40, type: "노말", accuracy: 100, alwaysHit: false, effect: null },
  "속이기":         { power: 30, type: "노말", accuracy: 50, alwaysHit: false, skipEvasion: true, effect: { chance: 1, volatile: "풀죽음" }},
  "울음소리":       { power: 0, type: "노말", accuracy: 100, alwaysHit: false, effect: null, rank: { targetAtk: -1 } },
  "뽐내기":         { power: 0, type: "노말", accuracy: 85, alwaysHit: false, effect: null, rank: { targetAtk: 2 }, effect: { chance: 1, volatile: "혼란" } },

  // ───── 불 ─────
  "화염방사": { power: 50, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "불꽃엄니": { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "열풍":     { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "불대문자": { power: 40, type: "불", accuracy: 85,  alwaysHit: false, effect: null },
  "불꽃세례": { power: 40, type: "불", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "매지컬플레임": { power: 45, type: "불", accuracy: 100, alwaysHit: false, effect: null, rank: { targetAtk: -1 } },


  // ───── 물 ─────
  "거품광선":     { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "거품":         { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "파도타기":     { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "물대포":       { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },
  "하이드로펌프": { power: 40, type: "물", accuracy: 80,  alwaysHit: false, effect: null },
  "아쿠아제트":   { power: 40, type: "물", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 전기 ─────
  "번개펀치": { power: 40, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "마비" } },
  "10만볼트": { power: 50, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "마비" } },
  "방전":     { power: 40, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, volatile: "풀죽음" } },
  "번개":     { power: 60, type: "전기", accuracy: 70,  alwaysHit: false, effect: { chance: 0.3, status: "마비" } },
  "전기쇼크": { power: 40, type: "전기", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "마비" } },
  "전기자석파": { power: 0, type: "전기", accuracy: 90, alwaysHit: false, effect: { chance: 1, status: "마비" } },

  // ───── 풀 ─────
  "에너지볼":   { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "솔라빔":     { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "잎날가르기": { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },
  "씨폭탄":     { power: 40, type: "풀", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 얼음 ─────
  "눈보라":     { power: 40, type: "얼음", accuracy: 70,  alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "냉동빔":     { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "아이스펀치": { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "얼음엄니":   { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },
  "아이스해머": { power: 40, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "얼음" } },

  // ───── 격투 ─────
  "인파이트":           { power: 40, type: "격투", accuracy: 100, alwaysHit: false, effect: null },
  "파동탄":             { power: 40, type: "격투", accuracy: 100, alwaysHit: true,  effect: null },
  "발뒤꿈치떨어뜨리기": { power: 40, type: "격투", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 독 ─────
  "독침붕": { power: 40, type: "독", accuracy: 100, alwaysHit: false, effect: { chance: 0.3, status: "독" } },
  "헤이즈": { power: 40, type: "독", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, status: "독" } },

  // ───── 땅 ─────
  "지진":     { power: 40, type: "땅", accuracy: 100, alwaysHit: false, effect: null },
  "땅가르기": { power: 40, type: "땅", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 바위 ─────
  "스톤에지":   { power: 40, type: "바위", accuracy: 80, alwaysHit: false, effect: null },
  "바위깨기":   { power: 30, type: "바위", accuracy: 80, alwaysHit: false, effect: null, rank: { targetDef: -1 } },
  "파워젬":     { power: 50, type: "바위", accuracy: 80, alwaysHit: false, effect: null },
  "록블라스트": { power: 40, type: "바위", accuracy: 90, alwaysHit: false, effect: null },
  "원시의힘":   { power: 40, type: "바위", accuracy: 100, alwaysHit: false, effect: null, rank: { chance: 0.1, atk: 1, def: 1, spd: 1 } },

  // ───── 비행 ─────
  "에어슬래시": { power: 40, type: "비행", accuracy: 95,  alwaysHit: false, effect: { chance: 0.3, volatile: "풀죽음" } },
  "열풍비행":   { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: { chance: 0.1, status: "화상" } },
  "쪼기":   { power: 40, type: "비행", accuracy: 100, alwaysHit: false, effect: null },
  

  // ───── 에스퍼 ─────
  "사이코키네시스": { power: 40, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null },
  "미래예지":       { power: 40, type: "에스퍼", accuracy: 100, alwaysHit: false, effect: null },
  "명상":           { power: 0, type: "에스퍼", accuracy: 100, alwaysHit: true, effect: null, rank: { chance: 1, atk: 1, def: 1} },

  // ───── 벌레 ─────
  "버그버즈":   { power: 40, type: "벌레", accuracy: 100, alwaysHit: false, effect: null },
  "시저크로스": { power: 40, type: "벌레", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 고스트 ─────
  "섀도볼":     { power: 50, type: "고스트", accuracy: 100, alwaysHit: false, effect: null, rank: { targetDef: -1 } },
  "나이트헤드": { power: 40, type: "고스트", accuracy: 100, alwaysHit: true,  effect: null },
  "섀도스니크": { power: 40, type: "고스트", accuracy: 100, alwaysHit: false, effect: null },

  // ───── 드래곤 ─────
  "드래곤크루": { power: 40, type: "드래곤", accuracy: 100, alwaysHit: false, effect: null },
  "역린":       { power: 40, type: "드래곤", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, volatile: "혼란" } },

  // ───── 악 ─────
  "악의파동": { power: 50, type: "악", accuracy: 100, alwaysHit: false, effect: { chance: 0.2, volatile: "풀죽음" } },
  "암타":     { power: 40, type: "악", accuracy: 100, alwaysHit: false, effect: null },
  "바크아웃":     { power: 0, type: "악", accuracy: 95, alwaysHit: false, effect: null, rank: { targetAtk: -1 } },

  // ───── 강철 ─────
  "아이언테일": { power: 50, type: "강철", accuracy: 75, alwaysHit: false, effect: null, rank: { chance: 0.3, targetDef: -1 } },
  "메탈크로우": { power: 40, type: "강철", accuracy: 95,  alwaysHit: false, effect: null, rank: { chance: 0.1, atk: 1 } },
  "불릿펀치":   { power: 40, type: "강철", accuracy: 100, alwaysHit: false, effect: null },
  "플래시캐논": { power: 40, type: "강철", accuracy: 100, alwaysHit: true,  effect: null },

  // ───── 페어리 ─────
  "문포스":     { power: 40, type: "페어리", accuracy: 100, alwaysHit: false, effect: null },
  "매지컬샤인": { power: 40, type: "페어리", accuracy: 100, alwaysHit: true,  effect: null },
  "드레인키스": { power: 40, type: "페어리", accuracy: 100, alwaysHit: false, effect: { drain: 0.2 } },

  // ───── 날씨 ─────
  "맑게개다": { power: 0, type: "불",   accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "쾌청" } },
  "비바라기": { power: 0, type: "물",   accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "비" } },
  "모래바람": { power: 0, type: "바위", accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "모래바람" } },
  "싸라기눈": { power: 0, type: "얼음", accuracy: 100, alwaysHit: false, effect: { chance: 1.0, weather: "싸라기눈" } },
}
