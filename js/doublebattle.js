// js/doublebattle.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, collection, getDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js"
import { moves } from "./moves.js"
import { josa } from "./effecthandler.js"

// ── Firebase Functions 연결 ──────────────────────
const functions      = getFunctions()
const _startRound    = httpsCallable(functions, "startRound")
const _useMove       = httpsCallable(functions, "useMove")
const _switchPkmn    = httpsCallable(functions, "switchPokemon")
const _forcedSwitch  = httpsCallable(functions, "forcedSwitch")
const _skipTurn      = httpsCallable(functions, "skipTurn")

const roomRef = doc(db, "double", ROOM_ID)
const logsRef = collection(db, "double", ROOM_ID, "logs")

// ── 상태 변수 ────────────────────────────────────
let mySlot = null, myUid = null
let myTurn = false, actionDone = false, gameOver = false
let lastDiceEventTs = 0, lastHitEventTs = 0
let renderedLogIds  = new Set()
let typingQueue = [], isTyping = false
let pendingMoveIdx  = -1

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
function rollD10() { return Math.floor(Math.random()*10)+1 }

function teamOf(s)       { return ["p1","p2"].includes(s) ? "A" : "B" }
function allyOf(s)       { return s==="p1"?"p2":s==="p2"?"p1":s==="p3"?"p4":"p3" }
function enemySlotsOf(s) { return teamOf(s)==="A" ? ["p3","p4"] : ["p1","p2"] }

// slotToPrefix: 내 시점 기준 prefix 반환
// my / ally / enemy1 / enemy2
function slotToPrefix(slot) {
  if(!mySlot) return null
  if(slot === mySlot)        return "my"
  if(slot === allyOf(mySlot)) return "ally"
  const enemies = enemySlotsOf(mySlot)
  return slot === enemies[0] ? "enemy1" : "enemy2"
}

// ── HP 바 ─────────────────────────────────────────
function updateHpBar(barId, textId, hp, maxHp, showNum) {
  const bar = $(barId), txt = textId ? $(textId) : null
  if(!bar) return
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, hp/maxHp*100)) : 0
  bar.style.width = pct + "%"
  bar.style.backgroundColor = pct>50 ? "#4caf50" : pct>20 ? "#ff9800" : "#f44336"
  if(txt) txt.innerText = showNum ? `HP: ${hp} / ${maxHp}` : ""
}

// ── 포트레이트 ────────────────────────────────────
function updatePortrait(prefix, pokemon) {
  const img = $(`${prefix}-portrait`)
  const ph  = $(`${prefix}-portrait-placeholder`)
  if(!img) return
  if(!pokemon?.portrait) {
    img.classList.remove("visible"); img.style.display="none"
    if(ph) ph.style.display="block"; return
  }
  if(ph) ph.style.display="none"
  img.classList.remove("visible")
  img.style.display="block"; img.src=pokemon.portrait; img.alt=pokemon.name
  setTimeout(() => img.classList.add("visible"), 60)
}

// ── 슬롯 UI 갱신 ─────────────────────────────────
function updateSlotUI(slot, data) {
  const prefix    = slotToPrefix(slot)
  if(!prefix) return
  const activeIdx = data[`${slot}_active_idx`] ?? 0
  const pokemon   = data[`${slot}_entry`]?.[activeIdx]
  if(!pokemon) return

  // 플레이어 이름 라벨
  const slotKey = slot.replace("p","player")
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
    const slotKey  = slot.replace("p","player")
    const name     = (data[`${slotKey}_name`] ?? slot).split("]").pop().trim()
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
  if(!log) { isTyping=false; processQueue(); return }
  const line = document.createElement("p"); log.appendChild(line)
  const chars=[...text]; let i=0
  function typeNext() {
    if(i>=chars.length) { isTyping=false; setTimeout(processQueue,80); return }
    line.textContent+=chars[i++]; log.scrollTop=log.scrollHeight; setTimeout(typeNext,18)
  }
  typeNext()
}

function listenLogs() {
  const q = query(logsRef, orderBy("ts"))
  onSnapshot(q, snap => {
    snap.docs.forEach(d => {
      if(renderedLogIds.has(d.id)) return
      renderedLogIds.add(d.id)
      typingQueue.push({ text: d.data().text })
    })
    processQueue()
  })
}

