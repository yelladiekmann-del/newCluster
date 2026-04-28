/**
 * Returns the server-side Gemini API key from the environment.
 * Set GEMINI_API_KEY in .env.local (dev) and Firebase App Hosting env vars (prod).
 */
export function getGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY environment variable is not set. " +
      "Add it to .env.local for local dev, and to Firebase App Hosting environment variables for production."
    );
  }
  return key;
}
