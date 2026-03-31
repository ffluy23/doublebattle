// js/doublebattleroom.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, getDoc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

const roomRef = doc(db, "double", ROOM_ID)
let myUid         = null
let myDisplayName = null
let navigated     = false  // ← 중복 이동 방지

const PLAYER_SLOTS = ["player1","player2","player3","player4"]
const SLOT_TO_FS   = { player1:"p1", player2:"p2", player3:"p3", player4:"p4" }

function calcMySlot(room) {
  if(!room || !myUid) return null
  for(const slot of PLAYER_SLOTS) {
    if(room[`${slot}_uid`] === myUid) return slot
  }
  if((room.spectators ?? []).includes(myUid)) return "spectator"
  return null
}

onAuthStateChanged(auth, async user => {
  if(!user) return
  myUid = user.uid

  const userSnap    = await getDoc(doc(db, "users", myUid))
  const userData    = userSnap.data()
  const nickname    = userData?.nickname ?? myUid.slice(0,6)
  const activeTitle = userData?.activeTitle ?? null
  myDisplayName     = activeTitle ? `[${activeTitle}] ${nickname}` : nickname

  await joinRoom()
  listenRoom()
  setupButtons()
})

async function joinRoom() {
  const snap = await getDoc(roomRef)
  const room = snap.data()
  if(!room) return
  if(calcMySlot(room)) return  // 이미 이 방에 있음

  if(room.game_started) { await joinAsSpectator(room); return }

  // 빈 플레이어 슬롯 찾기
  for(const slot of PLAYER_SLOTS) {
    if(!room[`${slot}_uid`]) {
      await updateDoc(roomRef, {
        [`${slot}_uid`]:  myUid,
        [`${slot}_name`]: myDisplayName
      })
      return
    }
  }
  await joinAsSpectator(room)
}

async function joinAsSpectator(room) {
  const spectators = room.spectators ?? []
  if(spectators.includes(myUid)) return
  await updateDoc(roomRef, {
    spectators:      [...spectators, myUid],
    spectator_names: [...(room.spectator_names ?? []), myDisplayName]
  })
}

function listenRoom() {
  onSnapshot(roomRef, async snap => {
    const room = snap.data()
    if(!room) return

    const mySlot = calcMySlot(room)

    // 플레이어 이름 + 레디 상태 표시
    PLAYER_SLOTS.forEach(slot => {
      const nameEl  = document.getElementById(slot)
      const readyEl = document.getElementById(`${slot}-ready`)
      if(nameEl)  nameEl.innerText  = `${slot.replace("player","Player")}: ${room[`${slot}_name`] ?? "대기 중..."}`
      if(readyEl) readyEl.innerText = room[`${slot}_ready`] ? "✅" : "⬜"
    })

    // 관전자
    const spectEl = document.getElementById("spectator-list")
    if(spectEl) {
      const names = room.spectator_names ?? []
      spectEl.innerText = names.length > 0 ? "관전자: " + names.join(", ") : "관전자 없음"
    }

    updateButtons(room, mySlot)

    // 4명 레디 → 엔트리 업로드 → game_started
    const allReady = PLAYER_SLOTS.every(s => room[`${s}_ready`])
    if(allReady && !room.game_started && mySlot && mySlot !== "spectator") {
      // 엔트리 먼저 업로드 (4명 각자)
      await copyMyEntry(mySlot)

      // player1만 game_started 세팅
      // 단, 4명의 엔트리가 모두 올라왔는지 확인 후 세팅
      if(mySlot === "player1") {
        // 최신 상태 다시 읽어서 4명 엔트리 확인
        let retries = 0
        while(retries < 10) {
          const freshSnap = await getDoc(roomRef)
          const freshRoom = freshSnap.data()
          const allUploaded = PLAYER_SLOTS.every(s => freshRoom[`${SLOT_TO_FS[s]}_entry`] !== null)
          if(allUploaded) {
            await updateDoc(roomRef, {
              game_started:     true,
              game_started_at:  Date.now(),
              round_count:      0,
              turn_count:       0,
              current_order:    [],
              pending_switches: []
            })
            break
          }
          // 아직 안 올라왔으면 500ms 대기 후 재시도
          await new Promise(r => setTimeout(r, 500))
          retries++
        }
      }
    }

    // 게임 시작 → 배틀 화면으로 이동
    // 4명 엔트리가 모두 올라온 경우에만 이동
    if(room.game_started && mySlot) {
      const allEntryReady = PLAYER_SLOTS.every(s => room[`${SLOT_TO_FS[s]}_entry`] !== null)
      if(!allEntryReady) return  // 아직 엔트리 업로드 안 끝난 경우 대기

      if(navigated) return  // 중복 이동 방지
      navigated = true

      const num  = ROOM_ID.replace("doublebattleroom","")
      const dest = mySlot === "spectator"
        ? `../games/doublebattleroom${num}.html?spectator=true`
        : `../games/doublebattleroom${num}.html`
      location.href = dest
    }
  })
}