// ── 주사위 애니메이션 ────────────────────────────
function animateDice(rolls, slots, onDone) {
  const wrap = $("dice-wrap")
  if(!wrap) { onDone?.(); return }

  ;["p1","p2","p3","p4"].forEach(s => {
    const box = $(`dice-box-${s}`)
    if(box) box.style.display = slots.includes(s) ? "block" : "none"
  })

  // 주사위 박스 슬롯별 이름 업데이트
  slots.forEach(s => {
    const labelEl = $(`${s}-name-label`)
    // center-col 안의 label은 id가 p1-name-label 등
    const diceLabel = document.querySelector(`#dice-box-${s} span`)
    if(diceLabel) {
      // roomRef 데이터에서 이름 가져오기 어려우니 그냥 slot명 표시
      // 나중에 필요하면 data를 인자로 넘겨서 이름 표시 가능
    }
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
      setTimeout(() => { wrap.style.display="none"; onDone?.() }, 1800)
    }
  }, 60)
}

// ── 히트 이펙트 ─────────────────────────────────
// portrait-wrap + hp-card 만 깜빡임 (기술버튼/채팅창 제외)
function triggerBlink(prefix) {
  const area = $(`${prefix}-pokemon-area`)
  if(!area) return

  // 화면 흔들림 (battle-wrapper 전체)
  const wrapper = $("battle-wrapper")
  if(wrapper) {
    wrapper.classList.remove("screen-shake"); void wrapper.offsetWidth
    wrapper.classList.add("screen-shake")
    wrapper.addEventListener("animationend", () => wrapper.classList.remove("screen-shake"), {once:true})
  }

  // portrait-wrap, hp-card 만 깜빡임
  const targets = [
    area.querySelector(".portrait-wrap"),
    area.querySelector(".hp-card")
  ].filter(Boolean)

  targets.forEach(el => {
    el.classList.remove("blink-damage"); void el.offsetWidth
    el.classList.add("blink-damage")
    el.addEventListener("animationend", () => el.classList.remove("blink-damage"), {once:true})
  })
}

