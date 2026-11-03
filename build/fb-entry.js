// Re-exports only the Firebase pieces the engine uses, so the bundle stays small.
export { initializeApp } from 'firebase/app';
export {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from 'firebase/auth/web-extension';
export {
  getDatabase, ref, set, update, push, remove, get,
  onValue, onChildAdded, onDisconnect, serverTimestamp,
  query, limitToLast, orderByChild, startAt, endAt
} from 'firebase/database';
