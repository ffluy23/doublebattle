// battle.js (더블배틀 - 서버 연동 버전)

import { auth, db, app } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, collection, getDoc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, increment, updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js"
import { moves } from "./moves.js"
import { statusName, josa as josaEH } from "./effecthandler.js"


const ROOM_ID = window.ROOM_ID
const roomRef = doc(db, "double", ROOM_ID)
const logsRef = collection(db, "double", ROOM_ID, "logs")
const functions = getFunctions(app, "us-central1")
const fnStartRound    = httpsCallable(functions, "startRound")
const fnUseMove       = httpsCallable(functions, "useMove")
const fnSwitchPokemon = httpsCallable(functions, "switchPokemon")
const fnForcedSwitch  = httpsCallable(functions, "forcedSwitch")

const SFX_DICE = "https://slippery-copper-mzpmcmc2ra.edgeone.app/soundreality-bicycle-bell-155622.mp3"
const SFX_BTN  = "https://usual-salmon-mnqxptwyvw.edgeone.app/Pokemon%20(A%20Button)%20-%20Sound%20Effect%20(HD)%20(1)%20(1).mp3"

const TEAM_A = ["p1","p2"]
const TEAM_B = ["p3","p4"]
const ALL_FS = ["p1","p2","p3","p4"]

function teamOf(s)     { return TEAM_A.includes(s) ? "A" : "B" }
function allySlot(s)   { return s==="p1"?"p2": s==="p2"?"p1": s==="p3"?"p4": "p3" }
function enemySlots(s) { return teamOf(s)==="A" ? TEAM_B : TEAM_A }
function roomName(s)   { return s.replace("p","player") }

function playSound(url) { const a=new Audio(url); a.volume=0.6; a.play().catch(()=>{}) }
function wait(ms)       { return new Promise(r=>setTimeout(r,ms)) }
function josa(w,t)      { return josaEH(w,t) }
function rollD10()      { return Math.floor(Math.random()*10)+1 }

let mySlot    = null
let myUid     = null
let myTurn    = false
let actionDone = false
let gameOver  = false
let lastHitTs = 0
let lastDiceTs = 0
let forcedSwitchOpen = false
let isFirstSnapshot  = true

const isSpectator = new URLSearchParams(location.search).get("spectator") === "true"

// ── HP 바 & 초상화 ───────────────────────────────
function updateHpBar(barId, textId, hp, maxHp, showNum) {
  const bar=document.getElementById(barId), txt=textId?document.getElementById(textId):null
  if(!bar) return
  const pct = maxHp>0 ? Math.max(0,Math.min(100,(hp/maxHp)*100)) : 0
  bar.style.width = pct+"%"
  bar.style.backgroundColor = pct>50?"#4caf50":pct>20?"#ff9800":"#f44336"
  if(txt) txt.innerText = showNum ? `HP: ${hp} / ${maxHp}` : ""
}
function updatePortrait(prefix, pkmn) {
  const img=document.getElementById(`${prefix}-portrait`); if(!img) return
  if(!pkmn?.portrait){ img.classList.remove("visible"); img.style.display="none"; return }
  img.style.display="block"; img.src=pkmn.portrait; img.alt=pkmn.name
  setTimeout(()=>img.classList.add("visible"),80)
}

// ── 전투 이펙트 ──────────────────────────────────
function triggerAttackEffect(atkPfx, defPfx) {
  return new Promise(resolve=>{
    const atkArea=document.getElementById(`${atkPfx}-pokemon-area`)
    const defArea=document.getElementById(`${defPfx}-pokemon-area`)
    const wrapper=document.body
    if(atkArea){ atkArea.classList.add("attacker-flash"); atkArea.addEventListener("animationend",()=>atkArea.classList.remove("attacker-flash"),{once:true}) }
    if(wrapper){ wrapper.classList.add("screen-shake"); wrapper.addEventListener("animationend",()=>wrapper.classList.remove("screen-shake"),{once:true}) }
    setTimeout(()=>{
      if(defArea){ defArea.classList.add("defender-hit"); defArea.addEventListener("animationend",()=>{ defArea.classList.remove("defender-hit"); resolve() },{once:true}) }
      else resolve()
    },120)
  })
}
function triggerBlink(prefix) {
  return new Promise(resolve=>{
    const area=document.getElementById(`${prefix}-pokemon-area`)
    if(!area){ resolve(); return }
    area.classList.add("blink-damage")
    area.addEventListener("animationend",()=>{ area.classList.remove("blink-damage"); resolve() },{once:true})
  })
}
function showBattlePopup(prefix, type) {
  const wrap=document.getElementById(`${prefix}-pokemon-area`); if(!wrap) return
  const el=document.createElement("div"); el.className=`battle-popup ${type}`; el.innerText=type==="critical"?"급소!":"회피!"
  wrap.appendChild(el); void el.offsetWidth; el.classList.add("show")
  el.addEventListener("animationend",()=>el.remove(),{once:true})
}

