// Runs synchronously in <head>, before first paint.
// - data-theme: saved choice, else the OS setting (no flash of the wrong theme).
// - `motion-ok` lets CSS pre-hide elements that GSAP will reveal; it is removed again
//   if GSAP has not started within 2.5 s, so content is never stuck invisible.
// - `show-loader` shows the intro once per browser session on the home page, on desktop
//   only: phones (often on mobile data) go straight to the hero.
(function () {
  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');

  var saved = null;
  try {
    saved = window.localStorage.getItem('vb-theme');
  } catch {
    /* storage blocked: follow the OS */
  }
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);
  var meta = document.querySelector('meta[data-theme-color]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#100F0E' : '#F4F1EC');

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  root.classList.add('motion-ok');

  var desktop = window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches;
  if (window.location.pathname === '/' && desktop) {
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
