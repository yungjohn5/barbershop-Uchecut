// Admin dashboard enhancements. Pages work without JS except the staff form's free
// times and the calendar's block positions (CSP forbids inline styles, so we set them here).
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
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  // ------------------------------------------------------------ mobile drawer
  var nav = $('[data-a-nav]');
  var openBtn = $('[data-a-nav-open]');
  var backdrop = $('[data-a-backdrop]');
  if (nav && openBtn) {
    var setOpen = function (open) {
      document.body.classList.toggle('a-nav-open', open);
      openBtn.setAttribute('aria-expanded', String(open));
      if (backdrop) backdrop.hidden = !open;
      if (open) {
        var first = $('a, button', nav);
        if (first) first.focus();
      } else {
        openBtn.focus();
      }
    };
    openBtn.addEventListener('click', function () {
      setOpen(true);
    });
    $$('[data-a-nav-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        setOpen(false);
      });
    });
    if (backdrop)
      backdrop.addEventListener('click', function () {
        setOpen(false);
      });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('a-nav-open')) setOpen(false);
    });
    window.matchMedia('(min-width: 1024px)').addEventListener('change', function (mq) {
      if (mq.matches && document.body.classList.contains('a-nav-open')) {
        document.body.classList.remove('a-nav-open');
        if (backdrop) backdrop.hidden = true;
        openBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ------------------------------------------------------------ flash
  $$('[data-a-flash-close]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var box = btn.closest('[data-a-flash]');
      if (!box) return;
      if (Site.motion && gsap) {
        gsap.to(box, {
          opacity: 0,
          y: -8,
          height: 0,
          marginBottom: 0,
          paddingTop: 0,
          paddingBottom: 0,
          duration: 0.45,
          ease: 'expo.out',
          onComplete: function () {
            box.remove();
          },
        });
      } else box.remove();
    });
  });

  // ------------------------------------------------------------ clickable table rows
  $$('tr[data-href]').forEach(function (row) {
    row.addEventListener('click', function (e) {
      if (e.target.closest('a, button, input, select, label')) return;
      var href = row.getAttribute('data-href');
      if (e.metaKey || e.ctrlKey) window.open(href, '_blank');
      else window.location.href = href;
    });
  });

  // ------------------------------------------------------------ entrance
  if (Site.motion && gsap) {
    var items = $$(
      '.a-page-head, .a-stat, .a-card, .a-filters, .a-table-wrap, .cal-wrap, .a-empty, .a-barber, .a-tile',
    );
    if (items.length)
      gsap.from(items, {
        y: 22,
        opacity: 0,
        duration: 0.8,
        ease: 'expo.out',
        stagger: 0.04,
        clearProps: 'transform,opacity',
      });
  }

  // ------------------------------------------------------------ calendar
  var cal = $('[data-cal]');
  if (cal) {
    // 96px per hour keeps a 30-minute booking readable (time + name).
    var body = $('.cal-body', cal);
    var hourCount = $$('.cal-hour', cal).length - 1;
    if (body && hourCount > 0) body.style.setProperty('--cal-height', hourCount * 96 + 'px');
    $$('[data-top]', cal).forEach(function (el) {
      el.style.top = el.getAttribute('data-top') + '%';
      var h = el.getAttribute('data-h');
      if (h !== null) el.style.height = Math.max(0, Number(h)) + '%';
    });
    // Phones scroll sideways: bring today into view.
    var today = $('.cal-col.is-today', cal);
    if (today && cal.scrollWidth > cal.clientWidth) {
      cal.scrollLeft = today.offsetLeft - 64;
    }
  }

  // ------------------------------------------------------------ owner forms
  // Photo picker: preview the chosen file before upload.
  $$('[data-image-input]').forEach(function (box) {
    var input = $('[data-image-file]', box);
    var preview = $('[data-image-preview]', box);
    var label = $('[data-image-label]', box);
    if (!input || !preview) return;
    var url = null;
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(file);
      preview.innerHTML = '';
      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      preview.appendChild(img);
      box.classList.remove('has-error');
      if (label) {
        var parts = $$('.btn-roll-a, .btn-roll-b', label);
        var text = file.name.length > 28 ? file.name.slice(0, 25) + '…' : file.name;
        if (parts.length)
          parts.forEach(function (p) {
            p.textContent = text;
          });
        else label.textContent = text;
      }
      if (Site.motion && gsap)
        gsap.from(img, { scale: 1.08, opacity: 0, duration: 0.7, ease: 'expo.out' });
    });
  });

  // "Select all" for a group of checkboxes; toggles to "Clear all".
  $$('[data-check-all]').forEach(function (btn) {
    var name = btn.getAttribute('data-check-all');
    var form = btn.closest('form');
    var boxes = $$('input[name="' + name + '"]', form);
    var sync = function () {
      var all = boxes.every(function (b) {
        return b.checked;
      });
      btn.textContent = all ? 'Clear all' : 'Select all';
    };
    btn.addEventListener('click', function () {
      var all = boxes.every(function (b) {
        return b.checked;
      });
      boxes.forEach(function (b) {
        b.checked = !all;
      });
      sync();
    });
    boxes.forEach(function (b) {
      b.addEventListener('change', sync);
    });
    sync();
  });

  // Weekly hours: copy Monday's shift to Tuesday–Friday.
  var copyMon = $('[data-copy-monday]');
  if (copyMon) {
    copyMon.addEventListener('click', function () {
      var form = copyMon.closest('form');
      var get = function (n) {
        return $('[name="' + n + '"]', form);
      };
      [2, 3, 4, 5].forEach(function (d) {
        get('open_' + d).checked = get('open_1').checked;
        get('start_' + d).value = get('start_1').value;
        get('end_' + d).value = get('end_1').value;
      });
      copyMon.textContent = 'Copied ✓';
      setTimeout(function () {
        copyMon.textContent = 'Copy Monday to weekdays';
      }, 1600);
    });
  }

  // Section tabs: highlight the section in view.
  var tabs = $$('.a-tabs a[href^="#"]');
  if (tabs.length && 'IntersectionObserver' in window) {
    var byId = {};
    tabs.forEach(function (a) {
      byId[a.getAttribute('href').slice(1)] = a;
    });
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          tabs.forEach(function (a) {
            a.classList.remove('is-active');
          });
          var a = byId[en.target.id];
          if (a) a.classList.add('is-active');
        });
      },
      { rootMargin: '-30% 0px -60% 0px' },
    );
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }

  // Selects that apply as soon as they change (e.g. sort order).
  $$('[data-auto-submit]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      if (sel.form) sel.form.submit();
    });
  });

  // Ask before destructive one-click actions.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-confirm]');
    if (btn && !window.confirm(btn.getAttribute('data-confirm'))) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // Suggest a strong password: 4 words of random letters + digits, easy to read out.
  $$('[data-generate-password]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var field = $('[data-password-field]', btn.closest('form') || document);
      if (!field || !window.crypto) return;
      var letters = 'abcdefghjkmnpqrstuvwxyz';
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      var parts = [];
      for (var i = 0; i < 3; i++) {
        var w = '';
        for (var j = 0; j < 4; j++) w += letters[bytes[i * 4 + j] % letters.length];
        parts.push(w);
      }
      parts.push(String(100 + ((bytes[12] * 256 + bytes[13]) % 900)));
      field.value = parts.join('-');
      field.focus();
      field.select();
    });
  });

  // Submit once: no double uploads on slow connections.
  $$('[data-a-form]').forEach(function (f) {
    f.addEventListener('submit', function () {
      var btn = $('[data-a-submit]', f);
      if (!btn) return;
      setTimeout(function () {
        btn.disabled = true;
        var label = btn.querySelector('.btn-roll-a') || btn;
        label.textContent = 'Saving…';
      }, 0);
    });
  });

  // ------------------------------------------------------------ staff booking form
  var form = $('[data-staff-form]');
  if (form) {
    var slotsBox = $('[data-staff-slots]', form);
    var selected = slotsBox.getAttribute('data-selected') || '';
    var dateInput = $('[data-staff-date]', form);
    var barberSelect = $('[data-staff-barber]', form);
    var services = $$('[data-staff-service]', form);
    var typeOf = function () {
      var t = $('[data-staff-type]:checked', form);
      return t ? t.value : 'SHOP';
    };
    var zoneOf = function () {
      var z = $('[data-staff-zone]:checked', form);
      return z ? z.value : '';
    };
    var zoneFee = function () {
      var z = $('[data-staff-zone]:checked', form);
      if (!z || typeOf() !== 'HOME') return 0;
      var label = z.closest('label');
      return Number(label && label.getAttribute('data-fee')) || 0;
    };

    var summary = function () {
      var picked = services.filter(function (s) {
        return s.checked;
      });
      var price = 0;
      var minutes = 0;
      picked.forEach(function (s) {
        price += Number(s.getAttribute('data-price'));
        minutes += Number(s.getAttribute('data-duration'));
      });
      $('[data-ss-services]').textContent = picked.length
        ? picked
            .map(function (s) {
              return s.getAttribute('data-name');
            })
            .join(', ')
        : '—';
      $('[data-ss-duration]').textContent = minutes ? duration(minutes) : '—';
      var fee = zoneFee();
      $('[data-ss-total]').textContent = picked.length ? naira(price + fee) : '—';
      var chosen = $('input[name="startsAt"]:checked', form);
      $('[data-ss-when]').textContent = chosen
        ? whenFmt.format(new Date(chosen.value)).replace(',', '')
        : '—';
    };

    // Home visits: shop-only services can't be picked.
    var syncType = function () {
      var home = typeOf() === 'HOME';
      services.forEach(function (s) {
        var ok = s.closest('label').getAttribute('data-home-ok') !== 'false';
        s.disabled = home && !ok;
        if (s.disabled) s.checked = false;
        s.closest('label').classList.toggle('is-disabled', s.disabled);
      });
    };

    var empty = function (title, hint) {
      slotsBox.innerHTML = '';
      var box = document.createElement('div');
      box.className = 'slots-empty';
      var t = document.createElement('p');
      t.className = hint ? 'font-serif text-2xl' : '';
      t.textContent = title;
      box.appendChild(t);
      if (hint) {
        var h = document.createElement('p');
        h.className = 'mt-2 text-sm text-ink/65';
        h.textContent = hint;
        box.appendChild(h);
      }
      slotsBox.appendChild(box);
    };

    var render = function (slots) {
      slotsBox.innerHTML = '';
      var groups = [
        { label: 'Morning', slots: [] },
        { label: 'Afternoon', slots: [] },
        { label: 'Evening', slots: [] },
      ];
      slots.forEach(function (s) {
        var h = Number(s.time.slice(0, 2));
        groups[h < 12 ? 0 : h < 17 ? 1 : 2].slots.push(s);
      });
      groups.forEach(function (g) {
        if (!g.slots.length) return;
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
          if (s.startsAt === selected) input.checked = true;
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
          y: 10,
          opacity: 0,
          duration: 0.5,
          ease: 'expo.out',
          stagger: 0.01,
        });
      }
    };

    var seq = 0;
    var load = function () {
      var ids = services
        .filter(function (s) {
          return s.checked;
        })
        .map(function (s) {
          return s.value;
        });
      if (!ids.length) {
        empty('Choose services, then pick a date to see free times.');
        summary();
        return;
      }
      if (typeOf() === 'HOME' && !zoneOf()) {
        empty('Pick the customer’s area to see free times.');
        summary();
        return;
      }
      var params = new URLSearchParams({
        date: dateInput.value,
        barber: barberSelect.value,
        services: ids.join(','),
        type: typeOf(),
        zone: typeOf() === 'HOME' ? zoneOf() : '',
      });
      var mine = ++seq;
      slotsBox.classList.add('is-loading');
      slotsBox.setAttribute('data-slots', '');
      fetch('/admin/api/slots?' + params.toString(), { headers: { Accept: 'application/json' } })
        .then(function (r) {
          return r.json();
        })
        .then(function (body) {
          if (mine !== seq) return;
          if (body.error)
            return empty(typeof body.error === 'string' ? body.error : 'Couldn’t load times.');
          if (!body.slots || !body.slots.length)
            return empty(
              'No free times on this day.',
              barberSelect.value === 'any'
                ? 'Try another date.'
                : 'Try another date or “Any barber”.',
            );
          render(body.slots);
        })
        .catch(function () {
          if (mine === seq) empty('Couldn’t load times. Check your connection.');
        })
        .then(function () {
          if (mine === seq) slotsBox.classList.remove('is-loading');
          summary();
        });
    };

    // Errors from the last submit go away as soon as that part is fixed.
    var clearError = function (t) {
      var field = t.closest('.field-float');
      if (field) {
        field.classList.remove('has-error');
        $$('.field-error', field).forEach(function (n) {
          n.remove();
        });
        return;
      }
      var section = t.closest('section');
      if (section)
        $$(':scope > .field-error', section).forEach(function (n) {
          n.remove();
        });
    };
    form.addEventListener('input', function (e) {
      clearError(e.target);
    });

    form.addEventListener('change', function (e) {
      var t = e.target;
      clearError(t);
      if (t.name === 'startsAt') {
        selected = t.value;
        summary();
        return;
      }
      if (t.matches('[data-staff-type]')) syncType();
      if (
        t.matches(
          '[data-staff-type], [data-staff-zone], [data-staff-service], [data-staff-barber], [data-staff-date]',
        )
      ) {
        load();
      }
    });

    // Returning customer lookup by phone.
    var phone = $('[data-staff-phone]', form);
    var hint = $('[data-customer-hint]', form);
    var lookup = function () {
      var v = phone.value.trim();
      if (v.replace(/\D/g, '').length < 10) return;
      fetch('/admin/api/customer?phone=' + encodeURIComponent(v), {
        headers: { Accept: 'application/json' },
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (body) {
          var c = body.customer;
          if (!c) {
            hint.textContent = 'New customer.';
            return;
          }
          var name = $('[data-staff-name]', form);
          var email = $('[data-staff-email]', form);
          if (!name.value) name.value = c.name;
          if (!email.value && c.email) email.value = c.email;
          var visits = c._count ? c._count.bookings : 0;
          hint.textContent =
            'Returning: ' +
            c.name +
            ' · ' +
            visits +
            ' booking' +
            (visits === 1 ? '' : 's') +
            (c.noShowCount
              ? ' · ' + c.noShowCount + ' no-show' + (c.noShowCount === 1 ? '' : 's')
              : '');
          hint.classList.toggle('is-warn', !!c.noShowCount);
        })
        .catch(function () {});
    };
    phone.addEventListener('blur', lookup);

    form.addEventListener('submit', function () {
      var btn = $('[data-staff-submit]', form);
      setTimeout(function () {
        btn.disabled = true;
        var label = btn.querySelector('.btn-roll-a') || btn;
        label.textContent = 'Booking…';
      }, 0);
    });

    syncType();
    load();
  }
})();
