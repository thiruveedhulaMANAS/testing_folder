const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  categories: [],
  cartCount: 0
};

const app = document.getElementById('app');
const categoryNav = document.getElementById('categoryNav');
const search = document.getElementById('search');
const cartBtn = document.getElementById('cartBtn');
const guestNav = document.getElementById('guestNav');
const userNav = document.getElementById('userNav');
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const adminLink = document.getElementById('adminLink');
const logoutBtn = document.getElementById('logoutBtn');

// Send an anonymous visitor to the standalone login page, remembering the
// hash they were on so they can be dropped back where they were.
function goToLogin() {
  const next = encodeURIComponent('/' + location.hash);
  window.location.href = `/login?next=${next}`;
}

// Keep the guest nav's Login/Register links pointed at wherever the
// shopper currently is, so signing in drops them back at the same spot.
function updateGuestNavLinks() {
  const next = encodeURIComponent('/' + location.hash);
  guestNav.querySelectorAll('a').forEach((a) => {
    const base = a.getAttribute('href').split('?')[0];
    a.href = `${base}?next=${next}`;
  });
}

function headers(json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...headers(Boolean(options.body)), ...options.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function money(v) {
  return `$${Number(v).toFixed(2)}`;
}

function stars(rating, count) {
  if (!rating) return '';
  const full = Math.round(rating);
  return `<div class="rating">${'★'.repeat(full)}${'☆'.repeat(5 - full)} ${rating.toFixed(1)} <span class="count">(${count || 0})</span></div>`;
}

// --- Impression / event tracking beacons -----------------------------------
// Hash-based SPA navigation doesn't produce a fresh HTTP request the
// server-side pageImpressionLogger middleware could observe, so the client
// reports PAGE_VIEW itself. sendBeacon fires-and-forgets without blocking
// navigation or adding latency to the page transition.
function beacon(path, body) {
  const payload = JSON.stringify(body);
  if (navigator.sendBeacon) {
    navigator.sendBeacon(path, new Blob([payload], { type: 'application/json' }));
  } else {
    fetch(path, { method: 'POST', headers: headers(true), body: payload, keepalive: true }).catch(() => {});
  }
}

function trackPageView(page) {
  beacon('/api/track/page-view', { page, path: location.hash || '#/' });
}

let dwellStart = null;
let dwellProductId = null;
function startDwell(productId) {
  flushDwell();
  dwellStart = Date.now();
  dwellProductId = productId;
}
function flushDwell() {
  if (dwellProductId && dwellStart) {
    beacon('/api/track/dwell', { productId: dwellProductId, dwellTimeMs: Date.now() - dwellStart });
  }
  dwellStart = null;
  dwellProductId = null;
}
window.addEventListener('beforeunload', flushDwell);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDwell();
});

function setSession(token, user) {
  state.token = token;
  state.user = user;
  if (token) {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
  } else {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }
  renderAuth();
}

function initials(fullName) {
  return fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

// Reactively swap the nav between the logged-out (Login/Register) and
// logged-in (avatar/name/Logout) states. Called after every login/logout
// and on load — no page reload required.
function renderAuth() {
  if (state.user) {
    guestNav.hidden = true;
    userNav.hidden = false;
    userAvatar.textContent = initials(state.user.fullName);
    userName.textContent = state.user.fullName.split(' ')[0];
    adminLink.hidden = state.user.role !== 'admin';
  } else {
    guestNav.hidden = false;
    userNav.hidden = true;
    adminLink.hidden = true;
    updateGuestNavLinks();
  }
}

// Cross-tab sync: if the user logs in or out in another tab, this tab's
// header (and cart count) picks it up immediately without a manual
// refresh, since both tabs share the same localStorage.
window.addEventListener('storage', (e) => {
  if (e.key !== 'token' && e.key !== 'user') return;
  state.token = localStorage.getItem('token');
  state.user = JSON.parse(localStorage.getItem('user') || 'null');
  renderAuth();
  refreshCartCount();
});

function route() {
  flushDwell();
  if (!state.user) updateGuestNavLinks();
  const hash = location.hash.replace('#', '') || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'product' && parts[1]) {
    trackPageView('PRODUCT_DETAIL');
    return renderProduct(parts[1]);
  }
  if (parts[0] === 'cart') {
    trackPageView('CART');
    return renderCart();
  }
  if (parts[0] === 'orders') {
    trackPageView('ORDERS');
    return renderOrders();
  }
  trackPageView(hash.includes('?') ? 'CATEGORY_LIST' : 'HOME');
  return renderCatalog();
}

