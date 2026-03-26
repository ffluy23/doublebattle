import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import { 
getAuth 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import { 
getFirestore 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


const firebaseConfig = {
apiKey: "AIzaSyAIlbD71SVNQqTlwiRQu_SYcRaVV9dlnOo",
authDomain: "pokemon-ad8e5.firebaseapp.com",
projectId: "pokemon-ad8e5",
storageBucket: "pokemon-ad8e5.firebasestorage.app",
messagingSenderId: "4560115033",
appId: "1:4560115033:web:dde5ad6df32648ac01e848"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
