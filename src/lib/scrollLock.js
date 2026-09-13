import { useEffect } from "react";

// Body scroll lock for modal overlays.
//
// None of the app's 10 fixed-position overlays locked the page behind
// them, so scrolling past a modal's content dragged the page underneath
// instead — and closing the modal left you somewhere else entirely in a
// long exercise list. The inner cards already set overscrollBehavior:
// "contain", which stops the bleed only while the pointer is over
// scrollable modal content; a drag starting on the backdrop, or on a
// modal shorter than the viewport, still scrolled the page.
//
// `overflow: hidden` on <body> alone is unreliable on iOS, which happily
// scrolls the document anyway. The position:fixed + negative-top
// technique is what actually holds there, at the cost of having to
// restore scroll position by hand on release — hence the saved offset.
//
// Reference-counted because more than one lock can be live at once (a
// picker opened from inside another modal, or a modal open while a
// transition unmounts another). Without the count, the first one to
// close would unlock the page while the second was still up.

let lockCount = 0;
let savedScrollY = 0;

function applyLock() {
  savedScrollY = window.scrollY || window.pageYOffset || 0;
  const b = document.body.style;
  b.position = "fixed";
  b.top = `-${savedScrollY}px`;
  b.left = "0";
  b.right = "0";
  b.width = "100%";
  b.overflow = "hidden";
}

function releaseLock() {
  const b = document.body.style;
  b.position = "";
  b.top = "";
  b.left = "";
  b.right = "";
  b.width = "";
  b.overflow = "";
  // Instant, not smooth — this is restoring where you already were, so
  // animating it would look like the page jumped and then drifted.
  window.scrollTo(0, savedScrollY);
}

export function lockBodyScroll() {
  if (typeof document === "undefined") return;
  lockCount += 1;
  if (lockCount === 1) applyLock();
}

export function unlockBodyScroll() {
  if (typeof document === "undefined") return;
  lockCount -= 1;
  if (lockCount <= 0) {
    lockCount = 0;
    releaseLock();
  }
}

// Convenience hook — pass a boolean that's true whenever ANY modal in
// the calling component is open. One call per component beats wiring
// each overlay separately, and the ref-count above makes overlapping
// components safe.
export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [active]);
}
