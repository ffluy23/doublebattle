// battleroom.js (더블배틀 4인 버전)

import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import { doc, getDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

const roomRef = doc(db, "double", ROOM_ID)
let myUid = null, myNickname = null, myDisplayName = null

const PLAYER_SLOTS = ["player1","player2","player3","player4"]
function isPlayerSlot(s) { return PLAYER_SLOTS.includes(s) }
function fsSlot(s) { return s.replace("player","p") }   // player1 → p1

function calcMySlot(room) {
  if(!room||!myUid) return null
  for(const s of PLAYER_SLOTS){ if(room[`${s}_uid`]===myUid) return s }
  if((room.spectators??[]).includes(myUid)) return "spectator"
  return null
}

onAuthStateChanged(auth, async user=>{
  if(!user) return
  myUid=user.uid
  const userSnap=await getDoc(doc(db,"users",myUid))
  const userData=userSnap.data()
  myNickname=userData.nickname
  const activeTitle=userData?.activeTitle??null
  myDisplayName=activeTitle?`[${activeTitle}] ${myNickname}`:myNickname

  const userRoomNum=userData?.room
  const userRoomId=userRoomNum?`battleroom${userRoomNum}`:null
  if(userRoomId&&userRoomId!==ROOM_ID){
    const snap=await getDoc(doc(db,"double",userRoomId))
    const activeRoom=snap.data()
    if(activeRoom?.game_started){
      const isPlayer=PLAYER_SLOTS.some(s=>activeRoom[`${s}_uid`]===myUid)
      if(isPlayer){alert(`현재 battleroom${userRoomNum}에서 게임 중입니다.`);location.href=`../games/battleroom${userRoomNum}.html`;return}
    }
  }

  await joinRoom()
  listenRoom()
  setupButtons()
})

async function joinRoom(){
  const roomSnap=await getDoc(roomRef),room=roomSnap.data()
  if(calcMySlot(room)) return
  if(room.game_started){await joinAsSpectator(room);return}
  for(const s of PLAYER_SLOTS){
    if(!room[`${s}_uid`]){await updateDoc(roomRef,{[`${s}_uid`]:myUid,[`${s}_name`]:myDisplayName});return}
  }
  await joinAsSpectator(room)
}

async function joinAsSpectator(room){
  const spectators=room.spectators??[]
  if(spectators.includes(myUid)) return
  await updateDoc(roomRef,{spectators:[...spectators,myUid],spectator_names:[...(room.spectator_names??[]),myDisplayName]})
}

function listenRoom(){
  onSnapshot(roomRef, async snap=>{
    const room=snap.data(); if(!room) return
    const mySlot=calcMySlot(room)

    // 이름 & 레디 배지
    PLAYER_SLOTS.forEach((s,i)=>{
      const nameEl=document.getElementById(s); if(nameEl) nameEl.innerText=`${s.replace("player","Player ")}: `+(room[`${s}_name`]??"대기...")

    })

    renderSpectators(room)
    renderSwapRequest(room,mySlot)
    updateButtonsBySlot(room,mySlot)

    // 4명 모두 레디 & 슬롯 찼을 때
    const allReady=PLAYER_SLOTS.every(s=>room[`${s}_ready`])
    const allFilled=PLAYER_SLOTS.every(s=>room[`${s}_uid`])

    if(allReady&&allFilled&&!room.game_started){
      if(isPlayerSlot(mySlot)){
        const fs=fsSlot(mySlot)
        const userSnap=await getDoc(doc(db,"users",myUid))
        const myEntry=(userSnap.data()?.entry??[]).map(p=>({...p,maxHp:p.hp}))
        await updateDoc(roomRef,{[`${fs}_entry`]:myEntry,[`${fs}_active_idx`]:0})
        if(mySlot==="player1") await updateDoc(roomRef,{game_started:true})
      }
    }

    if(room.game_started&&mySlot){
      const roomNumber=ROOM_ID.replace("doublebattleroom","")
      const param=mySlot==="spectator"?"?spectator=true":""
      location.href=`../games/battleroom${roomNumber}.html${param}`
    }
  })
}

function updateButtonsBySlot(room,mySlot){
  const isPlayer=isPlayerSlot(mySlot),isSpec=mySlot==="spectator"
  const readyBtn=document.getElementById("readyBtn"),swapBtn=document.getElementById("swapBtn"),leaveBtn=document.getElementById("leaveBtn")
  if(readyBtn) readyBtn.style.display=isPlayer?"inline-block":"none"
  if(swapBtn)  swapBtn.style.display=isSpec?"inline-block":"none"
  if(leaveBtn) leaveBtn.disabled=isPlayer&&!!room.game_started
}

function renderSpectators(room){
  const el=document.getElementById("spectator-list"); if(!el) return
  const names=room.spectator_names??[]
  el.innerText=names.length>0?"관전자: "+names.join(", "):"관전자 없음"
}

function renderSwapRequest(room,mySlot){
  const req=room.swap_request,el=document.getElementById("swap-request-display")
  if(!el) return
  if(!req){el.innerHTML="";return}
  const isTarget=req.toSlot===mySlot
  if(isTarget&&req.from!==myUid){
    el.innerHTML=`<p>${req.fromName}님이 ${req.toSlot} 자리 교체를 요청했습니다.</p><button onclick="window.acceptSwap()">수락</button><button onclick="window.rejectSwap()">거절</button>`
  } else if(req.from===myUid){
    el.innerHTML=`<p>${req.toSlot} 자리 교체 요청 중...</p>`
  } else {
    el.innerHTML=""
  }
}

async function requestSwap(targetSlot){
  const roomSnap=await getDoc(roomRef),room=roomSnap.data()
  if(!room[`${targetSlot}_uid`]){await promoteToPlayer(targetSlot);return}
  await updateDoc(roomRef,{swap_request:{from:myUid,fromName:myDisplayName,toSlot:targetSlot}})
}

window.acceptSwap=async function(){
  const roomSnap=await getDoc(roomRef),room=roomSnap.data()
  const req=room.swap_request; if(!req) return
  const mySlot=calcMySlot(room)
  const spectators=room.spectators??[],spectatorNames=room.spectator_names??[]
  if(isPlayerSlot(mySlot)&&mySlot===req.toSlot){
    // 플레이어 ↔ 관전자
    await updateDoc(roomRef,{[`${req.toSlot}_uid`]:req.from,[`${req.toSlot}_name`]:req.fromName,spectators:[...spectators.filter(u=>u!==req.from),myUid],spectator_names:[...spectatorNames.filter(n=>n!==req.fromName),myDisplayName],swap_request:null})
  } else if(isPlayerSlot(mySlot)){
    // 플레이어 ↔ 플레이어
    await updateDoc(roomRef,{[`${req.toSlot}_uid`]:myUid,[`${req.toSlot}_name`]:myDisplayName,[`${mySlot}_uid`]:req.from,[`${mySlot}_name`]:req.fromName,swap_request:null})
  }
}
window.rejectSwap=async function(){ await updateDoc(roomRef,{swap_request:null}) }

async function promoteToPlayer(targetSlot){
  const roomSnap=await getDoc(roomRef),room=roomSnap.data()
  const spectators=room.spectators??[],spectatorNames=room.spectator_names??[]
  await updateDoc(roomRef,{[`${targetSlot}_uid`]:myUid,[`${targetSlot}_name`]:myDisplayName,spectators:spectators.filter(u=>u!==myUid),spectator_names:spectatorNames.filter(n=>n!==myDisplayName)})
}

function setupButtons(){
  document.getElementById("readyBtn").onclick=async()=>{
    const roomSnap=await getDoc(roomRef),mySlot=calcMySlot(roomSnap.data())
    if(isPlayerSlot(mySlot)) await updateDoc(roomRef,{[`${mySlot}_ready`]:true})
  }
  document.getElementById("leaveBtn").onclick=async()=>{
    const roomSnap=await getDoc(roomRef),room=roomSnap.data(),mySlot=calcMySlot(room)
    if(isPlayerSlot(mySlot)&&room.game_started){alert("도망칠 수 없다!");return}
    await leaveRoom(mySlot,room)
  }
  const swapBtn=document.getElementById("swapBtn")
  if(swapBtn) swapBtn.onclick=async()=>{
    const roomSnap=await getDoc(roomRef),room=roomSnap.data()

    // 빈 슬롯 있으면 바로 승격
    for(const s of PLAYER_SLOTS){if(!room[`${s}_uid`]){await requestSwap(s);return}}

    // 전부 찼으면 버튼으로 선택
    showSwapTargetUI(room)
  }
}

function showSwapTargetUI(room) {
  // 기존 UI 있으면 제거
  const existing=document.getElementById("swap-target-ui")
  if(existing) existing.remove()

  const wrap=document.createElement("div")
  wrap.id="swap-target-ui"
  wrap.style.cssText="margin-top:10px;display:flex;flex-direction:column;gap:8px;"

  const label=document.createElement("p")
  label.innerText="어느 자리로 가고 싶어?"
  label.style.cssText="font-size:13px;color:#555;margin-bottom:2px;"
  wrap.appendChild(label)

  const btnRow=document.createElement("div")
  btnRow.style.cssText="display:flex;gap:8px;flex-wrap:wrap;"

  PLAYER_SLOTS.forEach(s=>{
    const name=room[`${s}_name`]
    if(!name) return  // 빈 슬롯은 이미 위에서 처리됨
    const btn=document.createElement("button")
    btn.innerText=`${s.replace("player","P")} (${name})`
    btn.style.cssText="padding:7px 14px;background:#4a9eff;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;"
    btn.onclick=async()=>{
      wrap.remove()
      await requestSwap(s)
    }
    btnRow.appendChild(btn)
  })

  const cancelBtn=document.createElement("button")
  cancelBtn.innerText="취소"
  cancelBtn.style.cssText="padding:7px 14px;background:#bbb;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;"
  cancelBtn.onclick=()=>wrap.remove()
  btnRow.appendChild(cancelBtn)

  wrap.appendChild(btnRow)

  // swap-request-display 밑에 삽입
  const anchor=document.getElementById("swap-request-display")
  if(anchor) anchor.after(wrap)
  else document.querySelector(".room-container")?.appendChild(wrap)
}

async function leaveRoom(mySlot,room){
  if(isPlayerSlot(mySlot)){
    const spectators=room.spectators??[],spectatorNames=room.spectator_names??[]
    if(spectators.length>0){
      const randIdx=Math.floor(Math.random()*spectators.length)
      await updateDoc(roomRef,{[`${mySlot}_uid`]:spectators[randIdx],[`${mySlot}_name`]:spectatorNames[randIdx],[`${mySlot}_ready`]:false,spectators:spectators.filter((_,i)=>i!==randIdx),spectator_names:spectatorNames.filter((_,i)=>i!==randIdx)})
    } else {
      await updateDoc(roomRef,{[`${mySlot}_uid`]:null,[`${mySlot}_name`]:null,[`${mySlot}_ready`]:false})
    }
  } else {
    await updateDoc(roomRef,{spectators:(room.spectators??[]).filter(u=>u!==myUid),spectator_names:(room.spectator_names??[]).filter(n=>n!==myDisplayName)})
  }
  location.href="../main.html"
}
