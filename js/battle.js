// battle.js (더블배틀 4인 - 라운드제 순서 + 타겟 선택 버튼)

import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, collection, getDoc, getDocs, updateDoc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, increment
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
import { moves } from "./moves.js"
import { getTypeMultiplier } from "./typeChart.js"
import {
  statusName, josa as josaEH,
  applyMoveEffect, checkPreActionStatus, checkConfusion,
  applyEndOfTurnDamage, applyWeatherEffect,
  getStatusSpdPenalty
} from "./effecthandler.js"

const roomRef = doc(db, "double", ROOM_ID)
const logsRef = collection(db, "double", ROOM_ID, "logs")

const SFX_DICE = "https://slippery-copper-mzpmcmc2ra.edgeone.app/soundreality-bicycle-bell-155622.mp3"
const SFX_BTN  = "https://usual-salmon-mnqxptwyvw.edgeone.app/Pokemon%20(A%20Button)%20-%20Sound%20Effect%20(HD)%20(1)%20(1).mp3"

// ── 슬롯 상수 ──────────────────────────────────────
const TEAM_A = ["p1", "p2"]
const TEAM_B = ["p3", "p4"]
const ALL_FS = ["p1", "p2", "p3", "p4"]

function teamOf(s)     { return TEAM_A.includes(s) ? "A" : TEAM_B.includes(s) ? "B" : null }
function allySlot(s)   { return s==="p1"?"p2": s==="p2"?"p1": s==="p3"?"p4": s==="p4"?"p3": null }
function enemySlots(s) { return teamOf(s)==="A" ? TEAM_B : TEAM_A }
function roomName(s)   { return s.replace("p","player") }

// ── 유틸 ────────────────────────────────────────────
function playSound(url)  { const a=new Audio(url); a.volume=0.6; a.play().catch(()=>{}) }
function wait(ms)        { return new Promise(r=>setTimeout(r,ms)) }
function josa(w,t)       { return josaEH(w,t) }
function rollD10()       { return Math.floor(Math.random()*10)+1 }
function isAllFainted(entry) { return entry.every(p=>p.hp<=0) }
function teamFainted(entries, team) {
  return team==="A"
    ? isAllFainted(entries.p1) && isAllFainted(entries.p2)
    : isAllFainted(entries.p3) && isAllFainted(entries.p4)
}

// ── 상태 변수 ────────────────────────────────────────
let mySlot     = null
let myUid      = null
let myTurn     = false
let roundInit  = false
let actionDone = false
let gameOver   = false
let lastHitTs  = 0
let lastDiceTs = 0

const isSpectator = new URLSearchParams(location.search).get("spectator")==="true"

// ── 랭크 ────────────────────────────────────────────
function defaultRanks() { return { atk:0,atkTurns:0,def:0,defTurns:0,spd:0,spdTurns:0 } }
function getActiveRank(pkmn,key) {
  const r=pkmn.ranks??{}; return (r[`${key}Turns`]??0)>0?(r[key]??0):0
}
function tickMyRanks(pkmn) {
  if(!pkmn.ranks) return []
  const r=pkmn.ranks,msgs=[]
  if(r.atkTurns>0){r.atkTurns--;if(!r.atkTurns){r.atk=0;msgs.push(`${pkmn.name}의 공격 랭크가 원래대로 돌아왔다!`)}}
  if(r.defTurns>0){r.defTurns--;if(!r.defTurns){r.def=0;msgs.push(`${pkmn.name}의 방어 랭크가 원래대로 돌아왔다!`)}}
  if(r.spdTurns>0){r.spdTurns--;if(!r.spdTurns){r.spd=0;msgs.push(`${pkmn.name}의 스피드 랭크가 원래대로 돌아왔다!`)}}
  return msgs
}
function applyRankChanges(r,self,target) {
  if(!r) return []
  const msgs=[]
  const roll=r.chance!==undefined?Math.random()<r.chance:true
  if(!roll) return []
  const sR={...defaultRanks(),...(self.ranks??{})}
  const tR={...defaultRanks(),...(target.ranks??{})}
  const label={atk:"공격",def:"방어",spd:"스피드"}
  function applyOne(obj,key,delta,maxV,minV,name){
    if(delta>0){const p=obj[key];obj[key]=Math.min(maxV,obj[key]+delta);obj[`${key}Turns`]=r.turns??2;msgs.push(`${name}의 ${label[key]}이 올라갔다! (+${obj[key]-p})`)}
    else if(delta<0){if(obj[key]===0)msgs.push(`${name}의 ${label[key]}은 더 이상 내려가지 않는다!`);else{const p=obj[key];obj[key]=Math.max(minV,obj[key]+delta);obj[`${key}Turns`]=r.turns??2;msgs.push(`${name}의 ${label[key]}이 내려갔다! (${obj[key]-p})`)}}
  }
  if(r.atk!==undefined)       applyOne(sR,"atk",r.atk,4,0,self.name)
  if(r.def!==undefined)       applyOne(sR,"def",r.def,3,0,self.name)
  if(r.spd!==undefined)       applyOne(sR,"spd",r.spd,5,0,self.name)
  if(r.targetAtk!==undefined) applyOne(tR,"atk",r.targetAtk,4,0,target.name)
  if(r.targetDef!==undefined) applyOne(tR,"def",r.targetDef,3,0,target.name)
  if(r.targetSpd!==undefined) applyOne(tR,"spd",r.targetSpd,5,0,target.name)
  self.ranks=sR; target.ranks=tR
  return msgs
}

