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

module.exports = { naira, duration, srcset, src, pad2 };
