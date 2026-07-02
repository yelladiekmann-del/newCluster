# Setup Guide

## Stack

| Layer | Technologie |
|---|---|
| Frontend + API Routes | Next.js 16 (App Router), React 19, TypeScript |
| Hosting | Firebase App Hosting (auto-deploy via GitHub) |
| Datenbank | Firestore |
| File Storage | Firebase Storage |
| Auth | Firebase Auth (Google SSO) |
| ML-Service | Python 3.11, FastAPI → Google Cloud Run |
| AI | Gemini 2.5 Flash (Google AI Studio) |
| Externe APIs | Google Drive, Sheets, Slides (User-OAuth-Token) |

---

## Repo-Struktur

```
/
├── web/          ← Next.js App
├── cloud-run/    ← Python FastAPI Service (Dockerfile)
└── firebase.json + rules
```

---

## Setup-Schritte

### 1. Firebase-Projekt

1. Neues Projekt unter [console.firebase.google.com](https://console.firebase.google.com)
2. Authentication → Google-Provider aktivieren
3. Firestore + Storage aktivieren
4. App Hosting aktivieren → GitHub-Repo verknüpfen, Branch wählen

```bash
npm install -g firebase-tools && firebase login
firebase deploy --only firestore:rules,storage:rules
```

Domain-Whitelist in `firestore.rules` / `storage.rules` auf die eigene Domain anpassen.

### 2. Cloud Run Service

```bash
cd cloud-run
gcloud builds submit --tag gcr.io/<PROJECT_ID>/ml-service
gcloud run deploy ml-service --region europe-west1 --no-allow-unauthenticated
```

### 3. API Keys

Werden benötigt und müssen selbst erstellt werden:
- **Firebase Config** — Console → Projekteinstellungen → Deine Apps
- **Gemini API Key** — [aistudio.google.com](https://aistudio.google.com)
- **Google Slides Template ID** — eigenes Template anlegen, ID aus der URL

Lokal in `web/.env.local` eintragen, in Produktion als Secrets in der App Hosting Console hinterlegen.

---

## Lokale Entwicklung

```bash
cd web && npm install && npm run dev
# → http://localhost:3000
```

## Deployment

Jeder Push auf den verknüpften Branch triggert automatisch einen Build:

```bash
git push origin <branch>
```