// ── 기술 버튼 ────────────────────────────────────
function updateMoveButtons(data) {
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPokemon   = data[`${mySlot}_entry`]?.[myActiveIdx]
  const fainted     = !myPokemon || myPokemon.hp <= 0
  const movesArr    = myPokemon?.moves ?? []

  for(let i=0; i<4; i++) {
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
    || (r && (r.targetAtk!==undefined || r.targetDef!==undefined || r.targetSpd!==undefined))

  if(targetsEnemy) {
    enterTargetMode(idx, data)
  } else {
    // 자신 대상 기술 → 즉시 사용
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
    if(!ePkmn || ePkmn.hp <= 0) return  // 기절한 상대 클릭 불가

    const prefix = slotToPrefix(eSlot)
    const area   = $(`${prefix}-pokemon-area`)
    if(!area) return
    area.classList.add("target-selectable")
    area.onclick = () => {
      const idx = pendingMoveIdx
      exitTargetMode()
      doUseMove(idx, [eSlot], data)
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
  try {
    await _useMove({ roomId: ROOM_ID, mySlot, moveIdx, targetSlots })
  } catch(e) {
    console.error("useMove 오류:", e.message)
    actionDone = false
    updateMoveButtons(data)
  }
}

// ── 교체 버튼 ────────────────────────────────────
function updateBenchButtons(data) {
  const bench     = $("bench-container")
  if(!bench) return
  bench.innerHTML = ""

  const myEntry   = data[`${mySlot}_entry`] ?? []
  const activeIdx = data[`${mySlot}_active_idx`] ?? 0
  const pending   = data.pending_switches ?? []
  const isForcedSwitch = pending.includes(mySlot)

  // 강제교체 안내
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
      const s = order[0]
      const slotKey = s.replace("p","player")
      const name = (data[`${slotKey}_name`] ?? s).split("]").pop().trim()
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
    if(td) { td.innerText=`🏆 팀 ${data.winner_team} 승리!`; td.style.color="gold" }
  } else {
    if(td) { td.innerText=win?"🏆 승리!":"💀 패배..."; td.style.color=win?"gold":"red" }
  }

  for(let i=0;i<4;i++) { const b=$(`move-btn-${i}`); if(b){b.disabled=true;b.onclick=null} }
  const bench=$("bench-container"); if(bench) bench.innerHTML=""

  const lb = $("leaveBtn")
  if(lb) { lb.style.display="inline-block"; lb.disabled=false; lb.onclick=leaveGame }
}

// ── 턴 스킵 (엔트리 전멸 시) ────────────────────
async function doSkipTurn() {
  try {
    await _skipTurn({ roomId: ROOM_ID, mySlot })
  } catch(e) {
    console.warn("skipTurn 오류:", e.message)
    actionDone = false
  }
}

// ── ASSIST! 애니메이션 ───────────────────────────
let lastAssistEventTs = 0

function showAssistAnimation() {
  const el = $("assist-anim")
  if(!el) return
  el.classList.remove("assist-show")
  void el.offsetWidth
  el.classList.add("assist-show")
}
function updateAssistUI(data) {
  const myTeam    = teamOf(mySlot)
  const assistKey = `assist_team${myTeam}`
  const usedKey   = `assist_used_${myTeam}`
  const reqKey    = `assist_request_${myTeam}`  // 팀별 분리
  const assist    = data[assistKey] ?? null
  const used      = data[usedKey] ?? false
  const req       = data[reqKey] ?? null

  // 요청 버튼
  const reqBtn = $("assist-request-btn")
  if(reqBtn) {
    if(isSpectator || used || assist || req) {
      reqBtn.disabled = true
      reqBtn.innerText = assist
        ? `🤝 어시스트 중`
        : used ? "지원 완료" : req ? "요청 중..." : "지원 요청"
    } else {
      reqBtn.disabled = false
      reqBtn.innerText = "지원 요청"
    }
  }

  // 어시스트 상태 표시
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

  // 수락/거절 팝업 (내가 to인 요청이 있을 때)
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

async function doRequestAssist() {
  // 자기 턴에만 요청 가능
  if(!myTurn) { alert("자신의 턴에만 지원 요청할 수 있어!"); return }
  try {
    const { updateDoc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js")
    const snap   = await getDoc(roomRef)
    const data   = snap.data()
    const myTeam = teamOf(mySlot)
    const reqKey = `assist_request_${myTeam}`
    if(data[`assist_used_${myTeam}`])  { alert("이미 어시스트를 사용했어!"); return }
    if(data[`assist_team${myTeam}`])   { alert("이미 어시스트가 활성화됨"); return }
    if(data[reqKey])                   { alert("이미 요청 중"); return }
    const myName = data[`${mySlot.replace("p","player")}_name`] ?? mySlot
    const ally   = allyOf(mySlot)
    await updateDoc(roomRef, {
      [reqKey]: { from: mySlot, fromName: myName, to: ally, ts: Date.now() }
    })
  } catch(e) { alert(`어시스트 요청 실패: ${e.message}`) }
}

async function doAcceptAssist() {
  try {
    const { updateDoc, addDoc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js")
    const snap   = await getDoc(roomRef)
    const data   = snap.data()
    const myTeam = teamOf(mySlot)
    const reqKey = `assist_request_${myTeam}`
    const req    = data[reqKey]
    if(!req || req.to !== mySlot) return
    const myName = data[`${mySlot.replace("p","player")}_name`] ?? mySlot
    await updateDoc(roomRef, {
      [`assist_team${myTeam}`]:  { requester: req.from, requesterName: req.fromName, supporter: mySlot, supporterName: myName },
      [`assist_used_${myTeam}`]: true,
      [reqKey]:                  null
    })
    await addDoc(logsRef, {
      text: `🤝 ${req.fromName}${josa(req.fromName,"과와")} ${myName}${josa(myName,"이가")} 어시스트를 맺었다!`,
      ts: Date.now()
    })
  } catch(e) { alert(`수락 실패: ${e.message}`) }
}

async function doRejectAssist() {
  try {
    const { updateDoc } = await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js")
    const myTeam = teamOf(mySlot)
    await updateDoc(roomRef, { [`assist_request_${myTeam}`]: null })
  } catch(e) { console.warn("거절 실패:", e.message) }
}

// ── 방 나가기 + Firestore 초기화 ─────────────────
async function leaveGame() {
  try {
    // 로그 컬렉션 전체 삭제
    const { getDocs, deleteDoc, collection: col, updateDoc: upd } =
      await import("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js")
    const logSnap = await getDocs(col(db, "double", ROOM_ID, "logs"))
    await Promise.all(logSnap.docs.map(d => deleteDoc(d.ref)))

    // 방 문서 초기화
    await upd(roomRef, {
      player1_uid: null, player1_name: null, player1_ready: false,
      player2_uid: null, player2_name: null, player2_ready: false,
      player3_uid: null, player3_name: null, player3_ready: false,
      player4_uid: null, player4_name: null, player4_ready: false,
      spectators: [], spectator_names: [],
      game_started: false, game_over: false,
      winner_team: null,
      round_count: 0, turn_count: 0,
      current_order: [], pending_switches: [],
      p1_entry: null, p1_active_idx: 0,
      p2_entry: null, p2_active_idx: 0,
      p3_entry: null, p3_active_idx: 0,
      p4_entry: null, p4_active_idx: 0,
      hit_event: null, dice_event: null,
      assist_request_A: null, assist_request_B: null,
      assist_teamA: null, assist_teamB: null,
      assist_used_A: false, assist_used_B: false,
      assist_event: null
    })
  } catch(e) {
    console.error("방 초기화 실패:", e)
  }
  location.href = "../main.html"
}

// ── startRound (중복 방지) ───────────────────────
let startRoundLock = false
async function tryStartRound() {
  if(startRoundLock) return
  startRoundLock = true
  try {
    const res = await _startRound({ roomId: ROOM_ID, mySlot })
    // ok:false면 이미 다른 클라이언트가 시작함 → 무시
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

    if(!data.p1_entry) return  // 엔트리 아직 없음

    // 각 슬롯 UI 갱신
    ;["p1","p2","p3","p4"].forEach(s => updateSlotUI(s, data))

    // 히트 이벤트
    if(data.hit_event && data.hit_event.ts > lastHitEventTs) {
      lastHitEventTs = data.hit_event.ts
      const prefix = slotToPrefix(data.hit_event.defender)
      if(prefix) triggerBlink(prefix)
    }

    // 주사위 이벤트
    if(data.dice_event && data.dice_event.ts > lastDiceEventTs) {
      lastDiceEventTs = data.dice_event.ts
      animateDice(data.dice_event.rolls, data.dice_event.slots)
    }

    // 어시스트 애니메이션 이벤트
    if(data.assist_event && data.assist_event.ts > lastAssistEventTs) {
      lastAssistEventTs = data.assist_event.ts
      showAssistAnimation()
    }

    // 게임 종료
    if(data.game_over) { showGameOver(data); return }

    // 행동 순서 표시
    updateOrderDisplay(data)

    // 내 턴/상태 갱신
    if(!isSpectator) {
      const order   = data.current_order ?? []
      const pending = data.pending_switches ?? []

      const wasMyTurn = myTurn
      myTurn = order[0] === mySlot

      if(!wasMyTurn && myTurn) actionDone = false
      if(pending.includes(mySlot)) actionDone = false

      // 내 턴인데 엔트리가 전멸한 경우 → 자동 턴 스킵
      // (서버 startRound에서 살아있는 슬롯만 order에 넣지만,
      //  라운드 도중 전멸하면 order에 남아있을 수 있음)
      if(myTurn && !actionDone) {
        const myEntry = data[`${mySlot}_entry`] ?? []
        const allDead = myEntry.every(p => p.hp <= 0)
        if(allDead) {
          actionDone = true
          await doSkipTurn()
          return
        }
      }

      // 라운드 시작 조건: order 비었고, pending 없고, 게임 진행중
      if(order.length === 0 && pending.length === 0 && data.game_started && !data.game_over) {
        await tryStartRound()
      }
    }

    updateTurnUI(data)
    updateMoveButtons(data)
    updateBenchButtons(data)
    if(!isSpectator) updateAssistUI(data)
  })
}

// ── 인증 후 시작 ─────────────────────────────────
onAuthStateChanged(auth, async user => {
  if(!user) return
  myUid = user.uid

  // 내 슬롯 찾기
  const roomSnap = await getDoc(roomRef)
  const data     = roomSnap.data()
  ;["p1","p2","p3","p4"].forEach(s => {
    const slotKey = s.replace("p","player")
    if(data?.[`${slotKey}_uid`] === myUid) mySlot = s
  })

  if(isSpectator) {
    const td = $("turn-display")
    if(td) { td.innerText="관전 중"; td.style.color="gray" }
  }

  // 채팅 초기화
  if(window.initDoubleChat) {
    const userSnap = await getDoc(doc(db, "users", myUid))
    window.__myDisplayName = userSnap.data()?.nickname ?? myUid.slice(0,6)
    window.initDoubleChat({ db, ROOM_ID, myUid, mySlot, isSpectator })
  }

  listenLogs()
  listenRoom()
})

// HTML onclick에서 접근할 수 있도록 window에 등록
window.__doRequestAssist = doRequestAssist
window.__doAcceptAssist  = doAcceptAssist
window.__doRejectAssist  = doRejectAssist
