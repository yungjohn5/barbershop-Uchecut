// Booking wizard, confirmation and manage pages. Everything here is an enhancement:
// each step is a normal form that works without JavaScript.
(function () {
  'use strict';

  var Site = window.Site || {};
  var gsap = window.gsap;
  var $ = function (sel, ctx) {
    return (ctx || document).querySelector(sel);
  };
  var $$ = function (sel, ctx) {
    return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
  };
  var naira = function (kobo) {
    return '₦' + (kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  };
  var duration = function (min) {
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return m ? h + ' h ' + m + ' min' : h + ' h';
  };
  var whenFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  var timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  var whenLabel = function (iso) {
    var d = new Date(iso);
    return whenFmt.format(d).replace(',', '') + ' · ' + timeFmt.format(d);
  };
  var setAll = function (sel, text) {
    $$(sel).forEach(function (el) {
      el.textContent = text;
    });
  };
  var setContinue = function (enabled) {
    $$('[data-continue]').forEach(function (b) {
      b.disabled = !enabled;
    });
  };

  // ------------------------------------------------------------ entrance
  if (Site.motion && gsap) {
    gsap.from('[data-b-reveal]', {
      y: 28,
      opacity: 0,
      duration: 0.9,
      ease: 'expo.out',
      stagger: 0.06,
      clearProps: 'transform,opacity',
    });
  }

  // ------------------------------------------------------------ mobile summary sheet
  var sheetToggle = $('[data-sheet-toggle]');
  var sheet = $('.booking-sheet');
  if (sheetToggle && sheet) {
    sheetToggle.addEventListener('click', function () {
      sheet.open = !sheet.open;
      sheetToggle.setAttribute('aria-expanded', String(sheet.open));
    });
  }

  // ------------------------------------------------------------ services: live totals
  var servicesForm = $('[data-services-form]');
  if (servicesForm) {
    var feeEl = $('[data-sum-fee]');
    var fee = feeEl ? Number(feeEl.getAttribute('data-fee')) || 0 : 0;
    var updateServices = function () {
      var picked = $$('input[name="serviceIds"]:checked', servicesForm);
      var subtotal = 0;
      var minutes = 0;
      var names = picked.map(function (i) {
        subtotal += Number(i.getAttribute('data-price'));
        minutes += Number(i.getAttribute('data-duration'));
        return i.getAttribute('data-name');
      });
      $$('[data-sum-services]').forEach(function (el) {
        el.innerHTML = '';
        if (!names.length) {
          var none = document.createElement('span');
          none.className = 'text-ink/50';
          none.textContent = 'Not chosen yet';
          el.appendChild(none);
        }
        names.forEach(function (n) {
          var s = document.createElement('span');
          s.className = 'block';
          s.textContent = n;
          el.appendChild(s);
        });
      });
      setAll('[data-sum-duration]', minutes ? duration(minutes) : '—');
      setAll('[data-sum-subtotal]', picked.length ? naira(subtotal) : '—');
      setAll('[data-sum-total]', picked.length ? naira(subtotal + fee) : '—');
      setContinue(picked.length > 0);
    };
    servicesForm.addEventListener('change', updateServices);
  }

  // ------------------------------------------------------------ visit step: live summary
  // Picking a zone shows its travel fee straight away (or services + fee when services are
  // already in the draft, e.g. from a service card link).
  var typeForm = $('[data-type-form]');
  if (typeForm) {
    var subEl = $('[data-sum-subtotal]');
    var subtotalKobo = subEl ? Number(subEl.getAttribute('data-kobo')) || 0 : 0;
    var setTotal = function (kobo, travelOnly) {
      $$('[data-sum-total]').forEach(function (el) {
        el.textContent = '';
        if (kobo == null) {
          el.textContent = '—';
          return;
        }
        el.appendChild(document.createTextNode((travelOnly ? '+' : '') + naira(kobo)));
        if (travelOnly) {
          var t = document.createElement('span');
          t.className = 'font-sans text-sm text-ink/65';
          t.textContent = ' travel';
          el.appendChild(t);
        }
      });
    };
    var updateType = function () {
      var picked = typeForm.querySelector('input[name="type"]:checked');
      var type = picked ? picked.value : null;
      var zone = type === 'HOME' ? typeForm.querySelector('input[name="zoneId"]:checked') : null;
      var fee = zone ? Number(zone.getAttribute('data-fee')) : 0;
      if (type) setAll('[data-sum-type]', type === 'HOME' ? 'Home visit' : 'In shop');
      $$('[data-sum-area-row]').forEach(function (row) {
        row.hidden = !zone;
      });
      setAll('[data-sum-area]', zone ? zone.getAttribute('data-zone-name') : '');
      if (subtotalKobo) setTotal(subtotalKobo + fee, false);
      else if (zone) setTotal(fee, true);
      else setTotal(null);
    };
    typeForm.addEventListener('change', updateType);
  }

  // ------------------------------------------------------------ time picker
  var picker = $('[data-time-picker]');
  if (picker) {
    var slotsBox = $('[data-slots]', picker);
    var strip = $('[data-date-strip]', picker);
    var barberInput = $('[data-barber-input]', picker);
    var state = {
      date: picker.getAttribute('data-date'),
      barber: picker.getAttribute('data-barber'),
      url: picker.getAttribute('data-slots-url'),
      extra: picker.getAttribute('data-slots-query'),
    };

    // Keep the selected date in view.
    var activeChip = $('.date-chip.is-active', strip);
    if (activeChip && strip)
      strip.scrollLeft = activeChip.offsetLeft - strip.clientWidth / 2 + activeChip.clientWidth / 2;
    $$('[data-strip-prev], [data-strip-next]', picker).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var dir = btn.hasAttribute('data-strip-next') ? 1 : -1;
        strip.scrollBy({
          left: dir * strip.clientWidth * 0.8,
          behavior: Site.reduce ? 'auto' : 'smooth',
        });
      });
    });

    var groupsOf = function (slots) {
      var groups = [
        { label: 'Morning', slots: [] },
        { label: 'Afternoon', slots: [] },
        { label: 'Evening', slots: [] },
      ];
      slots.forEach(function (s) {
        var h = Number(s.time.slice(0, 2));
        groups[h < 12 ? 0 : h < 17 ? 1 : 2].slots.push(s);
      });
      return groups.filter(function (g) {
        return g.slots.length;
      });
    };

    var renderSlots = function (slots, error) {
      slotsBox.innerHTML = '';
      if (error || !slots.length) {
        var empty = document.createElement('div');
        empty.className = 'slots-empty';
        var t = document.createElement('p');
        t.className = 'font-serif text-2xl';
        t.textContent = error || 'No free times on this day.';
        empty.appendChild(t);
        if (!error) {
          var h = document.createElement('p');
          h.className = 'mt-2 text-sm text-ink/65';
          h.textContent =
            state.barber === 'any'
              ? 'Try another date.'
              : 'Try another date or choose “Any barber” for more options.';
          empty.appendChild(h);
        }
        slotsBox.appendChild(empty);
        return;
      }
      groupsOf(slots).forEach(function (g) {
        var group = document.createElement('div');
        group.className = 'slot-group';
        var label = document.createElement('p');
        label.className = 'slot-group-label';
        label.textContent = g.label + ' ';
        var count = document.createElement('span');
        count.textContent = g.slots.length;
        label.appendChild(count);
        group.appendChild(label);
        var grid = document.createElement('div');
        grid.className = 'slot-grid';
        g.slots.forEach(function (s) {
          var l = document.createElement('label');
          l.className = 'slot';
          var input = document.createElement('input');
          input.type = 'radio';
          input.name = 'startsAt';
          input.value = s.startsAt;
          input.className = 'sr-only';
          input.required = true;
          var span = document.createElement('span');
          span.textContent = s.time;
          l.appendChild(input);
          l.appendChild(span);
          grid.appendChild(l);
        });
        group.appendChild(grid);
        slotsBox.appendChild(group);
      });
      if (Site.motion && gsap) {
        gsap.from($$('.slot', slotsBox), {
          y: 12,
          opacity: 0,
          duration: 0.6,
          ease: 'expo.out',
          stagger: 0.012,
        });
      }
    };

    var load = function () {
      var params =
        'date=' + encodeURIComponent(state.date) + '&barber=' + encodeURIComponent(state.barber);
      if (state.extra) params += '&' + state.extra;
      slotsBox.classList.add('is-loading');
      setContinue(false);
      setAll('[data-sum-when]', '—');
      return fetch(state.url + '?' + params, { headers: { Accept: 'application/json' } })
        .then(function (r) {
          return r.json().then(function (body) {
            return { ok: r.ok, body: body };
          });
        })
        .then(function (res) {
          if (!res.ok)
            return renderSlots(
              [],
              (res.body.error && res.body.error.message) || 'Couldn’t load times.',
            );
          renderSlots(res.body.slots || [], res.body.error || null);
        })
        .catch(function () {
          renderSlots([], 'Couldn’t load times. Check your connection and try again.');
        })
        .then(function () {
          slotsBox.classList.remove('is-loading');
        });
    };

    var syncUrl = function () {
      var u = new URL(window.location.href);
      u.searchParams.set('date', state.date);
      u.searchParams.set('barber', state.barber);
      history.replaceState(null, '', u.pathname + '?' + u.searchParams.toString());
      // keep the no-JS links in step with the current choice
      $$('[data-date-link]', picker).forEach(function (a) {
        a.href =
          u.pathname +
          '?barber=' +
          encodeURIComponent(state.barber) +
          '&date=' +
          a.getAttribute('data-date-link');
      });
      $$('[data-barber-link]', picker).forEach(function (a) {
        a.href =
          u.pathname + '?barber=' + a.getAttribute('data-barber-link') + '&date=' + state.date;
      });
    };

    picker.addEventListener('click', function (e) {
      var dateLink = e.target.closest('[data-date-link]');
      var barberLink = e.target.closest('[data-barber-link]');
      if (!dateLink && !barberLink) return;
      e.preventDefault();
      if (dateLink) {
        state.date = dateLink.getAttribute('data-date-link');
        $$('[data-date-link]', picker).forEach(function (a) {
          var on = a === dateLink;
          a.classList.toggle('is-active', on);
          if (on) a.setAttribute('aria-current', 'date');
          else a.removeAttribute('aria-current');
        });
      } else {
        state.barber = barberLink.getAttribute('data-barber-link');
        barberInput.value = state.barber;
        $$('[data-barber-link]', picker).forEach(function (a) {
          var on = a === barberLink;
          a.classList.toggle('is-active', on);
          if (on) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
        });
        var name = barberLink.querySelector('.font-medium');
        setAll('[data-sum-barber]', name ? name.textContent : 'Any barber');
      }
      syncUrl();
      load();
    });

    slotsBox.addEventListener('change', function (e) {
      if (e.target.name !== 'startsAt') return;
      setAll('[data-sum-when]', whenLabel(e.target.value));
      setContinue(true);
    });
  }

  // ------------------------------------------------------------ details: submit once
  var details = $('[data-details-form]');
  if (details) {
    details.addEventListener('submit', function () {
      $$('[data-submit], [data-continue]').forEach(function (b) {
        b.disabled = true;
        var label = b.querySelector('.btn-roll-a') || b;
        label.textContent = 'Booking…';
      });
    });
  }

  // ------------------------------------------------------------ copy buttons
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      var label = $('[data-copy-label]', btn) || btn;
      var original = label.textContent;
      var done = function (ok) {
        label.textContent = ok ? 'Copied ✓' : 'Press Ctrl+C';
        setTimeout(function () {
          label.textContent = original;
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            done(true);
          },
          function () {
            done(false);
          },
        );
      } else {
        done(false);
      }
    });
  });

  // ------------------------------------------------------------ dialogs
  $$('[data-dialog-open]').forEach(function (btn) {
    var dialog = document.getElementById(btn.getAttribute('data-dialog-open'));
    if (!dialog || !dialog.showModal) return;
    btn.addEventListener('click', function () {
      dialog.showModal();
    });
    $$('[data-dialog-close]', dialog).forEach(function (c) {
      c.addEventListener('click', function () {
        dialog.close();
        btn.focus();
      });
    });
    // click on the backdrop closes
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });
  });
})();
