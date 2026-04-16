"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let storage: FirebaseStorage;

function getFirebaseApp(): FirebaseApp {
  if (!app) {
    app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    auth = getAuth(getFirebaseApp());
  }
  return auth;
}

export function getFirebaseDb(): Firestore {
  if (!db) {
    db = getFirestore(getFirebaseApp());
  }
  return db;
}

export function getFirebaseStorage(): FirebaseStorage {
  if (!storage) {
    storage = getStorage(getFirebaseApp());
  }
  return storage;
}

/** Sign in with Google (Sheets + Drive + Slides scopes). Only @hy.co accounts are allowed. */
export async function signInWithGoogle(): Promise<{ user: User; accessToken: string | null }> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: "hy.co" }); // UX hint — real check is below
  provider.addScope("https://www.googleapis.com/auth/spreadsheets");
  provider.addScope("https://www.googleapis.com/auth/drive.file");
  provider.addScope("https://www.googleapis.com/auth/presentations");
  const cred = await signInWithPopup(getFirebaseAuth(), provider);
  if (!cred.user.email?.endsWith("@hy.co")) {
    await fbSignOut(getFirebaseAuth());
    throw new Error("Only @hy.co accounts are allowed.");
  }
  const oauthCred = GoogleAuthProvider.credentialFromResult(cred);
  return { user: cred.user, accessToken: oauthCred?.accessToken ?? null };
}

/**
 * Request additional Google OAuth scopes for users who signed in before the
 * Slides scope was added. Triggers a Google consent popup for the missing scope
 * and returns a fresh access token that includes it.
 */
export async function requestSlidesAccess(): Promise<string | null> {
  const provider = new GoogleAuthProvider();
  provider.addScope("https://www.googleapis.com/auth/presentations");
  provider.addScope("https://www.googleapis.com/auth/drive.file");
  const cred = await signInWithPopup(getFirebaseAuth(), provider);
  const oauthCred = GoogleAuthProvider.credentialFromResult(cred);
  return oauthCred?.accessToken ?? null;
}

/** Sign out the current user. */
export async function signOutUser(): Promise<void> {
  await fbSignOut(getFirebaseAuth());
}

/** Subscribe to auth state changes. Returns unsubscribe function. */
export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), callback);
}
