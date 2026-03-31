// js/doublebattle.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, collection, getDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js"
import { moves } from "./moves.js"
import { josa } from "./effecthandler.js"

window.__moves = moves

// ── Firebase Functions 연결 ──────────────────────
const functions      = getFunctions()
const _startRound    = httpsCallable(functions, "startRound")
const _useMove       = httpsCallable(functions, "useMove")
const _switchPkmn    = httpsCallable(functions, "switchPokemon")
const _forcedSwitch  = httpsCallable(functions, "forcedSwitch")
const _skipTurn      = httpsCallable(functions, "skipTurn")
const _requestAssist = httpsCallable(functions, "requestAssist")
const _acceptAssist  = httpsCallable(functions, "acceptAssist")
const _rejectAssist  = httpsCallable(functions, "rejectAssist")
const _requestSync   = httpsCallable(functions, "requestSync")
const _acceptSync    = httpsCallable(functions, "acceptSync")
const _rejectSync    = httpsCallable(functions, "rejectSync")
const _leaveGame     = httpsCallable(functions, "leaveGame")

const roomRef = doc(db, "double", ROOM_ID)
const logsRef = collection(db, "double", ROOM_ID, "logs")

// ── 상태 변수 ────────────────────────────────────
let mySlot = null, myUid = null
let myTurn = false, actionDone = false, gameOver = false
let lastDiceEventTs    = 0
let lastHitEventTs     = 0
let lastAttackDiceTs   = 0
let lastAssistEventTs  = 0
let lastSyncEventTs    = 0
let renderedLogIds     = new Set()
let renderedSyncLogs   = new Set()
let typingQueue = [], isTyping = false
let pendingMoveIdx = -1
let isHandlingSnapshot = false

const isSpectator = new URLSearchParams(location.search).get("spectator") === "true"

// ── 타입 컬러 ────────────────────────────────────
const TYPE_COLORS = {
  "노말":"#949495","불":"#e56c3e","물":"#5185c5","전기":"#fbb917","풀":"#66a945",
  "얼음":"#6dc8eb","격투":"#e09c40","독":"#735198","땅":"#9c7743","바위":"#bfb889",
  "비행":"#a2c3e7","에스퍼":"#dd6b7b","벌레":"#9fa244","고스트":"#684870",
  "드래곤":"#535ca8","악":"#4c4948","강철":"#69a9c7","페어리":"#dab4d4"
}

// ── 유틸 ─────────────────────────────────────────
function $(id) { return document.getElementById(id) }
function rollD10() { return Math.floor(Math.random() * 10) + 1 }

function teamOf(s)       { return ["p1","p2"].includes(s) ? "A" : "B" }
function allyOf(s)       { return s==="p1"?"p2":s==="p2"?"p1":s==="p3"?"p4":"p3" }
function enemySlotsOf(s) { return teamOf(s)==="A" ? ["p3","p4"] : ["p1","p2"] }

function isTeamAllDead(data) {
  if(!mySlot) return false
  const ally      = allyOf(mySlot)
  const myEntry   = data[`${mySlot}_entry`] ?? []
  const allyEntry = data[`${ally}_entry`]   ?? []
  return myEntry.every(p => p.hp <= 0) && allyEntry.every(p => p.hp <= 0)
}

function slotToPrefix(slot) {
  if(!mySlot) return null
  if(slot === mySlot)          return "my"
  if(slot === allyOf(mySlot))  return "ally"
  const enemies = enemySlotsOf(mySlot)
  return slot === enemies[0] ? "enemy1" : "enemy2"
}

// ── HP 바 ─────────────────────────────────────────
function updateHpBar(barId, textId, hp, maxHp, showNum) {
  const bar = $(barId), txt = textId ? $(textId) : null
  if(!bar) return
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, hp / maxHp * 100)) : 0
  bar.style.width = pct + "%"
  bar.style.backgroundColor = pct > 50 ? "#4caf50" : pct > 20 ? "#ff9800" : "#f44336"
  if(txt) txt.innerText = showNum ? `HP: ${hp} / ${maxHp}` : ""
}

