"use client";

import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { useFirebaseSession } from "@/lib/firebase/hooks";
import { useSession } from "@/lib/store/session";
import { retrieveGoogleToken } from "@/lib/firebase/client";

function FirebaseInit() {
  useFirebaseSession();
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  // Restore Google token from localStorage on mount.
  // localStorage persists across tabs and browser restarts (unlike sessionStorage),
  // so the token survives when Firebase auto-restores the auth session in a new tab.
  // retrieveGoogleToken() also validates expiry — stale tokens are discarded.
  useEffect(() => {
    const googleToken = retrieveGoogleToken();
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
