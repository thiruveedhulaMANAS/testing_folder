const authForm = document.getElementById('authForm');
const authSubmit = document.getElementById('authSubmit');
const authError = document.getElementById('authError');
const loginLink = document.getElementById('loginLink');
const strengthMeter = document.getElementById('strengthMeter');
const strengthBar = document.getElementById('strengthBar');
const strengthLabel = document.getElementById('strengthLabel');
const passwordInput = authForm.querySelector('[name="password"]');

function nextParam() {
  return new URLSearchParams(window.location.search).get('next') || '/';
}

const next = new URLSearchParams(window.location.search).get('next');
if (next) {
  loginLink.href = `/login?next=${encodeURIComponent(next)}`;
}

// Already signed in? Bounce straight back rather than showing the form.
if (localStorage.getItem('token')) {
  window.location.replace(nextParam());
}

function setFieldError(field, message) {
  const el = document.getElementById(`err-${field}`);
  const input = authForm.querySelector(`[name="${field}"]`);
  if (message) {
    el.textContent = message;
    el.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  } else {
    el.hidden = true;
    input.removeAttribute('aria-invalid');
  }
}

// Live password strength meter (min 8 chars is the hard requirement,
// same as the server; the meter just gives feedback on top of that).
passwordInput.addEventListener('input', () => {
  const value = passwordInput.value;
  if (!value) {
    strengthMeter.hidden = true;
    return;
  }
  strengthMeter.hidden = false;
  const { score, label } = passwordStrength(value);
  strengthBar.style.width = `${(score / 4) * 100}%`;
  strengthBar.dataset.level = String(score);
  strengthLabel.textContent = label;
});

function validate(fd) {
  let ok = true;

  const fullName = String(fd.get('fullName') || '').trim();
  if (fullName.length < 2) {
    setFieldError('fullName', 'Enter your full name.');
    ok = false;
  } else {
    setFieldError('fullName', null);
  }

  const email = fd.get('email');
  if (!isValidEmail(email)) {
    setFieldError('email', 'Enter a valid email address.');
    ok = false;
  } else {
    setFieldError('email', null);
  }

  const phoneNumber = fd.get('phoneNumber');
  if (!isValidPhone(phoneNumber)) {
    setFieldError('phoneNumber', 'Enter a valid phone number (at least 7 digits).');
    ok = false;
  } else {
    setFieldError('phoneNumber', null);
  }

  const password = fd.get('password');
  const strength = passwordStrength(password);
  if (!strength.ok) {
    setFieldError('password', 'Password must be at least 8 characters.');
    ok = false;
  } else {
    setFieldError('password', null);
  }

  return ok;
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.hidden = true;

  const fd = new FormData(authForm);
  if (!validate(fd)) return;

  authSubmit.disabled = true;
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: fd.get('fullName'),
        email: fd.get('email'),
        phoneNumber: fd.get('phoneNumber'),
        password: fd.get('password')
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not create account');

    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    window.location.href = nextParam();
  } catch (err) {
    authError.hidden = false;
    authError.textContent = err.message;
    authSubmit.disabled = false;
  }
});