// ── 포트레이트 ────────────────────────────────────
function updatePortrait(prefix, pokemon) {
  const img = $(`${prefix}-portrait`)
  const ph  = $(`${prefix}-portrait-placeholder`)
  if(!img) return
  if(!pokemon?.portrait) {
    img.classList.remove("visible"); img.style.display = "none"
    if(ph) ph.style.display = "block"
    return
  }
  if(ph) ph.style.display = "none"
  img.classList.remove("visible")
  img.style.display = "block"; img.src = pokemon.portrait; img.alt = pokemon.name
  setTimeout(() => img.classList.add("visible"), 60)
}

// ── 슬롯 UI 갱신 ─────────────────────────────────
function updateSlotUI(slot, data) {
  const prefix = slotToPrefix(slot)
  if(!prefix) return
  const activeIdx = data[`${slot}_active_idx`] ?? 0
  const pokemon   = data[`${slot}_entry`]?.[activeIdx]
  if(!pokemon) return

  const slotKey   = slot.replace("p", "player")
  const nameLabel = $(`${prefix}-name-label`)
  if(nameLabel) nameLabel.innerText = data[`${slotKey}_name`] ?? slot

  const nameEl = $(`${prefix}-active-name`)
  if(nameEl) nameEl.innerText = pokemon.name ?? "???"

  const isMyTeam = prefix === "my" || prefix === "ally"
  updateHpBar(`${prefix}-hp-bar`, `${prefix}-active-hp`, pokemon.hp, pokemon.maxHp, isMyTeam)
  updatePortrait(prefix, pokemon)
}

// ── 행동 순서 표시 ───────────────────────────────
function updateOrderDisplay(data) {
  const el = $("order-display")
  if(!el) return
  const order = data.current_order ?? []
  if(order.length === 0) { el.innerHTML = ""; return }

  el.innerHTML = order.map((slot, i) => {
    const slotKey = slot.replace("p", "player")
    const name    = (data[`${slotKey}_name`] ?? slot).split("]").pop().trim()
    const isActive = i === 0
    const isMine   = slot === mySlot
    let cls = "order-item"
    if(isActive) cls += " active"
    else if(isMine) cls += " mine"
    return `<div class="${cls}">${i+1}. ${name}</div>`
  }).join("")
}

// ── 타이핑 로그 ─────────────────────────────────
function processQueue() {
  if(isTyping || typingQueue.length === 0) return
  isTyping = true
  const { text } = typingQueue.shift()
  const log = $("battle-log")
  if(!log) { isTyping = false; processQueue(); return }
  const line = document.createElement("p")
  log.appendChild(line)
  const chars = [...text]; let i = 0
  function typeNext() {
    if(i >= chars.length) { isTyping = false; setTimeout(processQueue, 80); return }
    line.textContent += chars[i++]
    log.scrollTop = log.scrollHeight
    setTimeout(typeNext, 18)
  }
  typeNext()
}

function listenLogs(gameStartedAt) {
  const q = query(logsRef, orderBy("ts"))
  onSnapshot(q, snap => {
    snap.docs.forEach(d => {
      if(renderedLogIds.has(d.id)) return
      const logData = d.data()
      if(gameStartedAt && logData.ts < gameStartedAt) return
      renderedLogIds.add(d.id)
      typingQueue.push({ text: logData.text })
    })
    processQueue()
  })
}

