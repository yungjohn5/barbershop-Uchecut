// Helpers exposed to every EJS view via app.locals.

// Kobo → "₦7,500" (no decimals unless there are kobo).
function naira(kobo) {
  const value = kobo / 100;
  return `₦${value.toLocaleString('en-NG', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function duration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// Responsive images are stored as `${base}-${width}.webp` (see docs/ARCHITECTURE.md).
function srcset(base, widths) {
  return widths.map((w) => `${base}-${w}.webp ${w}w`).join(', ');
}

function src(base, widths) {
  return `${base}-${widths[widths.length - 1]}.webp`;
}

const pad2 = (n) => String(n).padStart(2, '0');

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// Editable copy may mark one accent word with *asterisks*; output is escaped HTML.
function rich(text) {
  return escapeHtml(text).replace(/\*([^*]+)\*/g, '<em class="accent">$1</em>');
}

// Plain version of the same copy (for aria-labels, titles).
const plain = (text) => String(text).replace(/\*/g, '');

const { formatNgPhone: fmtPhone } = require('./phone');

module.exports = { naira, duration, srcset, src, pad2, rich, plain, fmtPhone };
