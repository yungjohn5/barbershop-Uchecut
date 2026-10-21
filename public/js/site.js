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

  function syncChrome() {
    if (sticky) sticky.classList.toggle('is-visible', pastHeader);
    if (pill) pill.classList.toggle('is-visible', pastHeader && !footerInView);
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

  // Exposed for page scripts (home.js).
  window.Site = { $: $, $$: $$, motion: motion, hasGsap: hasGsap, reduce: reduce };

  // Wait for web fonts (bounded) so line splits and fit-text measure real glyphs.
  var fontsReady =
    document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  var timeout = new Promise(function (resolve) {
    setTimeout(resolve, 1200);
  });
  window.Site.ready = Promise.race([fontsReady, timeout]).then(function () {
    fitText();
    initMotion();
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