// ── 주사위 애니메이션 ────────────────────────────
// 라운드 시작 주사위 (여러 슬롯)
function animateDice(rolls, slots, onDone) {
  const wrap = $("dice-wrap")
  if(!wrap) { onDone?.(); return }

  ;["p1","p2","p3","p4"].forEach(s => {
    const box = $(`dice-box-${s}`)
    if(box) box.style.display = slots.includes(s) ? "block" : "none"
  })

  wrap.style.display = "flex"
  let count = 0
  const iv = setInterval(() => {
    slots.forEach(s => {
      const el = $(`dice-${s}`)
      if(el) el.innerText = rollD10()
    })
    if(++count >= 20) {
      clearInterval(iv)
      slots.forEach(s => {
        const el = $(`dice-${s}`)
        if(el) {
          el.innerText = rolls[s]
          el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop")
        }
      })
      setTimeout(() => { wrap.style.display = "none"; onDone?.() }, 1800)
    }
  }, 60)
}

// 공격 주사위 (단일 슬롯) — 서버가 보낸 값으로 애니메이션
function animateAttackDice(slot, finalRoll) {
  return new Promise(resolve => {
    const wrap   = $("dice-wrap")
    const diceEl = $(`dice-${slot}`)
    if(!wrap || !diceEl) { resolve(); return }

    ;["p1","p2","p3","p4"].forEach(s => {
      const box = $(`dice-box-${s}`)
      if(box) box.style.display = s === slot ? "block" : "none"
    })

    wrap.style.display = "flex"
    let count = 0
    const iv = setInterval(() => {
      diceEl.innerText = rollD10()
      if(++count >= 16) {
        clearInterval(iv)
        diceEl.innerText = finalRoll
        diceEl.classList.remove("pop"); void diceEl.offsetWidth; diceEl.classList.add("pop")
        setTimeout(() => { wrap.style.display = "none"; resolve() }, 1000)
      }
    }, 60)
  })
}

// ── 히트 이펙트 ─────────────────────────────────
function triggerBlink(prefix) {
  const area = $(`${prefix}-pokemon-area`)
  if(!area) return

  const wrapper = $("battle-wrapper")
  if(wrapper) {
    wrapper.classList.remove("screen-shake"); void wrapper.offsetWidth
    wrapper.classList.add("screen-shake")
    wrapper.addEventListener("animationend", () => wrapper.classList.remove("screen-shake"), { once: true })
  }

  const targets = [
    area.querySelector(".portrait-wrap"),
    area.querySelector(".hp-card")
  ].filter(Boolean)

  targets.forEach(el => {
    el.classList.remove("blink-damage"); void el.offsetWidth
    el.classList.add("blink-damage")
    el.addEventListener("animationend", () => el.classList.remove("blink-damage"), { once: true })
  })

  const portrait = area.querySelector(".portrait-wrap")
  if(portrait) {
    portrait.classList.remove("defender-hit"); void portrait.offsetWidth
    portrait.classList.add("defender-hit")
    portrait.addEventListener("animationend", () => portrait.classList.remove("defender-hit"), { once: true })
  }
}

// ── 기술 버튼 ────────────────────────────────────
function updateMoveButtons(data) {
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPokemon   = data[`${mySlot}_entry`]?.[myActiveIdx]
  const fainted     = !myPokemon || myPokemon.hp <= 0
  const movesArr    = myPokemon?.moves ?? []

  for(let i = 0; i < 4; i++) {
    const btn = $(`move-btn-${i}`)
    if(!btn) continue
    if(i >= movesArr.length) {
      btn.innerHTML = '<span style="font-size:13px">-</span>'
      btn.disabled = true; btn.onclick = null; continue
    }
    const mv       = movesArr[i]
    const moveInfo = moves[mv.name] ?? {}
    const acc      = moveInfo.alwaysHit ? "필중" : `${moveInfo.accuracy ?? 100}%`

    btn.innerHTML = `
      <span style="display:block;font-size:13px;font-weight:bold">${mv.name}</span>
      <span style="display:block;font-size:10px;opacity:.85">PP: ${mv.pp} | ${acc}</span>
    `
    const color = TYPE_COLORS[moveInfo.type] ?? "#a0a0a0"
    btn.style.setProperty("--btn-color", color)
    btn.style.background = color
    btn.style.boxShadow  = `inset 0 0 0 2px white, 0 0 0 2px ${color}`

    const canUse = !isSpectator && !fainted && mv.pp > 0 && myTurn && !actionDone
    btn.disabled = !canUse
    btn.onclick  = canUse ? () => onMoveClick(i, moveInfo, data) : null
  }
}

