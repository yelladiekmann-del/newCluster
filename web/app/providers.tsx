"use client";

import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { useFirebaseSession } from "@/lib/firebase/hooks";
import { useSession } from "@/lib/store/session";

function FirebaseInit() {
  useFirebaseSession();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Restore API key + Google token from sessionStorage on mount
  useEffect(() => {
    const stored = sessionStorage.getItem("hy_gemini_key");
    if (stored) useSession.getState().setApiKey(stored);

    const googleToken = sessionStorage.getItem("hy_google_token");
    if (googleToken) useSession.getState().setGoogleAccessToken(googleToken);
  }, []);

  return (
    <>
      <FirebaseInit />
      {children}
      <Toaster theme="dark" richColors position="bottom-right" />
    </>
  );
}
