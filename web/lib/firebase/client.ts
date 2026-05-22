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

/** Sign in with Google (Sheets scope). Only @hy.co accounts are allowed. */
export async function signInWithGoogle(): Promise<{ user: User; accessToken: string | null }> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: "hy.co" }); // UX hint — real check is below
  provider.addScope("https://www.googleapis.com/auth/spreadsheets");
  const cred = await signInWithPopup(getFirebaseAuth(), provider);
  if (!cred.user.email?.endsWith("@hy.co")) {
    await fbSignOut(getFirebaseAuth());
    throw new Error("Only @hy.co accounts are allowed.");
  }
  const oauthCred = GoogleAuthProvider.credentialFromResult(cred);
  return { user: cred.user, accessToken: oauthCred?.accessToken ?? null };
}

/** Sign out the current user. */
export async function signOutUser(): Promise<void> {
  await fbSignOut(getFirebaseAuth());
}

/** Subscribe to auth state changes. Returns unsubscribe function. */
export function onAuthChange(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), callback);
}

// ── Google OAuth token persistence ───────────────────────────────────────────
//
// The Google access token (needed for Sheets API) is separate from the Firebase
// auth session. Firebase persists its own session in IndexedDB and auto-restores
// it across tabs/restarts — but the Google OAuth token was previously stored only
// in sessionStorage, which is per-tab. Opening a new tab would lose the token
// even though the user was still "signed in".
//
// We now use localStorage so the token survives across tabs and browser restarts.
// We also track expiry (Google access tokens last 60 min; we use 55 min to be safe)
// so stale tokens are never silently served to the Sheets API.

const GOOGLE_TOKEN_KEY = "hy_google_token";
const GOOGLE_TOKEN_EXP_KEY = "hy_google_token_exp";
/** 55 minutes — 5-minute safety margin before Google's 60-minute expiry. */
const TOKEN_LIFETIME_MS = 55 * 60 * 1000;

/** Store a fresh Google OAuth access token (localStorage + expiry). */
export function persistGoogleToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(GOOGLE_TOKEN_KEY, token);
  localStorage.setItem(GOOGLE_TOKEN_EXP_KEY, String(Date.now() + TOKEN_LIFETIME_MS));
}

/**
 * Retrieve the stored Google OAuth token.
 * Returns null if the token is missing or expired (and clears the stale entry).
 */
export function retrieveGoogleToken(): string | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem(GOOGLE_TOKEN_KEY);
  if (!token) return null;
  const exp = Number(localStorage.getItem(GOOGLE_TOKEN_EXP_KEY) ?? "0");
  if (exp && Date.now() > exp) {
    clearGoogleToken();
    return null;
  }
  return token;
}

/** Remove the stored token (called on sign-out or detected expiry). */
export function clearGoogleToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(GOOGLE_TOKEN_KEY);
  localStorage.removeItem(GOOGLE_TOKEN_EXP_KEY);
}