async function loadCategories() {
  state.categories = await api('/api/categories');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const current = params.get('category') || '';
  categoryNav.innerHTML = [
    `<a href="#/" class="${!current ? 'active' : ''}">All</a>`,
    ...state.categories.map(
      (c) => `<a href="#/?category=${c.slug}" class="${current === c.slug ? 'active' : ''}">${c.name}</a>`
    )
  ].join('');
}

async function refreshCartCount() {
  if (!state.token) {
    document.getElementById('cartCount').textContent = '0';
    return;
  }
  try {
    const cart = await api('/api/cart');
    const n = cart.items.reduce((s, i) => s + i.quantity, 0);
    document.getElementById('cartCount').textContent = String(n);
  } catch {
    document.getElementById('cartCount').textContent = '0';
  }
}

function productCard(p) {
  return `
    <article class="card">
      <a href="#/product/${p.id}"><img alt="" src="${p.imageUrl}" /></a>
      <div class="body">
        <div class="muted">${p.category.name}</div>
        <h3><a href="#/product/${p.id}">${p.name}</a></h3>
        <div class="price">
          <strong>${money(p.displayPrice)}</strong>
          ${p.onSale ? `<span class="old">${money(p.price)}</span><span class="sale">Sale</span>` : ''}
        </div>
        ${stars(p.rating, p.ratingCount)}
        <div class="muted stock ${p.inStock ? '' : 'out'}">${p.inStock ? `${p.stock} in stock` : 'Out of stock'}</div>
        <div class="row">
          <button ${p.inStock ? '' : 'disabled'} data-add="${p.id}">Add to cart</button>
        </div>
      </div>
    </article>`;
}