// ── 전투 계산 ─────────────────────────────────────
function calcHit(atk,moveInfo,def) {
  if(Math.random()*100>=(moveInfo.accuracy??100)) return {hit:false,hitType:"missed"}
  if(moveInfo.alwaysHit||moveInfo.skipEvasion)    return {hit:true,hitType:"hit"}
  const as=Math.max(1,(atk.speed??3)-getStatusSpdPenalty(atk))
  const ds=Math.max(1,(def.speed??3)-getStatusSpdPenalty(def))
  const ev=Math.min(99,Math.max(0,5*(ds-as))+Math.max(0,getActiveRank(def,"spd")))
  return Math.random()*100<ev?{hit:false,hitType:"evaded"}:{hit:true,hitType:"hit"}
}
function calcDamage(atk,moveName,def,atkRank=0,defRank=0) {
  const move=moves[moveName]
  if(!move) return {damage:0,multiplier:1,stab:false,dice:0,critical:false}
  const dice=rollD10()
  const defTypes=Array.isArray(def.type)?def.type:[def.type]
  let mult=1; for(const dt of defTypes) mult*=getTypeMultiplier(move.type,dt)
  if(mult===0) return {damage:0,multiplier:0,stab:false,dice,critical:false}
  const atkTypes=Array.isArray(atk.type)?atk.type:[atk.type]
  const stab=atkTypes.includes(move.type)
  const base=(move.power??40)+(atk.attack??3)*4+dice
  const raw=Math.floor(base*mult*(stab?1.3:1))
  const afterAtk=Math.max(0,raw+Math.max(-raw,atkRank))
  const afterDef=Math.max(0,afterAtk-(def.defense??3)*5)
  const baseDmg=Math.max(0,afterDef-Math.min(3,Math.max(0,defRank))*3)
  const critical=Math.random()*100<Math.min(100,(atk.attack??3)*2)
  return {damage:critical?Math.floor(baseDmg*1.5):baseDmg,multiplier:mult,stab,dice,critical}
}

// ── HP 바 & 초상화 ───────────────────────────────
function updateHpBar(barId,textId,hp,maxHp,showNum) {
  const bar=document.getElementById(barId),txt=textId?document.getElementById(textId):null
  if(!bar) return
  const pct=maxHp>0?Math.max(0,Math.min(100,(hp/maxHp)*100)):0
  bar.style.width=pct+"%"
  bar.style.backgroundColor=pct>50?"#4caf50":pct>20?"#ff9800":"#f44336"
  if(txt) txt.innerText=showNum?`HP: ${hp} / ${maxHp}`:""
}
function updatePortrait(prefix,pkmn) {
  const img=document.getElementById(`${prefix}-portrait`); if(!img) return
  if(!pkmn?.portrait){img.classList.remove("visible");img.style.display="none";return}
  img.style.display="block"; img.src=pkmn.portrait; img.alt=pkmn.name
  setTimeout(()=>img.classList.add("visible"),80)
}

// ── 전투 이펙트 ──────────────────────────────────
function triggerAttackEffect(atkPfx,defPfx) {
  return new Promise(resolve=>{
    const atkArea=document.getElementById(`${atkPfx}-pokemon-area`)
    const defArea=document.getElementById(`${defPfx}-pokemon-area`)
    const wrapper=document.getElementById("main")
    if(atkArea){atkArea.classList.add("attacker-flash");atkArea.addEventListener("animationend",()=>atkArea.classList.remove("attacker-flash"),{once:true})}
    if(wrapper){wrapper.classList.add("screen-shake");wrapper.addEventListener("animationend",()=>wrapper.classList.remove("screen-shake"),{once:true})}
    setTimeout(()=>{
      if(defArea){defArea.classList.add("defender-hit");defArea.addEventListener("animationend",()=>{defArea.classList.remove("defender-hit");resolve()},{once:true})}
      else resolve()
    },120)
  })
}
function triggerBlink(prefix) {
  return new Promise(resolve=>{
    const area=document.getElementById(`${prefix}-pokemon-area`)
    if(!area){resolve();return}
    area.classList.add("blink-damage")
    area.addEventListener("animationend",()=>{area.classList.remove("blink-damage");resolve()},{once:true})
  })
}
function showBattlePopup(prefix,type) {
  const wrap=document.getElementById(`${prefix}-pokemon-area`); if(!wrap) return
  const el=document.createElement("div"); el.className=`battle-popup ${type}`; el.innerText=type==="critical"?"급소!":"회피!"
  wrap.appendChild(el); void el.offsetWidth; el.classList.add("show")
  el.addEventListener("animationend",()=>el.remove(),{once:true})
}