// ── 기술 클릭 → 타겟 선택 or 즉시 사용 ─────────
function onMoveClick(idx, moveInfo, data) {
  if(actionDone) return
  const r = moveInfo?.rank
  const targetsEnemy = moveInfo?.power
    || (r && (r.targetAtk !== undefined || r.targetDef !== undefined || r.targetSpd !== undefined))

  if(targetsEnemy) {
    enterTargetMode(idx, data)
  } else {
    doUseMove(idx, [], data)
  }
}

function enterTargetMode(idx, data) {
  pendingMoveIdx = idx
  const hint = $("target-hint")
  if(hint) hint.style.display = "block"

  enemySlotsOf(mySlot).forEach(eSlot => {
    const eActiveIdx = data[`${eSlot}_active_idx`] ?? 0
    const ePkmn      = data[`${eSlot}_entry`]?.[eActiveIdx]
    if(!ePkmn || ePkmn.hp <= 0) return

    const prefix = slotToPrefix(eSlot)
    const area   = $(`${prefix}-pokemon-area`)
    if(!area) return
    area.classList.add("target-selectable")
    area.onclick = () => {
      const capturedIdx = pendingMoveIdx
      exitTargetMode()
      doUseMove(capturedIdx, [eSlot], data)
    }
  })
}

function exitTargetMode() {
  pendingMoveIdx = -1
  const hint = $("target-hint")
  if(hint) hint.style.display = "none"
  ;["enemy1","enemy2"].forEach(prefix => {
    const area = $(`${prefix}-pokemon-area`)
    if(!area) return
    area.classList.remove("target-selectable")
    area.onclick = null
  })
}

async function doUseMove(moveIdx, targetSlots, data) {
  if(actionDone) return
  actionDone = true
  updateMoveButtons(data)

  // 공격 기술 여부 확인
  const mv       = data[`${mySlot}_entry`]?.[data[`${mySlot}_active_idx`] ?? 0]?.moves?.[moveIdx]
  const moveInfo = mv ? (window.__moves?.[mv.name] ?? {}) : {}
  const isAttack = !!moveInfo.power

  // 클라이언트에서 주사위를 굴려 서버로 전송 → 서버가 검증 후 사용
  // 실제 결과는 서버의 attack_dice_event를 onSnapshot에서 받아 애니메이션
  const diceRoll = isAttack && targetSlots.length > 0 ? rollD10() : null

  try {
    await _useMove({ roomId: ROOM_ID, mySlot, moveIdx, targetSlots, diceRoll })
  } catch(e) {
    console.error("useMove 오류:", e.message)
    actionDone = false
    updateMoveButtons(data)
  }
}

// ── 교체 버튼 ────────────────────────────────────
function updateBenchButtons(data) {
  const bench = $("bench-container")
  if(!bench) return
  bench.innerHTML = ""

  const myEntry   = data[`${mySlot}_entry`] ?? []
  const activeIdx = data[`${mySlot}_active_idx`] ?? 0
  const pending   = data.pending_switches ?? []
  const isForcedSwitch = pending.includes(mySlot)

  const forcedHint = $("forced-switch-hint")
  if(forcedHint) forcedHint.style.display = isForcedSwitch && !isSpectator ? "block" : "none"

  myEntry.forEach((pkmn, idx) => {
    if(idx === activeIdx) return
    const btn = document.createElement("button")
    if(pkmn.hp <= 0) {
      btn.innerHTML = `<span class="bench-name">${pkmn.name}</span><span class="bench-hp">기절</span>`
      btn.disabled  = true
    } else {
      btn.innerHTML = `<span class="bench-name">${pkmn.name}</span><span class="bench-hp">HP: ${pkmn.hp}/${pkmn.maxHp}</span>`
      if(isSpectator) {
        btn.disabled = true
      } else if(isForcedSwitch) {
        btn.disabled = false
        btn.classList.add("forced-switch")
        btn.onclick  = () => doForcedSwitch(idx)
      } else {
        btn.disabled = !myTurn || actionDone
        if(!btn.disabled) btn.onclick = () => doSwitchPokemon(idx, data)
      }
    }
    bench.appendChild(btn)
  })
}

