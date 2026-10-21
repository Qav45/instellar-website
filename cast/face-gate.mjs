// When the decoy is up. Kept free of imports and of the DOM so it can be tested
// on its own: face-guard.mjs says, once per camera frame, whether somebody who
// should trigger it is in view, and this decides when to show and when to put
// things back.
//
// Showing is immediate. Putting back waits until nobody flagged has been seen
// for revertMs, so a head turn or a missed detection does not flash the real
// screen at someone who is still standing there.

export function createGate({ revertMs = 1500, show, hide }) {
  let shown = false;
  let lastFlagged = 0;
  return {
    feed(flagged, now) {
      if (flagged) {
        lastFlagged = now;
        if (!shown) { shown = true; show(); }
      } else if (shown && now - lastFlagged >= revertMs) {
        shown = false;
        hide();
      }
    },
    // Put everything back at once (guard switched off), whatever the timer says.
    reset() {
      if (shown) { shown = false; hide(); }
    },
    get shown() { return shown; },
  };
}
