// Runs synchronously in <head>, before first paint.
// `motion-ok` lets CSS pre-hide elements that GSAP will reveal; it is removed again
// if GSAP has not started within 2.5 s, so content is never stuck invisible.
// `show-loader` shows the intro once per browser session on the home page.
(function () {
  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  root.classList.add('motion-ok');

  if (window.location.pathname === '/') {
    try {
      if (!window.sessionStorage.getItem('vb-intro')) root.classList.add('show-loader');
    } catch {
      /* storage blocked: skip the intro */
    }
  }

  window.setTimeout(function () {
    if (!window.__motionReady) {
      root.classList.remove('motion-ok', 'show-loader');
      root.classList.add('no-gsap');
    }
  }, 2500);
})();
