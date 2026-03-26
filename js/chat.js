// chat.js - 더블배틀 팀별 격리 채팅
// battle.js에서 window.initDoubleChat({ db, ROOM_ID, myUid, mySlot, isSpectator }) 호출

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

function getChatChannel(mySlot, isSpectator) {
  if(isSpectator||!mySlot) return "spectator"
  if(mySlot==="p1"||mySlot==="p2") return "teamA"
  if(mySlot==="p3"||mySlot==="p4") return "teamB"
  return "spectator"
}

function formatMessage(text) {
  // () 안 내용 → 회색 이탤릭
  return text.replace(/\((.+?)\)/g,'<span class="chat-action">($1)</span>')
}

function appendMessage(container, nickname, text) {
  const div=document.createElement("div"); div.className="chat-message"
  div.innerHTML=`<span class="chat-nick">${nickname}:</span> ${formatMessage(text)}`
  container.appendChild(div); container.scrollTop=container.scrollHeight
}

window.initDoubleChat=function({db, ROOM_ID, myUid, mySlot, isSpectator}){
  const channel=getChatChannel(mySlot,isSpectator)
  const ref=collection(db,"double",ROOM_ID,`chat_${channel}`)
  const rendered=new Set()

  // 채널 라벨
  const labelEl=document.getElementById("chat-channel-label")
  const labelMap={teamA:"🔵 팀A 채팅",teamB:"🔴 팀B 채팅",spectator:"👁 관전자 채팅"}
  if(labelEl) labelEl.innerText=labelMap[channel]??"채팅"

  const container=document.getElementById("chat-messages")
  if(!container) return

  // 실시간 수신
  const q=query(ref,orderBy("ts"))
  onSnapshot(q,snap=>{
    snap.docs.forEach(d=>{
      if(rendered.has(d.id)) return
      rendered.add(d.id)
      const {nickname,text}=d.data()
      appendMessage(container,nickname,text)
    })
  })

  // 전송
  async function sendChat(){
    const input=document.getElementById("chat-input"); if(!input) return
    const text=input.value.trim(); if(!text) return
    const nickname=window.__myDisplayName??myUid.slice(0,6)
    await addDoc(ref,{uid:myUid,nickname,text,ts:Date.now()})
    input.value=""
  }

  const sendBtn=document.getElementById("chat-send-btn")
  if(sendBtn) sendBtn.onclick=sendChat

  const inputEl=document.getElementById("chat-input")
  if(inputEl) inputEl.addEventListener("keypress",e=>{if(e.key==="Enter") sendChat()})
}