// ── 로그 ─────────────────────────────────────────
let renderedLogIds=new Set(), typingQueue=[], isTyping=false

function clearLogState() {
  renderedLogIds=new Set(); typingQueue=[]; isTyping=false
  const log=document.getElementById("battle-log"); if(log) log.innerHTML=""
}
function processQueue() {
  if(isTyping||typingQueue.length===0) return
  isTyping=true
  const {text,resolve}=typingQueue.shift()
  const log=document.getElementById("battle-log")
  if(!log){ isTyping=false; if(resolve)resolve(); processQueue(); return }
  const line=document.createElement("p"); log.appendChild(line)
  const chars=[...text]; let i=0
  function typeNext(){
    if(i>=chars.length){ isTyping=false; if(resolve)resolve(); setTimeout(processQueue,80); return }
    line.textContent+=chars[i++]; log.scrollTop=log.scrollHeight; setTimeout(typeNext,18)
  }
  typeNext()
}
function listenLogs(sinceTs) {
  clearLogState()
  const q=query(logsRef,orderBy("ts"))
  onSnapshot(q,snap=>{
    snap.docs.forEach(d=>{
      if(renderedLogIds.has(d.id)) return
      if(d.data().ts < sinceTs) return  // 이전 게임 로그 무시
      renderedLogIds.add(d.id)
      typingQueue.push({text:d.data().text,resolve:null})
    })
    processQueue()
  })
}

// ── 다이스 ───────────────────────────────────────
function popDiceNum(el) {
  if(!el) return
  el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop")
  el.addEventListener("animationend",()=>el.classList.remove("pop"),{once:true})
}
function animateAllDice(rolls, names, slots=ALL_FS) {
  return new Promise(resolve=>{
    const wrap=document.getElementById("dice-wrap"); if(!wrap){ resolve(); return }
    ALL_FS.forEach(s=>{
      const box=document.getElementById(`dice-box-${s}`)
      if(box) box.style.display=slots.includes(s)?"block":"none"
      const nameEl=document.getElementById(`${s}-name-dice`)
      if(nameEl&&slots.includes(s)) nameEl.innerText=names[s]??s
    })
    wrap.style.display="flex"
    let count=0
    const iv=setInterval(()=>{
      slots.forEach(s=>{ const el=document.getElementById(`dice-${s}`); if(el) el.innerText=rollD10() })
      if(++count>=22){
        clearInterval(iv)
        slots.forEach(s=>{ const el=document.getElementById(`dice-${s}`); if(el) el.innerText=rolls[s] })
        const maxScore=Math.max(...slots.map(s=>rolls[s]))
        slots.forEach(s=>{ if(rolls[s]===maxScore) popDiceNum(document.getElementById(`dice-${s}`)) })
        playSound(SFX_DICE)
        setTimeout(()=>{ wrap.style.display="none"; resolve() },2000)
      }
    },60)
  })
}
function animateDiceSingle(slot, finalRoll, names) {
  return new Promise(resolve=>{
    const wrap=document.getElementById("dice-wrap"); if(!wrap){ resolve(); return }
    ALL_FS.forEach(s=>{ const box=document.getElementById(`dice-box-${s}`); if(box) box.style.display=s===slot?"block":"none" })
    const nameEl=document.getElementById(`${slot}-name-dice`); if(nameEl) nameEl.innerText=names[slot]??slot
    wrap.style.display="flex"
    const diceEl=document.getElementById(`dice-${slot}`)
    let count=0
    const iv=setInterval(()=>{
      if(diceEl) diceEl.innerText=rollD10(); count++
      if(count>=16){ clearInterval(iv); if(diceEl) diceEl.innerText=finalRoll; popDiceNum(diceEl); playSound(SFX_DICE); setTimeout(()=>{ wrap.style.display="none"; resolve() },1000) }
    },60)
  })
}