async function copyMyEntry(mySlot) {
  const fsSlot   = SLOT_TO_FS[mySlot]
  const userSnap = await getDoc(doc(db, "users", myUid))
  const entry    = userSnap.data()?.entry ?? []
  const entryWithMax = entry.map(p => ({ ...p, maxHp: p.hp }))
  await updateDoc(roomRef, {
    [`${fsSlot}_entry`]:      entryWithMax,
    [`${fsSlot}_active_idx`]: 0
  })
}

function updateButtons(room, mySlot) {
  const isPlayer    = mySlot && mySlot !== "spectator"
  const isSpectator = mySlot === "spectator"

  const readyBtn = document.getElementById("readyBtn")
  const swapBtn  = document.getElementById("swapBtn")
  const leaveBtn = document.getElementById("leaveBtn")

  if(readyBtn) {
    readyBtn.style.display = isPlayer ? "inline-block" : "none"
    if(isPlayer) {
      const alreadyReady = !!room[`${mySlot}_ready`]
      readyBtn.disabled  = alreadyReady
      readyBtn.innerText = alreadyReady ? "Ready ✅" : "Ready"
    }
  }
  if(swapBtn)  swapBtn.style.display  = isSpectator ? "inline-block" : "none"
  if(leaveBtn) leaveBtn.disabled      = isPlayer && !!room.game_started
}

function setupButtons() {
  // Ready
  document.getElementById("readyBtn").onclick = async () => {
    const snap   = await getDoc(roomRef)
    const mySlot = calcMySlot(snap.data())
    if(!mySlot || mySlot === "spectator") return
    await updateDoc(roomRef, { [`${mySlot}_ready`]: true })
  }

  // Leave
  document.getElementById("leaveBtn").onclick = async () => {
    const snap   = await getDoc(roomRef)
    const room   = snap.data()
    const mySlot = calcMySlot(room)
    if(mySlot && mySlot !== "spectator" && room.game_started) {
      alert("도망칠 수 없다!"); return
    }
    await leaveRoom(mySlot, room)
  }

  // Swap (관전자 → 빈 자리로)
  const swapBtn = document.getElementById("swapBtn")
  if(swapBtn) {
    swapBtn.onclick = async () => {
      const snap = await getDoc(roomRef)
      const room = snap.data()
      for(const slot of PLAYER_SLOTS) {
        if(!room[`${slot}_uid`]) {
          await promoteToPlayer(slot, room); return
        }
      }
      alert("빈 자리가 없어요")
    }
  }
}

async function leaveRoom(mySlot, room) {
  if(mySlot && mySlot !== "spectator") {
    const spectators     = room.spectators ?? []
    const spectatorNames = room.spectator_names ?? []
    if(spectators.length > 0) {
      const idx = Math.floor(Math.random() * spectators.length)
      await updateDoc(roomRef, {
        [`${mySlot}_uid`]:   spectators[idx],
        [`${mySlot}_name`]:  spectatorNames[idx],
        [`${mySlot}_ready`]: false,
        spectators:      spectators.filter((_,i)=>i!==idx),
        spectator_names: spectatorNames.filter((_,i)=>i!==idx)
      })
    } else {
      await updateDoc(roomRef, {
        [`${mySlot}_uid`]:   null,
        [`${mySlot}_name`]:  null,
        [`${mySlot}_ready`]: false
      })
    }
  } else {
    await updateDoc(roomRef, {
      spectators:      (room.spectators ?? []).filter(u => u !== myUid),
      spectator_names: (room.spectator_names ?? []).filter(n => n !== myDisplayName)
    })
  }
  location.href = "../main.html"
}

async function promoteToPlayer(targetSlot, room) {
  const spectators     = room.spectators ?? []
  const spectatorNames = room.spectator_names ?? []
  await updateDoc(roomRef, {
    [`${targetSlot}_uid`]:   myUid,
    [`${targetSlot}_name`]:  myDisplayName,
    spectators:      spectators.filter(u => u !== myUid),
    spectator_names: spectatorNames.filter(n => n !== myDisplayName)
  })
}