async function doSwitchPokemon(newIdx, data) {
  if(actionDone) return
  actionDone = true
  const bench = $("bench-container")
  if(bench) bench.querySelectorAll("button").forEach(b => { b.disabled = true; b.onclick = null })
  try {
    await _switchPkmn({ roomId: ROOM_ID, mySlot, newIdx })
  } catch(e) {
    console.error("switchPokemon 오류:", e.message)
    actionDone = false
    updateBenchButtons(data)
  }
}

async function doForcedSwitch(newIdx) {
  try {
    await _forcedSwitch({ roomId: ROOM_ID, mySlot, newIdx })
  } catch(e) {
    console.error("forcedSwitch 오류:", e.message)
  }
}

// ── 턴 표시 ──────────────────────────────────────
function updateTurnUI(data) {
  const el = $("turn-display")
  if(!el) return

  const order   = data.current_order ?? []
  const pending = data.pending_switches ?? []

  if(isSpectator) {
    if(order.length > 0) {
      const s       = order[0]
      const slotKey = s.replace("p", "player")
      const name    = (data[`${slotKey}_name`] ?? s).split("]").pop().trim()
      el.innerText  = `${name}의 턴`
      el.style.color = "#333"
    } else {
      el.innerText  = "라운드 대기 중..."
      el.style.color = "#aaa"
    }
    return
  }

  if(pending.includes(mySlot)) {
    el.innerText  = "교체할 포켓몬을 선택!"
    el.style.color = "#e67e22"
  } else if(order.length === 0) {
    el.innerText  = "라운드 대기 중..."
    el.style.color = "#aaa"
  } else if(order[0] === mySlot) {
    el.innerText  = "내 턴!"
    el.style.color = "green"
  } else {
    const idx = order.indexOf(mySlot)
    el.innerText  = idx > 0 ? `${idx}번째 대기중...` : "상대 턴..."
    el.style.color = "gray"
  }

  const tc = $("turn-count")
  if(tc) tc.innerText = `${data.round_count ?? 0}라운드 / ${data.turn_count ?? 0}턴`
}

// ── 게임 종료 ────────────────────────────────────
function showGameOver(data) {
  if(gameOver) return
  gameOver = true
  exitTargetMode()

  const myTeam = teamOf(mySlot)
  const win    = data.winner_team === myTeam
  const td     = $("turn-display")

  if(isSpectator) {
    if(td) { td.innerText = `🏆 팀 ${data.winner_team} 승리!`; td.style.color = "gold" }
  } else {
    if(td) { td.innerText = win ? "🏆 승리!" : "💀 패배..."; td.style.color = win ? "gold" : "red" }
  }

  for(let i = 0; i < 4; i++) { const b = $(`move-btn-${i}`); if(b) { b.disabled = true; b.onclick = null } }
  const bench = $("bench-container"); if(bench) bench.innerHTML = ""

  const lb = $("leaveBtn")
  if(lb) { lb.style.display = "inline-block"; lb.disabled = false; lb.onclick = leaveGame }
}