// ── 라운드 배너 ──────────────────────────────────
function showRoundBanner(roundNum) {
  return new Promise(resolve=>{
    const banner=document.getElementById("round-banner"), text=document.getElementById("round-banner-text")
    if(!banner||!text){ resolve(); return }
    text.innerText=`ROUND ${roundNum}`; banner.classList.add("show")
    setTimeout(()=>{ banner.classList.remove("show"); resolve() },1800)
  })
}

function getNamesMap(data) {
  const m={}; ALL_FS.forEach(s=>{ m[s]=data[`${roomName(s)}_name`]??s }); return m
}

// ── 인증 & 진입 ──────────────────────────────────
onAuthStateChanged(auth, async user=>{
  if(!user) return
  myUid=user.uid
  const roomSnap=await getDoc(roomRef), room=roomSnap.data()
  const gameStartTs = Date.now()  // 이 시점 이후 로그만 표시

  if(isSpectator){
    mySlot=null
    const td=document.getElementById("turn-display"); if(td){ td.innerText="관전 중"; td.style.color="gray" }
    const lb=document.getElementById("leaveBtn"); if(lb){ lb.style.display="inline-block"; lb.disabled=false; lb.innerText="관전 종료"; lb.onclick=leaveAsSpectator }
  } else {
    for(const s of ALL_FS){ if(room[`${roomName(s)}_uid`]===myUid){ mySlot=s; break } }
    window.__myDisplayName=room[`${roomName(mySlot)}_name`]??myUid.slice(0,6)
  }

  listenLogs(gameStartTs)
  listenRoom()
  initChat()
})

// ── 방 리스너 ────────────────────────────────────
function listenRoom() {
  onSnapshot(roomRef, async snap=>{
    const data=snap.data(); if(!data) return

    ALL_FS.forEach(s=>{ const el=document.getElementById(`${s}-name`); if(el) el.innerText=data[`${roomName(s)}_name`]??"대기..." })
    const spectEl=document.getElementById("spectator-list")
    if(spectEl){ const n=data.spectator_names??[]; spectEl.innerText=n.length>0?"관전: "+n.join(", "):"" }

    if(!data.p1_entry||!data.p2_entry||!data.p3_entry||!data.p4_entry) return

    if(isSpectator){
      updateActiveUI("p1",data,"my"); updateActiveUI("p2",data,"ally")
      updateActiveUI("p3",data,"enemy1"); updateActiveUI("p4",data,"enemy2")
      setPlayerTags(data,"p1","p2","p3","p4")
    } else if(mySlot){
      const ally=allySlot(mySlot)
      const [en1,en2]=enemySlots(mySlot)
      updateActiveUI(mySlot,data,"my"); updateActiveUI(ally,data,"ally")
      updateActiveUI(en1,data,"enemy1"); updateActiveUI(en2,data,"enemy2")
      setPlayerTags(data,mySlot,ally,en1,en2)
    }

    if(data.hit_event&&data.hit_event.ts>lastHitTs){
      lastHitTs=data.hit_event.ts
      const def=data.hit_event.defender
      const pfx=slotToPrefix(def)
      if(pfx) triggerBlink(pfx)
    }

    if(data.dice_event&&data.dice_event.ts>lastDiceTs){
      lastDiceTs=data.dice_event.ts
      const names=getNamesMap(data)
      if(data.dice_event.type==="all"){
        animateAllDice(data.dice_event.rolls, names, data.dice_event.slots??ALL_FS)
      } else {
        animateDiceSingle(data.dice_event.slot, data.dice_event.roll, names)
      }
    }

    if(data.game_over){ showGameOver(data); return }

    if(isFirstSnapshot){
      isFirstSnapshot=false
      if(!isSpectator&&mySlot){
        myTurn = (data.current_order??[])[0]===mySlot
        actionDone=false
        forcedSwitchOpen=false
      }
    }

    if(!data.current_order||data.current_order.length===0){
      const pending=data.pending_switches??[]

      if(!isSpectator&&mySlot&&pending.includes(mySlot)&&!forcedSwitchOpen){
        forcedSwitchOpen=true
        openForcedSwitch(data)
        return
      }
      if(!isSpectator&&mySlot&&pending.includes(mySlot)) return

      if(!isSpectator&&mySlot==="p1"&&pending.length===0){
        console.log("startRound 호출 시도!", {mySlot, pending, current_order: data.current_order})
        callStartRound(data)
      }
      return
    }

    if(!isSpectator&&mySlot){
      const nowMyTurn=data.current_order[0]===mySlot
      if(!myTurn&&nowMyTurn) actionDone=false
      myTurn=nowMyTurn
    }

    updateTurnUI(data)
    updateBenchButtons(data)
    updateMoveButtons(data)
  })
}

