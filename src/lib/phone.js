// Normalise Nigerian mobile numbers to E.164 (+234XXXXXXXXXX).
// Accepts 0803 123 4567, 803-123-4567, 2348031234567, +234 (0) 803 123 4567.
function normaliseNgPhone(input) {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('2340')) digits = '234' + digits.slice(4);
  if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (/[^\d]/.test(digits)) return null;
  // NG mobile subscriber numbers: 10 digits starting 7, 8 or 9.
  if (!/^[789][01]\d{8}$/.test(digits)) return null;
  return `+234${digits}`;
}

// "+2348030000002" → "+234 803 000 0002" for display; anything else is returned unchanged.
function formatNgPhone(e164) {
  const m = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(String(e164 || ''));
  return m ? `+234 ${m[1]} ${m[2]} ${m[3]}` : String(e164 || '');
}

module.exports = { normaliseNgPhone, formatNgPhone };