// ── 턴 스킵 ─────────────────────────────────────
async function doSkipTurn() {
  try {
    await _skipTurn({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    console.warn("skipTurn 오류:", e.message)
    actionDone = false
  }
}

// ── ASSIST! 애니메이션 ───────────────────────────
function showAssistAnimation() {
  return new Promise(resolve => {
    const el = $("assist-anim")
    if(!el) { resolve(); return }
    el.classList.remove("assist-show")
    void el.offsetWidth
    el.classList.add("assist-show")
    setTimeout(resolve, 800)
  })
}

// ── SYNCHRONIZE! 애니메이션 ──────────────────────
function showSyncAnimation() {
  return new Promise(resolve => {
    const el = $("sync-anim")
    if(!el) { resolve(); return }
    el.classList.remove("sync-show")
    void el.offsetWidth
    el.classList.add("sync-show")
    setTimeout(resolve, 800)
  })
}

// ── 어시스트 UI ──────────────────────────────────
function updateAssistUI(data) {
  const myTeam   = teamOf(mySlot)
  // 서버 Functions는 assist_request 단일 필드 사용
  const assist   = data[`assist_team${myTeam}`] ?? null
  const used     = data[`assist_used_${myTeam}`] ?? false
  const req      = data.assist_request ?? null
  const teamDead = isTeamAllDead(data)

  const reqBtn = $("assist-request-btn")
  if(reqBtn) {
    const isMyReq = req && req.from === mySlot
    if(isSpectator || used || assist || teamDead) {
      reqBtn.disabled  = true
      reqBtn.innerText = teamDead ? "사용 불가" : assist ? "🤝 어시스트 중" : used ? "지원 완료" : "지원 요청"
    } else if(isMyReq) {
      reqBtn.disabled  = true
      reqBtn.innerText = "요청 중..."
    } else {
      reqBtn.disabled  = false
      reqBtn.innerText = "지원 요청"
    }
  }

  const statusEl = $("assist-status")
  if(statusEl) {
    if(assist?.requester === mySlot) {
      statusEl.innerText = `🤝 어시스트 대기 중 (${assist.supporterName})`
      statusEl.style.color = "#e67e22"
    } else if(assist?.supporter === mySlot) {
      statusEl.innerText = `🤝 어시스트 지원 중 (${assist.requesterName})`
      statusEl.style.color = "#3498db"
    } else {
      statusEl.innerText = ""
    }
  }

  // 수락/거절 팝업 (내가 to인 요청)
  const popup = $("assist-popup")
  if(popup) {
    if(req && req.to === mySlot && !isSpectator) {
      popup.style.display = "block"
      const nameEl = $("assist-popup-name")
      if(nameEl) nameEl.innerText = req.fromName ?? req.from
    } else {
      popup.style.display = "none"
    }
  }
}

// ── 어시스트 액션 (모두 Functions 호출) ─────────
async function doRequestAssist() {
  if(!myTurn) { alert("자신의 턴에만 지원 요청할 수 있어!"); return }
  try {
    await _requestAssist({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    alert(`어시스트 요청 실패: ${e.message}`)
  }
}

async function doAcceptAssist() {
  try {
    await _acceptAssist({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    alert(`수락 실패: ${e.message}`)
  }
}

async function doRejectAssist() {
  try {
    await _rejectAssist({ roomId: ROOM_ID })
  } catch(e) {
    console.warn("거절 실패:", e.message)
  }
}

// ── 싱크로나이즈 UI ──────────────────────────────
function updateSyncUI(data) {
  const myTeam   = teamOf(mySlot)
  const sync     = data[`sync_team${myTeam}`] ?? null
  const used     = data[`sync_used_${myTeam}`] ?? false
  // 서버에서 sync_request 단일 필드로 관리
  const req      = data.sync_request ?? null
  const teamDead = isTeamAllDead(data)

  const reqBtn = $("sync-request-btn")
  if(reqBtn) {
    const isMyReq = req && req.from === mySlot
    if(isSpectator || used || sync || teamDead) {
      reqBtn.disabled  = true
      reqBtn.innerText = teamDead ? "사용 불가" : sync ? "💠 싱크로나이즈 중" : used ? "동기화 완료" : "동기화 요청"
    } else if(isMyReq) {
      reqBtn.disabled  = true
      reqBtn.innerText = "요청 중..."
    } else {
      reqBtn.disabled  = false
      reqBtn.innerText = "동기화 요청"
    }
  }

  const statusEl = $("sync-status")
  if(statusEl) {
    if(sync?.requester === mySlot || sync?.supporter === mySlot) {
      const partner = sync.requester === mySlot ? sync.supporterName : sync.requesterName
      statusEl.innerText = `💠 싱크로나이즈 (${partner})`
      statusEl.style.color = "#9b59b6"
    } else {
      statusEl.innerText = ""
    }
  }

  const popup = $("sync-popup")
  if(popup) {
    if(req && req.to === mySlot && !isSpectator) {
      popup.style.display = "block"
      const nameEl = $("sync-popup-name")
      if(nameEl) nameEl.innerText = req.fromName ?? req.from
    } else {
      popup.style.display = "none"
    }
  }

  // 팀별 비공개 싱크 로그 처리
  const syncLogKey = `sync_log_${myTeam}`
  const syncLog    = data[syncLogKey]
  if(syncLog && !renderedSyncLogs.has(syncLog)) {
    renderedSyncLogs.add(syncLog)
    typingQueue.push({ text: syncLog })
    processQueue()
    // 읽은 후 서버에서 지움 (rejectSync 재사용 or 별도 Function으로 처리)
    // 간단하게: clearSyncLog Function 대신 acceptSync가 이미 처리하므로
    // 여기선 렌더링만 하고 서버 지우기는 acceptSync 내부에서 처리
  }
}

// ── 싱크 액션 (모두 Functions 호출) ─────────────
async function doRequestSync() {
  if(!myTurn) { alert("자신의 턴에만 동기화 요청할 수 있어!"); return }
  try {
    await _requestSync({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    alert(`동기화 요청 실패: ${e.message}`)
  }
}

async function doAcceptSync() {
  try {
    await _acceptSync({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    alert(`수락 실패: ${e.message}`)
  }
}

async function doRejectSync() {
  try {
    await _rejectSync({ roomId: ROOM_ID })
  } catch(e) {
    console.warn("거절 실패:", e.message)
  }
}

// ── 방 나가기 (Functions 호출) ───────────────────
async function leaveGame() {
  try {
    await _leaveGame({ roomId: ROOM_ID, myUid })
  } catch(e) {
    console.error("leaveGame 오류:", e)
  }
  location.href = "../main.html"
}

// ── startRound (중복 방지) ───────────────────────
let startRoundLock = false
async function tryStartRound() {
  if(startRoundLock) return
  startRoundLock = true
  try {
    await _startRound({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    console.warn("startRound:", e.message)
  } finally {
    setTimeout(() => startRoundLock = false, 3000)
  }
}

// ── 메인 리스너 ─────────────────────────────────
function listenRoom() {
  onSnapshot(roomRef, async snap => {
    const data = snap.data()
    if(!data) return

    // 관전자 표시
    const spectEl = $("spectator-list")
    if(spectEl) {
      const names = data.spectator_names ?? []
      spectEl.innerText = names.length > 0 ? "관전: " + names.join(", ") : ""
    }

    if(!data.p1_entry) {
      if(!isSpectator) { updateAssistUI(data); updateSyncUI(data) }
      return
    }

    // 각 슬롯 UI 갱신
    ;["p1","p2","p3","p4"].forEach(s => updateSlotUI(s, data))

    // ── 어시스트 애니메이션 ──
    if(data.assist_event && data.assist_event.ts > lastAssistEventTs) {
      lastAssistEventTs = data.assist_event.ts
      if(!isHandlingSnapshot) {
        isHandlingSnapshot = true
        await showAssistAnimation()
        isHandlingSnapshot = false
      }
    }

    // ── 싱크로나이즈 애니메이션 ──
    if(data.sync_event && data.sync_event.ts > lastSyncEventTs) {
      lastSyncEventTs = data.sync_event.ts
      if(!isHandlingSnapshot) {
        isHandlingSnapshot = true
        await showSyncAnimation()
        isHandlingSnapshot = false
      }
    }

    // ── 히트 이벤트 ──
    if(data.hit_event && data.hit_event.ts > lastHitEventTs) {
      lastHitEventTs = data.hit_event.ts
      const prefix = slotToPrefix(data.hit_event.defender)
      if(prefix) triggerBlink(prefix)
    }

    // ── 공격 주사위 이벤트 (서버가 attack_dice_event 저장) ──
    // 모든 클라이언트가 동일하게 onSnapshot으로 받아 애니메이션 실행
    if(data.attack_dice_event && data.attack_dice_event.ts > lastAttackDiceTs) {
      lastAttackDiceTs = data.attack_dice_event.ts
      await animateAttackDice(data.attack_dice_event.slot, data.attack_dice_event.roll)
    }

    // ── 라운드 시작 주사위 ──
    if(data.dice_event && data.dice_event.ts > lastDiceEventTs) {
      lastDiceEventTs = data.dice_event.ts
      animateDice(data.dice_event.rolls, data.dice_event.slots)
    }

    // 게임 종료
    if(data.game_over) { showGameOver(data); return }

    updateOrderDisplay(data)

    if(!isSpectator) {
      const order   = data.current_order ?? []
      const pending = data.pending_switches ?? []

      const wasMyTurn    = myTurn
      const isMyTurnNow  = order[0] === mySlot
      myTurn = isMyTurnNow

      if(!wasMyTurn && isMyTurnNow) actionDone = false
      if(pending.includes(mySlot))  actionDone = false

      // 엔트리 전멸 시 자동 스킵
      if(myTurn && !actionDone) {
        const myEntry = data[`${mySlot}_entry`] ?? []
        const allDead = myEntry.every(p => p.hp <= 0)
        if(allDead) {
          actionDone = true
          await doSkipTurn()
          return
        }
      }

      // 라운드 시작 조건
      if(order.length === 0 && pending.length === 0 && data.game_started && !data.game_over) {
        await tryStartRound()
      }
    }

    updateTurnUI(data)
    updateMoveButtons(data)
    updateBenchButtons(data)
    if(!isSpectator) updateAssistUI(data)
    if(!isSpectator) updateSyncUI(data)
  })
}

// ── 인증 후 시작 ─────────────────────────────────
onAuthStateChanged(auth, async user => {
  if(!user) return
  myUid = user.uid

  const roomSnap = await getDoc(roomRef)
  const data     = roomSnap.data()
  ;["p1","p2","p3","p4"].forEach(s => {
    const slotKey = s.replace("p", "player")
    if(data?.[`${slotKey}_uid`] === myUid) mySlot = s
  })

  if(isSpectator) {
    const td = $("turn-display")
    if(td) { td.innerText = "관전 중"; td.style.color = "gray" }
  }

  if(window.initDoubleChat) {
    const userSnap = await getDoc(doc(db, "users", myUid))
    window.__myDisplayName = userSnap.data()?.nickname ?? myUid.slice(0, 6)
    window.initDoubleChat({ db, ROOM_ID, myUid, mySlot, isSpectator })
  }

  listenLogs(data?.game_started_at ?? 0)
  listenRoom()
})

// HTML onclick에서 접근
window.__doRequestAssist = doRequestAssist
window.__doAcceptAssist  = doAcceptAssist
window.__doRejectAssist  = doRejectAssist
window.__doRequestSync   = doRequestSync
window.__doAcceptSync    = doAcceptSync
window.__doRejectSync    = doRejectSync