// ── 서버 함수 호출 래퍼 ──────────────────────────
let startRoundCalling = false
async function callStartRound(data) {
  if(startRoundCalling) return
  if(data.current_order&&data.current_order.length>0) return
  startRoundCalling=true
  try {
    const result=await fnStartRound({ roomId: ROOM_ID })
    if(result.data.ok){
      await showRoundBanner(result.data.roundNum)
    }
  } catch(e){
    console.error("startRound 실패:", e)
  } finally {
    startRoundCalling=false
  }
}

async function callUseMove(moveIdx, targetSlots) {
  if(!myTurn||actionDone||gameOver) return
  actionDone=true
  updateMoveButtons({})

  try {
    const result=await fnUseMove({
      roomId: ROOM_ID,
      mySlot,
      moveIdx,
      targetSlots
    })
    if(!result.data.ok){
      actionDone=false
    }
  } catch(e){
    console.error("useMove 실패:", e)
    actionDone=false
    updateMoveButtons(await (await getDoc(roomRef)).data())
  }
}

async function callSwitchPokemon(newIdx) {
  if(!myTurn||actionDone||gameOver) return
  actionDone=true
  try {
    await fnSwitchPokemon({ roomId: ROOM_ID, mySlot, newIdx })
  } catch(e){
    console.error("switchPokemon 실패:", e)
    actionDone=false
  }
}

async function callForcedSwitch(newIdx, data) {
  try {
    const result=await fnForcedSwitch({ roomId: ROOM_ID, mySlot, newIdx })
    if(result.data.ok){
      forcedSwitchOpen=false
      const myName=data[`${roomName(mySlot)}_name`]
      const snap=await getDoc(roomRef), fd=snap.data()
      const next=fd[`${mySlot}_entry`]?.[newIdx]?.name??""
      await addDoc(logsRef,{text:`${myName}${josa(myName,"은는")} ${next}${josa(next,"을를")} 내보냈다!`,ts:Date.now()})
    }
  } catch(e){
    console.error("forcedSwitch 실패:", e)
    forcedSwitchOpen=false
  }
}

// ── 타겟 선택 오버레이 ───────────────────────────
function openTargetSelect(moveIdx, data) {
  if(!mySlot) return
  const myPkmn=data[`${mySlot}_entry`][data[`${mySlot}_active_idx`]??0]
  const moveData=myPkmn.moves[moveIdx]
  const moveInfo=moves[moveData.name]
  const [en1,en2]=enemySlots(mySlot)
  const e1=data[`${en1}_entry`]?.[data[`${en1}_active_idx`]??0]
  const e2=data[`${en2}_entry`]?.[data[`${en2}_active_idx`]??0]
  const allyS=allySlot(mySlot)
  const allyPkmn=data[`${allyS}_entry`]?.[data[`${allyS}_active_idx`]??0]

  const overlay=document.getElementById("target-overlay"), btnWrap=document.getElementById("target-buttons")
  if(!overlay||!btnWrap) return
  btnWrap.innerHTML=""

  function makeBtn(label, slots) {
    const btn=document.createElement("button"); btn.className="target-btn"; btn.innerText=label
    btn.onclick=()=>{ overlay.classList.remove("show"); callUseMove(moveIdx,slots) }
    btnWrap.appendChild(btn)
  }

  if(moveInfo?.targetAll){
    const targets=[]; if(e1&&e1.hp>0) targets.push(en1); if(e2&&e2.hp>0) targets.push(en2)
    callUseMove(moveIdx, targets); return
  }

  if(moveInfo?.targetAlly){
    makeBtn(`나 (${myPkmn.name})`,[mySlot])
    if(allyPkmn&&allyPkmn.hp>0) makeBtn(`동료 (${allyPkmn.name})`,[allyS])
    overlay.classList.add("show")
    document.getElementById("target-cancel-btn").onclick=()=>{ overlay.classList.remove("show"); actionDone=false }
    return
  }

  const aliveEnemies=[]
  if(e1&&e1.hp>0) aliveEnemies.push({s:en1,pkmn:e1})
  if(e2&&e2.hp>0) aliveEnemies.push({s:en2,pkmn:e2})
  if(aliveEnemies.length===0){ callUseMove(moveIdx,[]); return }
  if(aliveEnemies.length===1){ callUseMove(moveIdx,[aliveEnemies[0].s]); return }

  aliveEnemies.forEach(({s,pkmn})=>{ makeBtn(`${data[`${roomName(s)}_name`]??s}의 ${pkmn.name}`,[s]) })
  overlay.classList.add("show")
  document.getElementById("target-cancel-btn").onclick=()=>{ overlay.classList.remove("show"); actionDone=false }
}