async function renderCatalog() {
  const qs = location.hash.includes('?') ? location.hash.split('?')[1] : '';
  const params = new URLSearchParams(qs);
  if (search.value && !params.get('q')) params.set('q', search.value);
  const query = params.toString();
  const products = await api('/api/products' + (query ? `?${query}` : ''));
  await loadCategories();
  app.innerHTML = `
    <h1>Catalog</h1>
    <p class="muted">Filter by category, search, price, rating, and live stock. Prices include active sale markdowns.</p>
    <div class="filters">
      <label>Min price <input id="fMinPrice" type="number" min="0" value="${params.get('min_price') || ''}" /></label>
      <label>Max price <input id="fMaxPrice" type="number" min="0" value="${params.get('max_price') || ''}" /></label>
      <label>Min rating
        <select id="fMinRating">
          <option value="">Any</option>
          ${[4.5, 4, 3.5, 3].map((r) => `<option value="${r}" ${params.get('min_rating') === String(r) ? 'selected' : ''}>${r}+</option>`).join('')}
        </select>
      </label>
      <label>Sort
        <select id="fSort">
          ${[
            ['', 'Relevance'],
            ['price_asc', 'Price: low to high'],
            ['price_desc', 'Price: high to low'],
            ['rating', 'Top rated']
          ].map(([v, l]) => `<option value="${v}" ${params.get('sort') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <label class="row" style="flex-direction:row;align-items:center;gap:0.4rem;">
        <input id="fInStock" type="checkbox" style="width:auto;" ${params.get('in_stock') === 'true' ? 'checked' : ''} /> In stock only
      </label>
      <button class="apply" id="fApply" type="button">Apply</button>
    </div>
    <div class="grid">${products.map(productCard).join('') || '<p>No products match.</p>'}</div>`;
  bindAddButtons();

  document.getElementById('fApply').addEventListener('click', () => {
    const p = new URLSearchParams(location.hash.split('?')[1] || '');
    const minPrice = document.getElementById('fMinPrice').value;
    const maxPrice = document.getElementById('fMaxPrice').value;
    const minRating = document.getElementById('fMinRating').value;
    const sort = document.getElementById('fSort').value;
    const inStock = document.getElementById('fInStock').checked;
    minPrice ? p.set('min_price', minPrice) : p.delete('min_price');
    maxPrice ? p.set('max_price', maxPrice) : p.delete('max_price');
    minRating ? p.set('min_rating', minRating) : p.delete('min_rating');
    sort ? p.set('sort', sort) : p.delete('sort');
    inStock ? p.set('in_stock', 'true') : p.delete('in_stock');
    location.hash = '#/' + (p.toString() ? `?${p.toString()}` : '');
    route();
  });
}

async function renderProduct(id) {
  // PRODUCT_VIEW is recorded server-side (audit.trackEvent) as soon as this
  // GET resolves; dwell time is measured client-side and flushed via
  // sendBeacon when the shopper navigates away (see startDwell/flushDwell).
  const p = await api(`/api/products/${id}`);
  startDwell(p.id);
  await loadCategories();
  app.innerHTML = `
    <article class="detail">
      <img alt="" src="${p.imageUrl}" style="height:280px" />
      <p class="muted">${p.category.name} · ${p.sku}</p>
      <h1>${p.name}</h1>
      ${stars(p.rating, p.ratingCount)}
      <p>${p.description}</p>
      <div class="price">
        <strong>${money(p.displayPrice)}</strong>
        ${p.onSale ? `<span class="old">${money(p.price)}</span>` : ''}
      </div>
      <p class="muted stock ${p.inStock ? '' : 'out'}">${p.inStock ? `${p.stock} available` : 'Out of stock'}</p>
      <div class="row">
        <button ${p.inStock ? '' : 'disabled'} data-add="${p.id}">Add to cart</button>
        <a class="ghost" href="#/">Back</a>
      </div>
    </article>`;
  bindAddButtons();
}

function bindAddButtons() {
  app.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.token) {
        goToLogin();
        return;
      }
      try {
        await api('/api/cart/items', {
          method: 'POST',
          body: JSON.stringify({ productId: Number(btn.dataset.add), quantity: 1 })
        });
        await refreshCartCount();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

async function renderCart() {
  if (!state.token) {
    app.innerHTML = `<div class="panel"><h1>Cart</h1><p>Sign in to view your persistent cart. <a href="/login?next=${encodeURIComponent('/#/cart')}">Sign in</a></p></div>`;
    return;
  }
  const cart = await api('/api/cart');
  app.innerHTML = `
    <div class="panel">
      <h1>Cart</h1>
      ${cart.items.map((item) => `
        <div class="cart-line">
          <div>
            <strong>${item.name}</strong>
            <div class="muted">${money(item.unitPrice)} · stock ${item.stock}</div>
          </div>
          <input data-qty="${item.productId}" type="number" min="1" max="${item.stock}" value="${item.quantity}" />
          <div>
            ${money(item.lineTotal)}
            <button class="ghost" data-remove="${item.productId}">Remove</button>
          </div>
        </div>`).join('') || '<p class="muted">Your cart is empty.</p>'}
      <p><strong>Subtotal ${money(cart.subtotal || 0)}</strong></p>
      <div class="row">
        <button id="checkoutBtn" ${cart.items.length ? '' : 'disabled'}>Checkout</button>
        <a class="ghost" href="#/orders">Orders</a>
      </div>
    </div>`;

  app.querySelectorAll('[data-qty]').forEach((input) => {
    input.addEventListener('change', async () => {
      try {
        await api(`/api/cart/items/${input.dataset.qty}`, {
          method: 'PATCH',
          body: JSON.stringify({ quantity: Number(input.value) })
        });
        await refreshCartCount();
        renderCart();
      } catch (err) {
        alert(err.message);
      }
    });
  });
  app.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/cart/items/${btn.dataset.remove}`, { method: 'DELETE' });
      await refreshCartCount();
      renderCart();
    });
  });
  const checkoutBtn = document.getElementById('checkoutBtn');
  if (checkoutBtn) {
    checkoutBtn.addEventListener('click', async () => {
      try {
        const order = await api('/api/checkout', { method: 'POST', body: '{}' });
        await refreshCartCount();
        location.hash = '#/orders';
        alert(`Order ${order.id} completed · total ${money(order.total)}`);
      } catch (err) {
        alert(err.message);
      }
    });
  }
}

async function renderOrders() {
  if (!state.token) {
    app.innerHTML = `<div class="panel"><h1>Orders</h1><p>Sign in to see purchases. <a href="/login?next=${encodeURIComponent('/#/orders')}">Sign in</a></p></div>`;
    return;
  }
  const orders = await api('/api/orders');
  app.innerHTML = `
    <div class="panel">
      <h1>Orders</h1>
      ${orders.map((o) => `
        <div class="cart-line">
          <div>
            <strong>${o.status}</strong>
            <div class="muted">${new Date(o.createdAt).toLocaleString()}</div>
          </div>
          <div></div>
          <div>${money(o.total)}</div>
        </div>`).join('') || '<p class="muted">No orders yet.</p>'}
    </div>`;
}

cartBtn.addEventListener('click', () => {
  location.hash = '#/cart';
});

logoutBtn.addEventListener('click', () => {
  setSession(null, null);
  refreshCartCount();
  route();
});

let searchTimer;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (search.value) params.set('q', search.value);
    else params.delete('q');
    const cat = params.get('category');
    location.hash = '#/' + (params.toString() ? `?${params.toString()}` : '');
    if (!cat && !search.value) location.hash = '#/';
    route();
  }, 250);
});

window.addEventListener('hashchange', route);
renderAuth();
refreshCartCount();
route();
