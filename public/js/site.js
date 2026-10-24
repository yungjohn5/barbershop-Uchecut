// Shared behaviour for every page: menu, sticky nav, fit-text and scroll reveals.
(function () {
  'use strict';

  var root = document.documentElement;
  var gsap = window.gsap;
  var hasGsap = !!(gsap && window.ScrollTrigger);
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var motion = hasGsap && !reduce;

  if (hasGsap) {
    gsap.registerPlugin(window.ScrollTrigger, window.SplitText, window.Flip);
    if (window.ScrollSmoother) gsap.registerPlugin(window.ScrollSmoother);
    window.__motionReady = true;
  } else {
    root.classList.remove('motion-ok');
    root.classList.add('no-gsap');
  }

  var $ = function (sel, ctx) {
    return (ctx || document).querySelector(sel);
  };
  var $$ = function (sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  };

  // ------------------------------------------------- smooth scrolling (desktop)
  // Must exist before any ScrollTrigger is created. Touch devices keep native scrolling.
  // Created and destroyed with the breakpoint, so resizing a window down to phone
  // width hands control back to native scrolling (and the mobile menu).
  var smoother = null;
  var finePointer = window.matchMedia('(pointer: fine)').matches;
  // Pages with sticky UI (the booking summary) opt out: smoothing transforms break sticky.
  if (motion && window.ScrollSmoother && !document.body.hasAttribute('data-no-smoother')) {
    gsap.matchMedia().add('(min-width: 1024px) and (pointer: fine)', function () {
      smoother = window.ScrollSmoother.create({
        wrapper: '#smooth-wrapper',
        content: '#smooth-content',
        smooth: 1.1,
        effects: false,
        smoothTouch: false,
      });
      root.classList.add('has-smoother');
      if (window.Site) window.Site.smoother = smoother;
      return function () {
        smoother.kill();
        smoother = null;
        root.classList.remove('has-smoother');
        if (window.Site) window.Site.smoother = null;
      };
    });
  }

  // Same-page anchors (/#services, #main) glide through the smoother when it is active.
  function scrollToHash(hash) {
    var target = hash && hash.length > 1 ? document.getElementById(hash.slice(1)) : null;
    if (!target) return false;
    if (smoother) smoother.scrollTo(target, true, 'top 72px');
    else target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    return true;
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    var url = new URL(a.getAttribute('href'), window.location.href);
    if (url.pathname !== window.location.pathname || !url.hash) return;
    if (scrollToHash(url.hash)) {
      e.preventDefault();
      history.replaceState(null, '', url.hash);
    }
  });

  // ---------------------------------------------------------------- mobile menu
  var menu = $('[data-menu]');
  var openers = $$('[data-menu-open]');
  var lastFocus = null;

  function setExpanded(value) {
    openers.forEach(function (b) {
      b.setAttribute('aria-expanded', String(value));
    });
  }

  function openMenu() {
    if (!menu || !menu.hidden) return;
    lastFocus = document.activeElement;
    menu.hidden = false;
    document.body.style.overflow = 'hidden';
    if (smoother) smoother.paused(true);
    setExpanded(true);
    if (motion) {
      gsap.fromTo(
        menu,
        { clipPath: 'inset(0 0 100% 0)' },
        { clipPath: 'inset(0 0 0% 0)', duration: 0.8, ease: 'expo.inOut' },
      );
      gsap.fromTo(
        $$('[data-menu-link]', menu),
        { yPercent: 110, opacity: 0 },
        { yPercent: 0, opacity: 1, duration: 0.9, ease: 'expo.out', stagger: 0.05, delay: 0.3 },
      );
    }
    var close = $('[data-menu-close]', menu);
    if (close) close.focus();
  }

  function closeMenu() {
    if (!menu || menu.hidden) return;
    var done = function () {
      menu.hidden = true;
      document.body.style.overflow = '';
      if (smoother) smoother.paused(false);
      setExpanded(false);
      if (lastFocus) lastFocus.focus();
    };
    if (motion) {
      gsap.to(menu, {
        clipPath: 'inset(0 0 100% 0)',
        duration: 0.6,
        ease: 'expo.inOut',
        onComplete: done,
      });
    } else {
      done();
    }
  }

  openers.forEach(function (b) {
    b.addEventListener('click', openMenu);
  });
  if (menu) {
    $$('[data-menu-close], a', menu).forEach(function (el) {
      el.addEventListener('click', closeMenu);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
  }

  // ------------------------------------------- sticky nav + mobile "Book" pill
  var sticky = $('[data-sticky-nav]');
  var pill = $('[data-book-pill]');
  var sentinel = $('[data-hero-card]') || $('main > *');
  var footer = $('#visit');
  var pastHeader = false;
  var footerInView = false;
  var ctasInView = 0; // in-page CTAs that the pill would cover

  function syncChrome() {
    if (sticky) sticky.classList.toggle('is-visible', pastHeader);
    if (pill) pill.classList.toggle('is-visible', pastHeader && !footerInView && ctasInView === 0);
  }

  if ('IntersectionObserver' in window) {
    if (sentinel) {
      new IntersectionObserver(
        function (entries) {
          pastHeader = !entries[0].isIntersecting && entries[0].boundingClientRect.top < 0;
          syncChrome();
        },
        { rootMargin: '-80px 0px 0px 0px' },
      ).observe(sentinel);
    }
    var ctaObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        ctasInView += entry.isIntersecting ? 1 : entry.target.__seen ? -1 : 0;
        entry.target.__seen = entry.isIntersecting;
      });
      ctasInView = Math.max(0, ctasInView);
      syncChrome();
    });
    $$('[data-hide-pill]').forEach(function (el) {
      ctaObserver.observe(el);
    });
    if (footer) {
      new IntersectionObserver(function (entries) {
        footerInView = entries[0].isIntersecting;
        syncChrome();
      }).observe(footer);
    }
  }

  // ------------------------------------------------- fit text to its container
  function fitText() {
    $$('[data-fit]').forEach(function (el) {
      el.style.fontSize = '';
      var available = el.parentElement.clientWidth;
      var size = parseFloat(window.getComputedStyle(el).fontSize);
      if (el.scrollWidth > 0) el.style.fontSize = (size * available) / el.scrollWidth + 'px';
    });
  }

  // ----------------------------------------------------------- data-bg photos
  // Background photos chosen in Settings (CSP blocks inline styles, so set them via CSSOM).
  $('[data-bg]').forEach(function (el) {
    var url = el.getAttribute('data-bg');
    if (url) el.style.setProperty('--chair-bg', 'url("' + url.replace(/"/g, '%22') + '")');
  });

  // ----------------------------------------------------------- motion helpers
  function initMotion() {
    if (!motion) return;
    var ST = window.ScrollTrigger;

    // Headings: line-by-line masked reveal. autoSplit re-splits on resize/font changes.
    $$('[data-split]').forEach(function (el) {
      gsap.set(el, { visibility: 'visible' });
      window.SplitText.create(el, {
        type: 'lines',
        mask: 'lines',
        linesClass: 'split-line',
        autoSplit: true,
        onSplit: function (self) {
          return gsap.from(self.lines, {
            yPercent: 110,
            duration: 1.25,
            ease: 'expo.out',
            stagger: 0.1,
            scrollTrigger: { trigger: el, start: 'top 85%', once: true },
          });
        },
      });
    });

    // Fade-up for everything else, batched so neighbours stagger together.
    gsap.set('[data-reveal]', { y: 40 });
    ST.batch('[data-reveal]', {
      start: 'top 90%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, {
          opacity: 1,
          y: 0,
          duration: 1.1,
          ease: 'expo.out',
          stagger: 0.09,
          overwrite: true,
        });
      },
    });

    // Image frames that wipe open.
    $$('[data-clip]').forEach(function (el) {
      gsap.fromTo(
        el,
        { clipPath: 'inset(100% 0% 0% 0%)' },
        {
          clipPath: 'inset(0% 0% 0% 0%)',
          duration: 1.6,
          ease: 'expo.inOut',
          scrollTrigger: { trigger: el, start: 'top 82%', once: true },
        },
      );
    });

    // Slow drift of photos inside their frames.
    $$('[data-parallax-img]').forEach(function (img) {
      gsap.fromTo(
        img,
        { yPercent: -7, scale: 1.16 },
        {
          yPercent: 7,
          scale: 1.16,
          ease: 'none',
          scrollTrigger: {
            trigger: img.parentElement,
            start: 'top bottom',
            end: 'bottom top',
            scrub: true,
          },
        },
      );
    });

    // Whole elements moving at different speeds (collage depth).
    $$('[data-speed]').forEach(function (el) {
      var speed = parseFloat(el.getAttribute('data-speed')) || 0;
      gsap.to(el, {
        yPercent: -speed * 100,
        ease: 'none',
        scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true },
      });
    });

    // Construction lines drawing down.
    $$('[data-line-y]').forEach(function (el) {
      gsap.fromTo(
        el,
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: 'none',
          scrollTrigger: { trigger: el, start: 'top 85%', end: 'bottom 60%', scrub: true },
        },
      );
    });

    // Rotating text rings, faster on hover.
    $$('[data-ring]').forEach(function (ring) {
      var spin = gsap.to(ring, {
        rotation: 360,
        duration: 18,
        ease: 'none',
        repeat: -1,
        transformOrigin: '50% 50%',
      });
      var btn = ring.closest('a');
      if (!btn) return;
      btn.addEventListener('mouseenter', function () {
        gsap.to(spin, { timeScale: 3.5, duration: 0.6 });
      });
      btn.addEventListener('mouseleave', function () {
        gsap.to(spin, { timeScale: 1, duration: 0.8 });
      });
    });

    // Magnetic pull on round buttons (precise pointers only).
    if (window.matchMedia('(pointer: fine)').matches) {
      $$('[data-magnetic]').forEach(function (el) {
        var xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3' });
        var yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3' });
        el.addEventListener('mousemove', function (e) {
          var r = el.getBoundingClientRect();
          xTo((e.clientX - (r.left + r.width / 2)) * 0.35);
          yTo((e.clientY - (r.top + r.height / 2)) * 0.35);
        });
        el.addEventListener('mouseleave', function () {
          xTo(0);
          yTo(0);
        });
      });
    }

    // "Take the Chair": rise in, then the photo inside the letters drifts as you scroll.
    var chair = $('[data-chair]');
    if (chair) {
      gsap.from(chair, {
        yPercent: 100,
        duration: 1.5,
        ease: 'expo.out',
        scrollTrigger: { trigger: chair, start: 'top 92%', once: true },
      });
      gsap.fromTo(
        chair,
        { backgroundPosition: '50% 18%' },
        {
          // stay in the bright upper band of the photo so the letters keep their contrast
          backgroundPosition: '50% 52%',
          ease: 'none',
          scrollTrigger: {
            trigger: '#visit',
            start: 'top bottom',
            end: 'bottom bottom',
            scrub: true,
          },
        },
      );
    }
  }

  // ------------------------------------------------------------- light / dark
  // boot.js already set data-theme before paint. Toggling saves the choice and reveals the
  // new theme in a circle growing from the toggle (View Transitions), with a colour
  // cross-fade as the fallback. Without a saved choice the site follows the OS live.
  var themeMeta = $('meta[data-theme-color]');
  var toggles = $$('[data-theme-toggle]');

  function currentTheme() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (themeMeta) themeMeta.setAttribute('content', theme === 'dark' ? '#100F0E' : '#F4F1EC');
    toggles.forEach(function (t) {
      t.setAttribute('aria-checked', String(theme === 'dark'));
      t.setAttribute('title', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }

  function switchTheme(theme, origin) {
    try {
      window.localStorage.setItem('vb-theme', theme);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
    if (reduce) return applyTheme(theme);

    if (document.startViewTransition) {
      var r = origin ? origin.getBoundingClientRect() : null;
      var x = r ? r.left + r.width / 2 : window.innerWidth / 2;
      var y = r ? r.top + r.height / 2 : 0;
      var radius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );
      document
        .startViewTransition(function () {
          applyTheme(theme);
        })
        .ready.then(function () {
          root.animate(
            {
              clipPath: [
                'circle(0px at ' + x + 'px ' + y + 'px)',
                'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)',
              ],
            },
            {
              duration: 750,
              easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
              pseudoElement: '::view-transition-new(root)',
            },
          );
        })
        .catch(function () {});
      return;
    }
    root.classList.add('theme-anim');
    applyTheme(theme);
    setTimeout(function () {
      root.classList.remove('theme-anim');
    }, 700);
  }

  applyTheme(currentTheme());
  toggles.forEach(function (t) {
    t.addEventListener('click', function () {
      switchTheme(currentTheme() === 'dark' ? 'light' : 'dark', t);
    });
  });
  var osDark = window.matchMedia('(prefers-color-scheme: dark)');
  var onOsChange = function (e) {
    var saved = null;
    try {
      saved = window.localStorage.getItem('vb-theme');
    } catch {
      /* ignore */
    }
    if (!saved) applyTheme(e.matches ? 'dark' : 'light');
  };
  if (osDark.addEventListener) osDark.addEventListener('change', onOsChange);

  // ------------------------------------------------------------- back to top
  // Appears after the first screen; the ring fills with scroll progress.
  var toTop = $('[data-to-top]');
  if (toTop) {
    var ticking = false;
    var updateToTop = function () {
      ticking = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var y = window.scrollY;
      toTop.style.setProperty('--progress', max > 0 ? Math.min(1, y / max).toFixed(4) : 0);
      toTop.classList.toggle('is-visible', y > window.innerHeight * 0.8);
    };
    window.addEventListener(
      'scroll',
      function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(updateToTop);
        }
      },
      { passive: true },
    );
    updateToTop();
    toTop.addEventListener('click', function () {
      if (smoother) smoother.scrollTo(0, true);
      else window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      // Keep keyboard users oriented: focus moves to the top of the content.
      var main = $('#main');
      if (main) {
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        main.focus({ preventScroll: true });
      }
    });
  }

  // ------------------------------------------------------------ pill buttons
  // Adds the rolling label + sliding arrow markup to every .btn, and points the hover fill
  // at the spot where the pointer enters (and leaves). Round ring buttons are not .btn and
  // are deliberately left alone. Works without GSAP; the soft magnetic pull needs it.
  var BTN = '.btn, .btn-primary, .btn-light, .btn-ghost, .btn-ghost-light';
  function enhanceButtons() {
    $$(BTN).forEach(function (btn) {
      if (btn.hasAttribute('data-btn-ready')) return;
      btn.setAttribute('data-btn-ready', '');
      var hasArrow = !!btn.querySelector('.arrow');
      var label = Array.prototype.filter
        .call(btn.childNodes, function (n) {
          return !(n.nodeType === 1 && n.classList.contains('arrow'));
        })
        .map(function (n) {
          return n.textContent;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!label) return;
      btn.textContent = '';
      var roll = document.createElement('span');
      roll.className = 'btn-roll';
      var a = document.createElement('span');
      a.className = 'btn-roll-a';
      a.textContent = label;
      var b = document.createElement('span');
      b.className = 'btn-roll-b';
      b.setAttribute('aria-hidden', 'true');
      b.textContent = label;
      roll.appendChild(a);
      roll.appendChild(b);
      btn.appendChild(roll);
      if (hasArrow) {
        var arrow = document.createElement('span');
        arrow.className = 'btn-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.innerHTML = '<span>→</span><span>→</span>';
        btn.appendChild(arrow);
      }

      var aim = function (e) {
        var r = btn.getBoundingClientRect();
        btn.style.setProperty('--x', e.clientX - r.left + 'px');
        btn.style.setProperty('--y', e.clientY - r.top + 'px');
        btn.style.setProperty('--d', Math.hypot(r.width, r.height) * 2.1 + 'px');
      };
      btn.addEventListener('pointerenter', aim);
      btn.addEventListener('pointerleave', aim);
    });

    // Soft magnetic pull on desktop pointers (full-width buttons stay put).
    if (!motion || !finePointer) return;
    $$(BTN).forEach(function (btn) {
      if (btn.offsetWidth > 420 || btn.closest('[data-menu]')) return;
      var xTo = gsap.quickTo(btn, 'x', { duration: 0.7, ease: 'power3' });
      var yTo = gsap.quickTo(btn, 'y', { duration: 0.7, ease: 'power3' });
      btn.addEventListener('pointermove', function (e) {
        var r = btn.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * 0.18);
        yTo((e.clientY - (r.top + r.height / 2)) * 0.28);
      });
      btn.addEventListener('pointerleave', function () {
        xTo(0);
        yTo(0);
      });
    });
  }
  enhanceButtons();

  // ------------------------------------------------------- cursor companion
  // A small dot trailing the pointer; grows into a labelled disc over [data-cursor]
  // targets and steps aside over round buttons ([data-magnetic]) so they keep their own feel.
  function initCursor() {
    if (!motion || !finePointer) return;
    var cursor = document.createElement('div');
    cursor.className = 'cursor is-hidden';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML = '<span class="cursor-label"></span>';
    document.body.appendChild(cursor);
    var label = cursor.firstChild;
    var xTo = gsap.quickTo(cursor, 'x', { duration: 0.5, ease: 'power3' });
    var yTo = gsap.quickTo(cursor, 'y', { duration: 0.5, ease: 'power3' });

    window.addEventListener('mousemove', function (e) {
      xTo(e.clientX);
      yTo(e.clientY);
      var t = e.target.closest ? e.target : null;
      var overRound =
        t &&
        t.closest('[data-magnetic], ' + BTN + ', .icon-btn, input, select, textarea, [data-menu]');
      var labelled = t && t.closest('[data-cursor]');
      cursor.classList.toggle('is-hidden', !!overRound);
      cursor.classList.toggle('is-label', !!labelled && !overRound);
      if (labelled) label.textContent = labelled.getAttribute('data-cursor');
    });
    document.addEventListener('mouseleave', function () {
      cursor.classList.add('is-hidden');
    });
  }

  // Exposed for page scripts (home.js).
  window.Site = {
    $: $,
    $$: $$,
    motion: motion,
    hasGsap: hasGsap,
    reduce: reduce,
    smoother: smoother,
  };

  // Wait for web fonts (bounded) so line splits and fit-text measure real glyphs.
  var fontsReady =
    document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  var timeout = new Promise(function (resolve) {
    setTimeout(resolve, 1200);
  });
  window.Site.ready = Promise.race([fontsReady, timeout]).then(function () {
    fitText();
    initMotion();
    initCursor();
    if (window.location.hash) scrollToHash(window.location.hash);
  });

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      fitText();
      if (hasGsap) window.ScrollTrigger.refresh();
    }, 150);
  });
})();