// ── 강제 교체 오버레이 ───────────────────────────
function openForcedSwitch(data) {
  if(gameOver) return
  const myEntry=data[`${mySlot}_entry`]
  const activeIdx=data[`${mySlot}_active_idx`]??0
  const aliveIdxs=myEntry.map((_,i)=>i).filter(i=>i!==activeIdx&&myEntry[i].hp>0)

  if(aliveIdxs.length===0){
    forcedSwitchOpen=false
    fnForcedSwitch({ roomId:ROOM_ID, mySlot, newIdx: activeIdx }).catch(console.error)
    return
  }

  const overlay=document.getElementById("target-overlay"), btnWrap=document.getElementById("target-buttons")
  if(!overlay||!btnWrap){ forcedSwitchOpen=false; return }
  btnWrap.innerHTML=""

  const title=overlay.querySelector("h3"); if(title) title.innerText="포켓몬을 내보내!"
  const cancelBtn=document.getElementById("target-cancel-btn"); if(cancelBtn) cancelBtn.style.display="none"

  aliveIdxs.forEach(idx=>{
    const p=myEntry[idx]
    const btn=document.createElement("button"); btn.className="target-btn"
    btn.style.background="#4a9eff"
    btn.innerText=`${p.name}  HP: ${p.hp}/${p.maxHp}`
    btn.onclick=async()=>{
      overlay.classList.remove("show")
      if(title) title.innerText="누구에게 사용할까?"
      if(cancelBtn) cancelBtn.style.display=""
      await callForcedSwitch(idx, data)
    }
    btnWrap.appendChild(btn)
  })
  overlay.classList.add("show")
}

// ── UI 업데이트 ──────────────────────────────────
function slotToPrefix(slot) {
  if(isSpectator){
    return slot==="p1"?"my": slot==="p2"?"ally": slot==="p3"?"enemy1": "enemy2"
  }
  if(!mySlot) return null
  const [en1,en2]=enemySlots(mySlot)
  return slot===mySlot?"my": slot===allySlot(mySlot)?"ally": slot===en1?"enemy1": "enemy2"
}

function setPlayerTags(data, myS, allyS, en1S, en2S) {
  const tags={my:myS, ally:allyS, enemy1:en1S, enemy2:en2S}
  Object.entries(tags).forEach(([pfx,s])=>{
    const el=document.getElementById(`${pfx}-player-tag`)
    if(el) el.innerText=data[`${roomName(s)}_name`]??""
  })
}

function updateActiveUI(fsSlot, data, prefix) {
  const activeIdx=data[`${fsSlot}_active_idx`]??0, pkmn=data[`${fsSlot}_entry`]?.[activeIdx]
  if(!pkmn) return
  const st=pkmn.status?` [${statusName(pkmn.status)}]`:"", cf=(pkmn.confusion??0)>0?" [혼란]":""
  const nameEl=document.getElementById(`${prefix}-active-name`); if(nameEl) nameEl.innerText=pkmn.name+st+cf
  updateHpBar(`${prefix}-hp-bar`,`${prefix}-active-hp`,pkmn.hp,pkmn.maxHp,prefix==="my")
  updatePortrait(prefix,pkmn)
}

function updateTurnUI(data) {
  const el=document.getElementById("turn-display"), tc=document.getElementById("turn-count")
  if(el){
    if(isSpectator){
      const cur=data.current_order?.[0]
      el.innerText=cur?`${data[`${roomName(cur)}_name`]??cur}의 턴`:"대기 중"
      el.style.color="gray"
    } else {
      el.innerText=myTurn?"내 턴!":"상대 턴..."; el.style.color=myTurn?"green":"gray"
    }
  }
  if(tc) tc.innerText=`라운드 ${data.round_count??1}`
}

const typeColors={"노말":"#949495","불":"#e56c3e","물":"#5185c5","전기":"#fbb917","풀":"#66a945","얼음":"#6dc8eb","격투":"#e09c40","독":"#735198","땅":"#9c7743","바위":"#bfb889","비행":"#a2c3e7","에스퍼":"#dd6b7b","벌레":"#9fa244","고스트":"#684870","드래곤":"#535ca8","악":"#4c4948","강철":"#69a9c7","페어리":"#dab4d4"}

