const crypto = require('crypto');

// No 0/O, 1/I/L — easy to read out over the phone.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateReference(prefix = 'VE') {
  let code = '';
  for (let i = 0; i < 5; i += 1) code += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  return `${prefix}-${code}`;
}

// 32 random bytes → 43-char URL-safe token for /manage/:token.
function generateManageToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = { generateReference, generateManageToken, REF_ALPHABET };
