// Home page: hero entrance, marquee, services filter (Flip), home-visit steps, product rail.
(function () {
  'use strict';

  var Site = window.Site;
  if (!Site) return;
  var $ = Site.$;
  var $$ = Site.$$;
  var gsap = window.gsap;

  // -------------------------------------------------------- services filter
  // Works without GSAP (just hides/shows); with GSAP the grid reflows via Flip.
  var grid = $('[data-svc-grid]');
  var tabs = $$('[data-svc-tabs] [data-filter]');
  var cards = grid ? Array.prototype.slice.call(grid.children) : [];
  var filtering = false;
  var pending = null; // last filter clicked while an animation was running

  function applyOffsets() {
    var visible = cards.filter(function (c) {
      return !c.hidden;
    });
    cards.forEach(function (c) {
      c.classList.remove('offset-sm', 'offset-md');
    });
    visible.forEach(function (c, i) {
      if (i % 2 === 1) c.classList.add('offset-sm');
      if (i % 3 === 1) c.classList.add('offset-md');
    });
  }

  function filterServices(slug) {
    if (filtering) {
      pending = slug;
      return;
    }
    var matches = function (c) {
      return slug === 'all' || c.getAttribute('data-category') === slug;
    };
    tabs.forEach(function (t) {
      t.setAttribute('aria-pressed', String(t.getAttribute('data-filter') === slug));
    });

    if (!Site.motion || !window.Flip) {
      cards.forEach(function (c) {
        c.hidden = !matches(c);
      });
      applyOffsets();
      return;
    }

    filtering = true;
    var leaving = cards.filter(function (c) {
      return !c.hidden && !matches(c);
    });
    var staying = cards.filter(function (c) {
      return !c.hidden && matches(c);
    });
    // Settle any half-finished scroll reveal first: Flip kills running tweens on its
    // targets, and the CSS pre-reveal state (opacity 0) must never apply to filtered cards.
    gsap.killTweensOf(cards);
    gsap.set(staying, { opacity: 1, y: 0 });
    gsap.to(leaving, {
      opacity: 0,
      scale: 0.96,
      duration: leaving.length ? 0.3 : 0,
      ease: 'power2.in',
      onComplete: function () {
        // Record every card (hidden ones as display:none) so Flip reports enterers.
        var state = window.Flip.getState(cards);
        cards.forEach(function (c) {
          c.hidden = !matches(c);
        });
        gsap.set(leaving, { opacity: 1, y: 0, scale: 1 });
        applyOffsets();
        window.Flip.from(state, {
          targets: cards,
          duration: 0.8,
          ease: 'expo.inOut',
          onEnter: function (els) {
            return gsap.fromTo(
              els,
              { opacity: 0, y: 50 },
              { opacity: 1, y: 0, duration: 0.9, ease: 'expo.out', stagger: 0.06, delay: 0.15 },
            );
          },
          onComplete: function () {
            filtering = false;
            window.ScrollTrigger.refresh();
            if (pending !== null) {
              var next = pending;
              pending = null;
              filterServices(next);
            }
          },
        });
      },
    });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      filterServices(t.getAttribute('data-filter'));
    });
  });

  if (!Site.motion) return;

  Site.ready.then(function () {
    var ST = window.ScrollTrigger;

    // ------------------------------------------------------------ hero entrance
    var hero = $('[data-hero]');
    if (hero) {
      gsap.set('[data-hero-line]', { visibility: 'visible' });
      var tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.from('[data-hero-word]', { yPercent: 35, opacity: 0, duration: 1.8 }, 0)
        .from(
          '[data-hero-card]',
          { clipPath: 'inset(10% 6% 0% 6%)', duration: 1.7, ease: 'expo.inOut' },
          0.05,
        )
        .from('[data-hero-img]', { scale: 1.3, duration: 2.4 }, 0.05)
        .from('[data-hero-nav] > *', { y: -24, opacity: 0, duration: 1.1, stagger: 0.08 }, 0.75)
        .from('[data-hero-rule]', { scaleX: 0, duration: 1.6, ease: 'expo.inOut' }, 0.7)
        .from('[data-hero-line]', { yPercent: 115, duration: 1.4, stagger: 0.12 }, 0.8)
        .to('[data-hero-fade]', { opacity: 1, duration: 1.2, stagger: 0.12 }, 1.2)
        .from(
          '[data-hero] .ring-btn',
          { scale: 0.5, opacity: 0, rotation: -120, duration: 1.6 },
          1.15,
        );

      // Pointer depth on desktop: the photo drifts gently against the cursor.
      var media = $('[data-hero-media]');
      if (media && window.matchMedia('(pointer: fine)').matches) {
        var mx = gsap.quickTo(media, 'x', { duration: 1.4, ease: 'power3' });
        var my = gsap.quickTo(media, 'y', { duration: 1.4, ease: 'power3' });
        hero.addEventListener('mousemove', function (e) {
          mx((e.clientX / window.innerWidth - 0.5) * -22);
          my((e.clientY / window.innerHeight - 0.5) * -14);
        });
        hero.addEventListener('mouseleave', function () {
          mx(0);
          my(0);
        });
      }

      // Scroll: photo sinks, wordmark lifts away.
      gsap.to('[data-hero-img]', {
        yPercent: 10,
        ease: 'none',
        scrollTrigger: {
          trigger: '[data-hero-card]',
          start: 'top top',
          end: 'bottom top',
          scrub: true,
        },
      });
      gsap.to('[data-hero-word]', {
        y: -140,
        ease: 'none',
        scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: true },
      });
    }

    // ------------------------------------------------------------------ marquee
    var track = $('[data-marquee]');
    if (track) {
      var loop = gsap.to(track, { xPercent: -50, duration: 42, ease: 'none', repeat: -1 });
      var settle;
      ST.create({
        start: 0,
        end: 'max',
        onUpdate: function (self) {
          var boost = 1 + Math.min(Math.abs(self.getVelocity()) / 700, 5);
          gsap.to(loop, { timeScale: boost, duration: 0.2, overwrite: true });
          clearTimeout(settle);
          settle = setTimeout(function () {
            gsap.to(loop, { timeScale: 1, duration: 1.2, ease: 'power2.out', overwrite: true });
          }, 120);
        },
      });
    }

    // ------------------------------------------------------- home-visit steps
    var steps = $('[data-steps]');
    if (steps) {
      gsap.fromTo(
        '[data-progress]',
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: 'none',
          scrollTrigger: { trigger: steps, start: 'top 70%', end: 'bottom 55%', scrub: true },
        },
      );
      $$('[data-step]', steps).forEach(function (step) {
        ST.create({
          trigger: step,
          start: 'top 68%',
          toggleClass: { targets: step, className: 'is-active' },
        });
        gsap.from(step, {
          opacity: 0,
          x: 30,
          duration: 1.1,
          ease: 'expo.out',
          scrollTrigger: { trigger: step, start: 'top 85%', once: true },
        });
      });
    }

    // ------------------------------------------- product rail (pinned on desktop)
    var mm = gsap.matchMedia();
    mm.add('(min-width: 1024px)', function () {
      var section = $('[data-products]');
      var rail = $('[data-rail]');
      if (!section || !rail) return;
      // The pin drives the rail; native horizontal scroll is restored when this context reverts.
      gsap.set(rail, { overflow: 'visible', scrollSnapType: 'none' });
      var distance = function () {
        return Math.max(0, rail.scrollWidth - document.documentElement.clientWidth);
      };
      gsap.to(rail, {
        x: function () {
          return -distance();
        },
        ease: 'none',
        scrollTrigger: {
          trigger: section,
          start: 'top top',
          end: function () {
            return '+=' + distance();
          },
          pin: true,
          scrub: 0.8,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          onUpdate: function (self) {
            gsap.set('[data-rail-progress]', { scaleX: self.progress });
          },
        },
      });
    });

    ST.refresh();
  });
})();