function updateMoveButtons(data) {
  if(isSpectator||!mySlot) return
  const myPkmn=data[`${mySlot}_entry`]?.[data[`${mySlot}_active_idx`]??0]
  const fainted=!myPkmn||myPkmn.hp<=0, movesArr=myPkmn?.moves??[]
  for(let i=0;i<4;i++){
    const btn=document.getElementById(`move-btn-${i}`); if(!btn) continue
    if(i>=movesArr.length){ btn.innerHTML='<span style="font-size:13px;">-</span>'; btn.disabled=true; btn.onclick=null; continue }
    const move=movesArr[i], moveInfo=moves[move.name]
    const accText=moveInfo?.alwaysHit?"필중":`${moveInfo?.accuracy??100}%`
    btn.innerHTML=`<span style="display:block;font-size:13px;font-weight:bold;">${move.name}</span><span style="display:block;font-size:10px;opacity:0.85;">PP: ${move.pp} | ${accText}</span>`
    const color=typeColors[moveInfo?.type]??"#a0a0a0"
    btn.style.setProperty("--btn-color",color); btn.style.background=color; btn.style.boxShadow=`inset 0 0 0 2px white,0 0 0 2px ${color}`
    if(fainted||move.pp<=0||!myTurn||actionDone){ btn.disabled=true; btn.onclick=null }
    else { btn.disabled=false; btn.onclick=()=>{ playSound(SFX_BTN); openTargetSelect(i,data) } }
  }
}

function updateBenchButtons(data) {
  if(isSpectator||!mySlot) return
  const bench=document.getElementById("bench-container"); bench.innerHTML=""
  const myEntry=data[`${mySlot}_entry`], activeIdx=data[`${mySlot}_active_idx`]??0
  myEntry.forEach((pkmn,idx)=>{
    if(idx===activeIdx) return
    const btn=document.createElement("button")
    if(pkmn.hp<=0){ btn.innerHTML=`<span class="bench-name">${pkmn.name}</span><span class="bench-hp">기절</span>`; btn.disabled=true }
    else {
      btn.innerHTML=`<span class="bench-name">${pkmn.name}</span><span class="bench-hp">HP: ${pkmn.hp}/${pkmn.maxHp}</span>`
      btn.disabled=!myTurn||actionDone
      btn.onclick=()=>{ playSound(SFX_BTN); callSwitchPokemon(idx) }
    }
    bench.appendChild(btn)
  })
}

// ── 게임 오버 ─────────────────────────────────────
function showGameOver(data) {
  gameOver=true
  const td=document.getElementById("turn-display")
  if(isSpectator){ if(td){ td.innerText=`🏆 팀${data.winner_team} 승리!`; td.style.color="gold" } }
  else { const win=teamOf(mySlot)===data.winner_team; if(td){ td.innerText=win?"🏆 우리 팀의 승리!":"💀 패배..."; td.style.color=win?"gold":"red" } }
  for(let i=0;i<4;i++){ const b=document.getElementById(`move-btn-${i}`); if(b){ b.disabled=true; b.onclick=null } }
  const bench=document.getElementById("bench-container"); if(bench) bench.innerHTML=""
  if(!isSpectator){ const lb=document.getElementById("leaveBtn"); if(lb){ lb.style.display="inline-block"; lb.disabled=false; lb.innerText="방 나가기"; lb.onclick=leaveGame } }
}

async function leaveAsSpectator() {
  const snap=await getDoc(roomRef), data=snap.data()
  await updateDoc(roomRef,{spectators:(data.spectators??[]).filter(u=>u!==myUid),spectator_names:(data.spectator_names??[]).filter((_,i)=>(data.spectators??[])[i]!==myUid)})
  location.href="../main.html"
}
async function leaveGame() {
  clearLogState()
  const reset={game_started:false,game_over:false,winner_team:null,current_order:[],turn_count:0,round_count:0,dice_event:null,hit_event:null,background:null,pending_switches:[]}
  ALL_FS.forEach(s=>{ const rs=roomName(s); reset[`${rs}_uid`]=null; reset[`${rs}_name`]=null; reset[`${rs}_ready`]=false; reset[`${s}_entry`]=null; reset[`${s}_active_idx`]=0 })
  reset.spectators=[]; reset.spectator_names=[]
  await updateDoc(roomRef,reset); location.href="../main.html"
}

// ── 채팅 ─────────────────────────────────────────
function initChat() {
  if(typeof window.initDoubleChat==="function")
    window.initDoubleChat({db, ROOM_ID, myUid, mySlot, isSpectator})
}
