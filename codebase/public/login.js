const authForm = document.getElementById('authForm');
const authSubmit = document.getElementById('authSubmit');
const authError = document.getElementById('authError');
const registerLink = document.getElementById('registerLink');

function nextParam() {
  return new URLSearchParams(window.location.search).get('next') || '/';
}

// Preserve ?next= across to the register page so a shopper who was sent
// here from checkout, cart, etc. lands back in the same place after
// creating an account instead of just at the homepage.
const next = new URLSearchParams(window.location.search).get('next');
if (next) {
  registerLink.href = `/register?next=${encodeURIComponent(next)}`;
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

function validate(fd) {
  let ok = true;
  const email = fd.get('email');
  const password = fd.get('password');

  if (!isValidEmail(email)) {
    setFieldError('email', 'Enter a valid email address.');
    ok = false;
  } else {
    setFieldError('email', null);
  }

  if (!password) {
    setFieldError('password', 'Password is required.');
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
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Invalid email or password');

    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    // Notify any other tabs on this origin immediately (storage events
    // don't fire in the tab that made the change, only other tabs — the
    // navigation below handles this tab's own UI update).
    window.location.href = nextParam();
  } catch (err) {
    authError.hidden = false;
    authError.textContent = err.message;
    authSubmit.disabled = false;
  }
});
