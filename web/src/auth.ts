import { api, getBase } from "./api.js";

export type SignInResult = "signed-in" | "closed" | "timeout";

/**
 * Open GitHub sign-in in a popup window and wait for the OAuth round-trip to
 * complete.  Returns "signed-in" when successful, "closed" when the user
 * dismissed the popup, or "timeout" if the window is still open after 5 min.
 *
 * Strategy:
 *   (a) Primary: the callback page posts {type:"tweaklet:signed-in"} to
 *       window.opener via postMessage (same origin).  We verify the origin
 *       before trusting it.
 *   (b) Fallback: poll GET /agent/me every ~1 s.  Advances as soon as the
 *       endpoint returns a user, or as soon as the popup is closed.
 *
 * Callers should call `api.me()` again after this returns "signed-in" to
 * refresh the user state they are tracking.
 */
export function signIn(): Promise<SignInResult> {
  const url = `${getBase()}/auth/login`;
  const popup = window.open(url, "tweaklet-signin", "width=520,height=680");

  return new Promise<SignInResult>((resolve) => {
    // Guard: if the popup couldn't be opened (blocked), fall back immediately.
    if (!popup) {
      resolve("closed");
      return;
    }

    let settled = false;

    function finish(result: SignInResult) {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(pollId);
      clearTimeout(timeoutId);
      resolve(result);
    }

    // (a) postMessage listener — callback page sends this when OAuth succeeds.
    function onMessage(event: MessageEvent) {
      // Security: only trust messages from our own origin.
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "tweaklet:signed-in") {
        finish("signed-in");
      }
    }
    window.addEventListener("message", onMessage);

    // (b) Poll fallback — check /agent/me every second.  Also detects popup
    //     closed-without-auth so we don't hang forever.
    const pollId = setInterval(async () => {
      try {
        if (popup.closed) {
          // Popup was closed — do one final me() check to handle the race
          // where postMessage arrived but the popup already closed.
          const user = await api.me();
          finish(user ? "signed-in" : "closed");
          return;
        }
        const user = await api.me();
        if (user) {
          finish("signed-in");
        }
      } catch {
        // network error — keep polling
      }
    }, 1000);

    // Hard timeout at 5 minutes.
    const timeoutId = setTimeout(() => {
      if (!popup.closed) {
        try { popup.close(); } catch { /* cross-origin close may throw */ }
      }
      finish("timeout");
    }, 5 * 60 * 1000);
  });
}
