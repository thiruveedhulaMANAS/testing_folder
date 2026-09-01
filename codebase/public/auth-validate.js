// Shared client-side validation for the login and register pages.
// Mirrors the server-side rules in src/routes/auth.js so users get instant
// feedback, but the server remains the source of truth.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Optional leading +, digits, spaces, dashes, dots, parentheses; at least
// 7 digits total so short/garbage input is rejected. Matches PHONE_RE in
// src/routes/auth.js.
const PHONE_RE = /^\+?[0-9()\-.\s]{7,20}$/;

function isValidEmail(email) {
  return EMAIL_RE.test(String(email || '').trim());
}

function isValidPhone(phone) {
  const value = String(phone || '').trim();
  const digits = value.replace(/\D/g, '');
  return PHONE_RE.test(value) && digits.length >= 7;
}

// Returns { score: 0-4, label, ok } where ok = true once the password
// meets the minimum bar the server also enforces (8+ chars). Score adds
// credit for length/character variety so the UI can show a strength meter.
function passwordStrength(password) {
  const value = String(password || '');
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;

  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  return {
    score,
    label: labels[score],
    ok: value.length >= 8
  };
}
