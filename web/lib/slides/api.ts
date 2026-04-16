/**
 * Thin wrappers over the Google Slides REST API v1 and Drive API v3.
 * All functions throw on non-2xx responses so callers can .catch(() => {}).
 */

const SLIDES_BASE = "https://slides.googleapis.com/v1/presentations";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3/files";

function authHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function checkOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`${label} ${res.status}: ${body}`);
  }
}

/** Copy a Drive file (e.g. a Slides template) into the user's Drive. */
export async function copyDriveFile(
  token: string,
  fileId: string,
  name: string
): Promise<{ id: string; url: string }> {
  const res = await fetch(`${DRIVE_BASE}/${fileId}/copy`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ name }),
  });
  await checkOk(res, "Drive copy");
  const data = await res.json();
  return {
    id: data.id as string,
    url: `https://docs.google.com/presentation/d/${data.id}/edit`,
  };
}

export interface SlideElement {
  objectId: string;
  [key: string]: unknown;
}

export interface SlideInfo {
  objectId: string;
  pageElements?: SlideElement[];
}

export interface PresentationInfo {
  slides: SlideInfo[];
}

/** Fetch top-level presentation metadata (slides + pageElements). */
export async function getPresentation(
  token: string,
  presentationId: string
): Promise<PresentationInfo> {
  const res = await fetch(`${SLIDES_BASE}/${presentationId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await checkOk(res, "Slides get");
  return res.json() as Promise<PresentationInfo>;
}

/** Execute a list of batchUpdate requests against a presentation. */
export async function slidesBatchUpdate(
  token: string,
  presentationId: string,
  requests: object[]
): Promise<void> {
  const res = await fetch(`${SLIDES_BASE}/${presentationId}:batchUpdate`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ requests }),
  });
  await checkOk(res, "Slides batchUpdate");
}