// ── 로그 ─────────────────────────────────────────
let renderedLogIds=new Set(),typingQueue=[],isTyping=false
function processQueue() {
  if(isTyping||typingQueue.length===0) return
  isTyping=true
  const {text,resolve}=typingQueue.shift()
  const log=document.getElementById("battle-log")
  if(!log){isTyping=false;if(resolve)resolve();processQueue();return}
  const line=document.createElement("p"); log.appendChild(line)
  const chars=[...text]; let i=0
  function typeNext(){
    if(i>=chars.length){isTyping=false;if(resolve)resolve();setTimeout(processQueue,80);return}
    line.textContent+=chars[i++]; log.scrollTop=log.scrollHeight; setTimeout(typeNext,18)
  }
  typeNext()
}
async function addLog(text) { await addDoc(logsRef,{text,ts:Date.now()}) }
function listenLogs() {
  const q=query(logsRef,orderBy("ts"))
  onSnapshot(q,snap=>{
    snap.docs.forEach(d=>{
      if(renderedLogIds.has(d.id)) return
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

// 4개 동시 다이스 (라운드 순서용)
function animateAllDice(rolls,names) {
  return new Promise(resolve=>{
    const wrap=document.getElementById("dice-wrap"); if(!wrap){resolve();return}
    ALL_FS.forEach(s=>{
      const box=document.getElementById(`dice-box-${s}`); if(box) box.style.display="block"
      const nameEl=document.getElementById(`${s}-name-dice`); if(nameEl) nameEl.innerText=names[s]??s
    })
    wrap.style.display="flex"
    let count=0
    const iv=setInterval(()=>{
      ALL_FS.forEach(s=>{const el=document.getElementById(`dice-${s}`);if(el)el.innerText=rollD10()})
      if(++count>=22){
        clearInterval(iv)
        ALL_FS.forEach(s=>{const el=document.getElementById(`dice-${s}`);if(el)el.innerText=rolls[s]})
        const maxScore=Math.max(...ALL_FS.map(s=>rolls[s]))
        ALL_FS.forEach(s=>{if(rolls[s]===maxScore) popDiceNum(document.getElementById(`dice-${s}`))})
        playSound(SFX_DICE)
        setTimeout(()=>{wrap.style.display="none";resolve()},2000)
      }
    },60)
  })
}

// 단일 다이스 (기술 사용 시)
function animateDiceSingle(slot,finalRoll,names) {
  return new Promise(resolve=>{
    const wrap=document.getElementById("dice-wrap"); if(!wrap){resolve();return}
    ALL_FS.forEach(s=>{const box=document.getElementById(`dice-box-${s}`);if(box) box.style.display=s===slot?"block":"none"})
    const nameEl=document.getElementById(`${slot}-name-dice`); if(nameEl) nameEl.innerText=names[slot]??slot
    wrap.style.display="flex"
    const diceEl=document.getElementById(`dice-${slot}`)
    let count=0
    const iv=setInterval(()=>{
      if(diceEl) diceEl.innerText=rollD10(); count++
      if(count>=16){clearInterval(iv);if(diceEl)diceEl.innerText=finalRoll;popDiceNum(diceEl);playSound(SFX_DICE);setTimeout(()=>{wrap.style.display="none";resolve()},1000)}
    },60)
  })
}

// ── 라운드 배너 ──────────────────────────────────
function showRoundBanner(roundNum) {
  return new Promise(resolve=>{
    const banner=document.getElementById("round-banner"),text=document.getElementById("round-banner-text")
    if(!banner||!text){resolve();return}
    text.innerText=`ROUND ${roundNum}`; banner.classList.add("show")
    setTimeout(()=>{banner.classList.remove("show");resolve()},1800)
  })
}

// ── 승리 보상 ─────────────────────────────────────
async function grantWinCoins(winnerTeam,data) {
  if(isSpectator||!mySlot) return
  if(teamOf(mySlot)!==winnerTeam) return
  try{await updateDoc(doc(db,"users",myUid),{coins:increment(300)});await addLog("🏆 승리 보상으로 300ZP를 받았다!")}
  catch(e){console.warn("코인 지급 실패",e)}
}

// ── 인증 & 진입 ──────────────────────────────────
onAuthStateChanged(auth, async user=>{
  if(!user) return
  myUid=user.uid
  const roomSnap=await getDoc(roomRef),room=roomSnap.data()

  if(isSpectator){
    mySlot=null
    const td=document.getElementById("turn-display"); if(td){td.innerText="관전 중";td.style.color="gray"}
    const lb=document.getElementById("leaveBtn"); if(lb){lb.style.display="inline-block";lb.disabled=false;lb.innerText="관전 종료";lb.onclick=leaveAsSpectator}
  } else {
    for(const s of ALL_FS){if(room[`${roomName(s)}_uid`]===myUid){mySlot=s;break}}
    window.__myDisplayName=room[`${roomName(mySlot)}_name`]??myUid.slice(0,6)
  }

  listenLogs()
  listenRoom()
  initChat()
})

// ── 방 리스너 ────────────────────────────────────
function listenRoom() {
  onSnapshot(roomRef, async snap=>{
    const data=snap.data(); if(!data) return

    ALL_FS.forEach(s=>{const el=document.getElementById(`${s}-name`);if(el)el.innerText=data[`${roomName(s)}_name`]??"대기..."})
    const spectEl=document.getElementById("spectator-list")
    if(spectEl){const n=data.spectator_names??[];spectEl.innerText=n.length>0?"관전: "+n.join(", "):""}

    if(!data.p1_entry||!data.p2_entry||!data.p3_entry||!data.p4_entry) return

    if(!isSpectator&&mySlot){
      const ally=allySlot(mySlot),[en1,en2]=enemySlots(mySlot)
      updateActiveUI(mySlot,data,"my"); updateActiveUI(ally,data,"ally")
      updateActiveUI(en1,data,"enemy1"); updateActiveUI(en2,data,"enemy2")
      const setTag=(pfx,s)=>{const el=document.getElementById(`${pfx}-player-tag`);if(el)el.innerText=data[`${roomName(s)}_name`]??""}
      setTag("ally",ally); setTag("enemy1",en1); setTag("enemy2",en2)
    }

    // hit 이벤트
    if(data.hit_event&&data.hit_event.ts>lastHitTs){
      lastHitTs=data.hit_event.ts
      if(!isSpectator&&mySlot){
        const def=data.hit_event.defender
        const pfx=def===mySlot?"my":def===allySlot(mySlot)?"ally":enemySlots(mySlot).indexOf(def)===0?"enemy1":"enemy2"
        triggerBlink(pfx)
      }
    }

    // dice 이벤트
    if(data.dice_event&&data.dice_event.ts>lastDiceTs){
      lastDiceTs=data.dice_event.ts
      const names=getNamesMap(data)
      if(data.dice_event.type==="all") animateAllDice(data.dice_event.rolls,names)
      else animateDiceSingle(data.dice_event.slot,data.dice_event.roll,names)
    }

    if(data.game_over){showGameOver(data);return}

    // current_order 없음 = 라운드 시작 대기
    if(!data.current_order||data.current_order.length===0){
      if(!isSpectator&&mySlot==="p1"&&!roundInit){
        roundInit=true
        await startRound(data)
      }
      return
    }

    if(!isSpectator&&mySlot){
      const wasMine=myTurn
      myTurn=data.current_order[0]===mySlot
      if(!wasMine&&myTurn) actionDone=false
      updateTurnUI(data)

      // 내 턴인데 active 포켓몬이 기절 → 강제 교체
      if(myTurn&&!actionDone){
        const myActive=data[`${mySlot}_entry`]?.[data[`${mySlot}_active_idx`]??0]
        if(myActive&&myActive.hp<=0){
          openForcedSwitch(data)
          return
        }
      }
    }
    updateBenchButtons(data)
    updateMoveButtons(data)
  })
}

function getNamesMap(data){const m={};ALL_FS.forEach(s=>{m[s]=data[`${roomName(s)}_name`]??s});return m}

// ── 라운드 시작 ───────────────────────────────────
async function startRound(data) {
  const roundNum=(data.round_count??0)+1
  const rolls={},scores={}
  ALL_FS.forEach(s=>{
    const pkmn=data[`${s}_entry`]?.[data[`${s}_active_idx`]??0]
    // 기절이어도 순서에 포함 (턴이 오면 강제 교체)
    const spd=pkmn?.speed??3
    rolls[s]=rollD10(); scores[s]=spd+rolls[s]
  })
  const order=[...ALL_FS].sort((a,b)=>scores[b]-scores[a])

  const diceTs=Date.now()
  await updateDoc(roomRef,{dice_event:{type:"all",rolls,ts:diceTs},round_count:roundNum})
  await animateAllDice(rolls,getNamesMap(data))
  await updateDoc(roomRef,{dice_event:null})
  await showRoundBanner(roundNum)
  await addLog(`── ROUND ${roundNum} 순서: ${order.map(s=>data[`${roomName(s)}_name`]??s).join(" → ")} ──`)
  await updateDoc(roomRef,{current_order:order})
}

// ── 턴 진행 ───────────────────────────────────────
// current_order 맨 앞 제거
// eot=true면 라운드 끝 → EOT 처리 후 roundInit=false
async function advanceTurn(entries,data) {
  const order=[...data.current_order]
  order.shift()
  const turn_count=(data.turn_count??1)+1
  const eot=order.length===0
  if(eot) roundInit=false
  return {current_order:order,turn_count,eot}
}

// ── 게임 오버 ─────────────────────────────────────
function showGameOver(data) {
  gameOver=true
  const td=document.getElementById("turn-display")
  if(isSpectator){if(td){td.innerText=`🏆 팀${data.winner_team} 승리!`;td.style.color="gold"}}
  else{const win=teamOf(mySlot)===data.winner_team;if(td){td.innerText=win?"🏆 우리 팀의 승리!":"💀 패배...";td.style.color=win?"gold":"red"}}
  for(let i=0;i<4;i++){const b=document.getElementById(`move-btn-${i}`);if(b){b.disabled=true;b.onclick=null}}
  const bench=document.getElementById("bench-container");if(bench)bench.innerHTML=""
  if(!isSpectator){const lb=document.getElementById("leaveBtn");if(lb){lb.style.display="inline-block";lb.disabled=false;lb.innerText="방 나가기";lb.onclick=leaveGame}}
}

async function leaveAsSpectator(){
  const snap=await getDoc(roomRef),data=snap.data()
  await updateDoc(roomRef,{spectators:(data.spectators??[]).filter(u=>u!==myUid),spectator_names:(data.spectator_names??[]).filter((_,i)=>(data.spectators??[])[i]!==myUid)})
  location.href="../main.html"
}
async function leaveGame(){
  const logSnap=await getDocs(logsRef); await Promise.all(logSnap.docs.map(d=>deleteDoc(d.ref)))
  const reset={game_started:false,game_over:false,winner_team:null,current_order:[],turn_count:0,round_count:0,dice_event:null,hit_event:null,background:null}
  ALL_FS.forEach(s=>{const rs=roomName(s);reset[`${rs}_uid`]=null;reset[`${rs}_name`]=null;reset[`${rs}_ready`]=false;reset[`${s}_entry`]=null;reset[`${s}_active_idx`]=0})
  reset.spectators=[];reset.spectator_names=[]
  await updateDoc(roomRef,reset); location.href="../main.html"
}

// ── Active UI ────────────────────────────────────
function updateActiveUI(fsSlot,data,prefix){
  const activeIdx=data[`${fsSlot}_active_idx`]??0,pkmn=data[`${fsSlot}_entry`]?.[activeIdx]
  if(!pkmn) return
  const st=pkmn.status?` [${statusName(pkmn.status)}]`:"",cf=(pkmn.confusion??0)>0?" [혼란]":""
  const nameEl=document.getElementById(`${prefix}-active-name`); if(nameEl) nameEl.innerText=pkmn.name+st+cf
  updateHpBar(`${prefix}-hp-bar`,`${prefix}-active-hp`,pkmn.hp,pkmn.maxHp,prefix==="my")
  updatePortrait(prefix,pkmn)
}
function updateTurnUI(data){
  const el=document.getElementById("turn-display"),tc=document.getElementById("turn-count")
  if(el&&!isSpectator){el.innerText=myTurn?"내 턴!":"상대 턴...";el.style.color=myTurn?"green":"gray"}
  if(tc) tc.innerText=`라운드 ${data.round_count??1}`
}

// ── 기술 버튼 ────────────────────────────────────
const typeColors={"노말":"#949495","불":"#e56c3e","물":"#5185c5","전기":"#fbb917","풀":"#66a945","얼음":"#6dc8eb","격투":"#e09c40","독":"#735198","땅":"#9c7743","바위":"#bfb889","비행":"#a2c3e7","에스퍼":"#dd6b7b","벌레":"#9fa244","고스트":"#684870","드래곤":"#535ca8","악":"#4c4948","강철":"#69a9c7","페어리":"#dab4d4"}

function updateMoveButtons(data){
  if(isSpectator||!mySlot) return
  const myPkmn=data[`${mySlot}_entry`]?.[data[`${mySlot}_active_idx`]??0]
  const fainted=!myPkmn||myPkmn.hp<=0,movesArr=myPkmn?.moves??[]
  for(let i=0;i<4;i++){
    const btn=document.getElementById(`move-btn-${i}`); if(!btn) continue
    if(i>=movesArr.length){btn.innerHTML='<span style="font-size:13px;">-</span>';btn.disabled=true;btn.onclick=null;continue}
    const move=movesArr[i],moveInfo=moves[move.name]
    const accText=moveInfo?.alwaysHit?"필중":`${moveInfo?.accuracy??100}%`
    btn.innerHTML=`<span style="display:block;font-size:13px;font-weight:bold;">${move.name}</span><span style="display:block;font-size:10px;opacity:0.85;">PP: ${move.pp} | ${accText}</span>`
    const color=typeColors[moveInfo?.type]??"#a0a0a0"
    btn.style.setProperty("--btn-color",color);btn.style.background=color;btn.style.boxShadow=`inset 0 0 0 2px white,0 0 0 2px ${color}`
    if(fainted||move.pp<=0||!myTurn||actionDone){btn.disabled=true;btn.onclick=null}
    else{btn.disabled=false;btn.onclick=()=>{playSound(SFX_BTN);openTargetSelect(i,data)}}
  }
}
function updateBenchButtons(data){
  if(isSpectator||!mySlot) return
  const bench=document.getElementById("bench-container"); bench.innerHTML=""
  const myEntry=data[`${mySlot}_entry`],activeIdx=data[`${mySlot}_active_idx`]??0
  myEntry.forEach((pkmn,idx)=>{
    if(idx===activeIdx) return
    const btn=document.createElement("button")
    if(pkmn.hp<=0){btn.innerHTML=`<span class="bench-name">${pkmn.name}</span><span class="bench-hp">기절</span>`;btn.disabled=true}
    else{btn.innerHTML=`<span class="bench-name">${pkmn.name}</span><span class="bench-hp">HP: ${pkmn.hp}/${pkmn.maxHp}</span>`;btn.disabled=!myTurn||actionDone;btn.onclick=()=>{playSound(SFX_BTN);switchPokemon(idx)}}
    bench.appendChild(btn)
  })
}

// ── 강제 교체 (active 기절 시) ──────────────────────
function openForcedSwitch(data) {
  if(actionDone||gameOver) return
  const myEntry=data[`${mySlot}_entry`]
  const aliveIdxs=myEntry.map((p,i)=>i).filter(i=>myEntry[i].hp>0)

  // 살아있는 포켓몬이 없으면 팀 전멸 → checkWin이 처리할 것
  if(aliveIdxs.length===0) return

  const overlay=document.getElementById("target-overlay")
  const btnWrap=document.getElementById("target-buttons")
  if(!overlay||!btnWrap) return
  btnWrap.innerHTML=""

  const title=overlay.querySelector("h3")
  if(title) title.innerText="포켓몬을 내보내!"

  aliveIdxs.forEach(idx=>{
    const p=myEntry[idx]
    const btn=document.createElement("button")
    btn.className="target-btn"
    btn.style.background="#4a9eff"
    btn.innerText=`${p.name}  HP: ${p.hp}/${p.maxHp}`
    btn.onclick=async()=>{
      overlay.classList.remove("show")
      if(title) title.innerText="누구에게 사용할까?"
      await forcedSwitch(idx, data)
    }
    btnWrap.appendChild(btn)
  })

  // 취소 없음 (강제 교체는 취소 불가)
  const cancelBtn=document.getElementById("target-cancel-btn")
  if(cancelBtn) cancelBtn.style.display="none"

  overlay.classList.add("show")
}

// 강제 교체 실행 (턴 소모 없이 idx만 변경 후 advanceTurn)
async function forcedSwitch(newIdx, data) {
  if(actionDone||gameOver) return
  actionDone=true

  const snap=await getDoc(roomRef), fd=snap.data()
  const entries=deepCopyEntries(fd)
  const myName=fd[`${roomName(mySlot)}_name`]
  const next=entries[mySlot][newIdx].name

  await addLog(`${myName}${josa(myName,"은는")} ${next}${josa(next,"을를")} 내보냈다!`)

  // 취소 버튼 복원
  const cancelBtn=document.getElementById("target-cancel-btn")
  if(cancelBtn) cancelBtn.style.display=""

  // 턴은 정상 소모 (advanceTurn)
  const {current_order,turn_count,eot}=await advanceTurn(entries,fd)
  const update={...buildEntryUpdate(entries),[`${mySlot}_active_idx`]:newIdx,current_order,turn_count}

  if(eot){
    const {msgs,anyFainted}=applyEndOfTurnDamage([entries.p1,entries.p2,entries.p3,entries.p4])
    for(const m of msgs){await addLog(m);await wait(280)}
    Object.assign(update,buildEntryUpdate(entries))
    const w=checkWin(entries); if(w){await handleWin(w,fd,update);return}
  }
  await updateDoc(roomRef,update)
}

// ── 타겟 선택 오버레이 ───────────────────────────
function openTargetSelect(moveIdx,data){
  if(!mySlot) return
  const myPkmn=data[`${mySlot}_entry`][data[`${mySlot}_active_idx`]??0]
  const moveData=myPkmn.moves[moveIdx]
  const moveInfo=moves[moveData.name]
  const [en1,en2]=enemySlots(mySlot)
  const e1=data[`${en1}_entry`]?.[data[`${en1}_active_idx`]??0]
  const e2=data[`${en2}_entry`]?.[data[`${en2}_active_idx`]??0]
  const allyS=allySlot(mySlot)
  const allyPkmn=data[`${allyS}_entry`]?.[data[`${allyS}_active_idx`]??0]

  const overlay=document.getElementById("target-overlay"),btnWrap=document.getElementById("target-buttons")
  if(!overlay||!btnWrap) return
  btnWrap.innerHTML=""

  function makeBtn(label,slots){
    const btn=document.createElement("button"); btn.className="target-btn"; btn.innerText=label
    btn.onclick=()=>{overlay.classList.remove("show");useMove(moveIdx,data,slots)}
    btnWrap.appendChild(btn)
  }

  // 범위기: 살아있는 적 전원 자동
  if(moveInfo?.targetAll){
    const targets=[]; if(e1&&e1.hp>0) targets.push(en1); if(e2&&e2.hp>0) targets.push(en2)
    useMove(moveIdx,data,targets); return
  }

  // 아군 대상 기술
  if(moveInfo?.targetAlly){
    makeBtn(`나 (${myPkmn.name})`,[mySlot])
    if(allyPkmn&&allyPkmn.hp>0) makeBtn(`동료 (${allyPkmn.name})`,[allyS])
    overlay.classList.add("show")
    document.getElementById("target-cancel-btn").onclick=()=>{overlay.classList.remove("show");actionDone=false}
    return
  }

  // 단일 적 대상
  const aliveEnemies=[]
  if(e1&&e1.hp>0) aliveEnemies.push({s:en1,pkmn:e1})
  if(e2&&e2.hp>0) aliveEnemies.push({s:en2,pkmn:e2})

  if(aliveEnemies.length===0){useMove(moveIdx,data,[]);return}
  if(aliveEnemies.length===1){useMove(moveIdx,data,[aliveEnemies[0].s]);return}

  // 둘 다 살아있을 때만 선택지 표시
  aliveEnemies.forEach(({s,pkmn})=>{
    makeBtn(`${data[`${roomName(s)}_name`]??s}의 ${pkmn.name} (HP: ${pkmn.hp})`,[s])
  })
  overlay.classList.add("show")
  document.getElementById("target-cancel-btn").onclick=()=>{overlay.classList.remove("show");actionDone=false}
}

// ── 교체 ─────────────────────────────────────────
async function switchPokemon(newIdx){
  if(!myTurn||actionDone||gameOver) return
  actionDone=true
  const snap=await getDoc(roomRef),data=snap.data()
  const entries=deepCopyEntries(data)
  const myName=data[`${roomName(mySlot)}_name`]
  const prev=entries[mySlot][data[`${mySlot}_active_idx`]??0].name
  const next=entries[mySlot][newIdx].name
  await addLog(`돌아와, ${prev}!`); await wait(300)
  await addLog(`${myName}${josa(myName,"은는")} ${next}${josa(next,"을를")} 내보냈다!`)

  const {current_order,turn_count,eot}=await advanceTurn(entries,data)
  entries[mySlot][newIdx]  // 교체 후 hp 체크는 실제 index 업데이트 후
  const update={...buildEntryUpdate(entries),[`${mySlot}_active_idx`]:newIdx,current_order,turn_count}
  if(eot){
    const {msgs,anyFainted}=applyEndOfTurnDamage([entries.p1,entries.p2,entries.p3,entries.p4])
    for(const m of msgs){await addLog(m);await wait(280)}
    Object.assign(update,buildEntryUpdate(entries))
    const w=checkWin(entries); if(w){await handleWin(w,data,update);return}
  }
  await updateDoc(roomRef,update)
}

// ── 기술 사용 ────────────────────────────────────
async function useMove(moveIdx,data,targetSlots){
  if(!myTurn||actionDone||gameOver) return
  actionDone=true; updateMoveButtons(data)

  const snap=await getDoc(roomRef),fd=snap.data()
  const entries=deepCopyEntries(fd)
  const myActiveIdx=fd[`${mySlot}_active_idx`]??0
  const myPkmn=entries[mySlot][myActiveIdx]
  const myName=fd[`${roomName(mySlot)}_name`]

  if(myPkmn.hp<=0){actionDone=false;return}
  const moveData=myPkmn.moves[moveIdx]
  if(!moveData||moveData.pp<=0){actionDone=false;return}

  // 선행 상태이상
  const pre=checkPreActionStatus(myPkmn)
  for(const msg of pre.msgs){await addLog(msg);await wait(350)}
  if(pre.blocked){
    const {current_order,turn_count,eot}=await advanceTurn(entries,fd)
    const update={...buildEntryUpdate(entries),current_order,turn_count}
    if(eot){const {msgs,anyFainted}=applyEndOfTurnDamage([entries.p1,entries.p2,entries.p3,entries.p4]);for(const m of msgs){await addLog(m);await wait(280)};Object.assign(update,buildEntryUpdate(entries));const w=checkWin(entries);if(w){await handleWin(w,fd,update);return}}
    await updateDoc(roomRef,update); return
  }

  // 혼란
  const conf=checkConfusion(myPkmn)
  for(const msg of conf.msgs){await addLog(msg);await wait(350)}
  if(conf.selfHit){
    const {current_order,turn_count,eot}=await advanceTurn(entries,fd)
    const update={...buildEntryUpdate(entries),current_order,turn_count}
    if(eot){const {msgs,anyFainted}=applyEndOfTurnDamage([entries.p1,entries.p2,entries.p3,entries.p4]);for(const m of msgs){await addLog(m);await wait(280)};Object.assign(update,buildEntryUpdate(entries));const w=checkWin(entries);if(w){await handleWin(w,fd,update);return}}
    await updateDoc(roomRef,update); return
  }

  myPkmn.moves[moveIdx]={...moveData,pp:moveData.pp-1}
  const moveInfo=moves[moveData.name]
  await addLog(`${myPkmn.name}의 ${moveData.name}!`); await wait(300)

  // 다이스
  const diceRoll=rollD10(),diceTs=Date.now()
  await updateDoc(roomRef,{dice_event:{type:"single",slot:mySlot,roll:diceRoll,ts:diceTs}})
  await animateDiceSingle(mySlot,diceRoll,getNamesMap(fd))
  await updateDoc(roomRef,{dice_event:null})

  // 타겟별 처리
  for(const tSlot of targetSlots){
    const tActiveIdx=fd[`${tSlot}_active_idx`]??0
    const tPkmn=entries[tSlot][tActiveIdx]
    if(!tPkmn||tPkmn.hp<=0) continue

    const [en1,en2]=enemySlots(mySlot)
    const tPrefix=tSlot===mySlot?"my":tSlot===allySlot(mySlot)?"ally":tSlot===en1?"enemy1":"enemy2"
    const myPrefix=TEAM_A.includes(mySlot)?"my":"ally"

    if(!moveInfo?.power){
      // 변화기
      const r=moveInfo?.rank
      const toEnemy=r&&(r.targetAtk!==undefined||r.targetDef!==undefined||r.targetSpd!==undefined)
      if(toEnemy){const {hit,hitType}=calcHit(myPkmn,moveInfo,tPkmn);if(!hit){await addLog(hitType==="evaded"?`${tPkmn.name}에게는 맞지 않았다!`:`빗나갔다!`);continue}}
      const rankMsgs=applyRankChanges(moveInfo?.rank??null,myPkmn,tPkmn)
      for(const msg of rankMsgs){await addLog(msg);await wait(300)}
    } else {
      // 공격기
      await triggerAttackEffect(myPrefix,tPrefix)
      const {hit,hitType}=calcHit(myPkmn,moveInfo,tPkmn)
      if(!hit){
        if(hitType==="evaded"){showBattlePopup(tPrefix,"evade");await addLog(`${tPkmn.name}에게는 맞지 않았다!`)}
        else await addLog(`빗나갔다!`)
      } else {
        const atkRank=getActiveRank(myPkmn,"atk"),defRank=getActiveRank(tPkmn,"def")
        const {damage,multiplier,stab,dice,critical}=calcDamage(myPkmn,moveData.name,tPkmn,atkRank,defRank)
        if(multiplier===0){await addLog(`${tPkmn.name}에게는 효과가 없다…`)}
        else{
          await updateDoc(roomRef,{hit_event:{defender:tSlot,ts:Date.now()}})
          triggerBlink(tPrefix)
          await updateDoc(roomRef,{hit_event:null})
          tPkmn.hp=Math.max(0,tPkmn.hp-damage); await wait(400)
          if(multiplier>1){await addLog("효과가 굉장했다!");await wait(280)}
          if(multiplier<1){await addLog("효과가 별로인 듯하다…");await wait(280)}
          if(critical){showBattlePopup(tPrefix,"critical");await addLog("급소에 맞았다!");await wait(280)}
          const effectMsgs=applyMoveEffect(moveInfo?.effect,myPkmn,tPkmn,damage)
          for(const msg of effectMsgs){await addLog(msg);await wait(280)}
          if(moveInfo?.rank){const rMsgs=applyRankChanges(moveInfo.rank,myPkmn,tPkmn);for(const msg of rMsgs){await addLog(msg);await wait(280)}}
          if(tPkmn.hp<=0){await addLog(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`);await wait(300)}
        }
      }
    }
  }

  const expiredMsgs=tickMyRanks(myPkmn)
  for(const msg of expiredMsgs){await addLog(msg);await wait(250)}

  // 즉시 승리 체크
  const winNow=checkWin(entries)

  const {current_order,turn_count,eot}=await advanceTurn(entries,fd)
  const update={...buildEntryUpdate(entries),current_order,turn_count}

  if(eot&&!winNow){
    const {msgs:eotMsgs,anyFainted}=applyEndOfTurnDamage([entries.p1,entries.p2,entries.p3,entries.p4])
    for(const msg of eotMsgs){await addLog(msg);await wait(280)}
    Object.assign(update,buildEntryUpdate(entries))
    const w=checkWin(entries); if(w){await handleWin(w,fd,update);return}
  }

  if(winNow){await handleWin(winNow,fd,update);return}
  await updateDoc(roomRef,update)
}

// ── 승리 체크 / 처리 ─────────────────────────────
function checkWin(entries){
  if(isAllFainted(entries.p1)&&isAllFainted(entries.p2)) return "B"
  if(isAllFainted(entries.p3)&&isAllFainted(entries.p4)) return "A"
  return null
}
async function handleWin(winTeam,data,partialUpdate){
  const update={...(partialUpdate??{}),game_over:true,winner_team:winTeam,current_order:[]}
  await updateDoc(roomRef,update)
  await grantWinCoins(winTeam,data)
  await addLog(`🏆 팀${winTeam}의 승리!`)
}

// ── 유틸 ─────────────────────────────────────────
function deepCopyEntries(data){
  const e={}
  ALL_FS.forEach(s=>{e[s]=(data[`${s}_entry`]??[]).map(p=>({...p,moves:(p.moves??[]).map(m=>({...m})),ranks:{...defaultRanks(),...(p.ranks??{})}}))})
  return e
}
function buildEntryUpdate(entries){const u={};ALL_FS.forEach(s=>{u[`${s}_entry`]=entries[s]});return u}

// ── 채팅 위임 ─────────────────────────────────────
function initChat(){if(typeof window.initDoubleChat==="function")window.initDoubleChat({db,ROOM_ID,myUid,mySlot,isSpectator})}
