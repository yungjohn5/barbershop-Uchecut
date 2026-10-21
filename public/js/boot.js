// Runs synchronously in <head>, before first paint.
// `motion-ok` lets CSS pre-hide elements that GSAP will reveal; it is removed again
// if GSAP has not started within 2.5 s, so content is never stuck invisible.
(function () {
  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  root.classList.add('motion-ok');
  window.setTimeout(function () {
    if (!window.__motionReady) {
      root.classList.remove('motion-ok');
      root.classList.add('no-gsap');
    }
  }, 2500);
})();
