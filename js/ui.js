// Haptic feedback and motion helpers.
// In the Android app haptics go through Capacitor's Haptics plugin; in browsers we fall back to
// navigator.vibrate where it exists. Everything respects the "reduce motion" system setting.

const cap = () => window.Capacitor;
const native = () => !!cap()?.isNativePlatform?.();
export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let hapticsOn = true;
export function setHaptics(on) { hapticsOn = on !== false; }

function nativeHaptic(method, options = {}) {
  try { cap().nativePromise('Haptics', method, options).catch(() => {}); } catch { /* ignore */ }
}
function vibrate(ms) { try { navigator.vibrate?.(ms); } catch { /* ignore */ } }

// Short, distinct feedback for different kinds of actions.
export const haptic = {
  tap()       { if (!hapticsOn) return; native() ? nativeHaptic('impact', { style: 'LIGHT' }) : vibrate(8); },
  select()    { if (!hapticsOn) return; native() ? nativeHaptic('selectionChanged') : vibrate(5); },
  shutter()   { if (!hapticsOn) return; native() ? nativeHaptic('impact', { style: 'MEDIUM' }) : vibrate(14); },
  success()   { if (!hapticsOn) return; native() ? nativeHaptic('notification', { type: 'SUCCESS' }) : vibrate([10, 40, 18]); },
  warning()   { if (!hapticsOn) return; native() ? nativeHaptic('notification', { type: 'WARNING' }) : vibrate([20, 60, 20]); },
  found()     { if (!hapticsOn) return; native() ? nativeHaptic('impact', { style: 'LIGHT' }) : vibrate(6); },
};

// Selection haptics on Android need a start call before selectionChanged.
export function primeSelection() { if (native() && hapticsOn) nativeHaptic('selectionStart'); }

// Fade/slide the view in after a route change. One short movement, nothing on reduced motion.
export function enterView(el) {
  if (reducedMotion()) return;
  el.classList.remove('view-enter');
  void el.offsetWidth;   // restart the animation
  el.classList.add('view-enter');
}

// Animate a number counting up (used once for the home stats).
export function countUp(el, to, ms = 700) {
  if (reducedMotion() || to <= 1) { el.textContent = to; return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Press feedback: haptic tap for primary controls. Delegated so new elements get it too.
export function installPressFeedback(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn-primary, .fab, .shutter, .tab, [data-haptic]');
    if (b && !b.disabled) haptic.tap();
  }, { passive: true });
}
