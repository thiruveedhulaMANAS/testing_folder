const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  // Per-tab state persists across route switches within the same page
  // load (spec: "full UI state persistence across dynamic route
  // switches") so paging/search isn't lost when an admin flips tabs and
  // comes back.
  tabState: {
    users: { page: 1, q: '', role: '' },
    products: { page: 1, q: '' },
    orders: { page: 1, status: '' },
    marketing: { activeStream: null }
  }
};

const root = document.getElementById('adminRoot');
const deniedPanel = document.getElementById('adminDenied');
const deniedMessage = document.getElementById('adminDeniedMessage');
const main = document.getElementById('adminMain');
const nav = document.getElementById('adminNav');
const emailLabel = document.getElementById('adminEmail');

function goToLogin() {
  window.location.href = '/login?next=%2Fadmin';
}

function showDenied(message) {
  deniedMessage.textContent = message;
  deniedPanel.hidden = false;
  root.hidden = true;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    goToLogin();
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function paginationControls(tabKey, meta, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-pagination';
  const info = document.createElement('span');
  info.className = 'muted';
  info.textContent = `Page ${meta.page} of ${meta.totalPages} · ${meta.total} total`;
  const prev = document.createElement('button');
  prev.className = 'ghost';
  prev.textContent = 'Prev';
  prev.disabled = meta.page <= 1;
  prev.onclick = () => onChange(meta.page - 1);
  const next = document.createElement('button');
  next.className = 'ghost';
  next.textContent = 'Next';
  next.disabled = meta.page >= meta.totalPages;
  next.onclick = () => onChange(meta.page + 1);
  wrap.append(prev, info, next);
  return wrap;
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------
async function renderUsers() {
  const s = state.tabState.users;
  main.innerHTML = `
    <h1>Users</h1>
    <p class="admin-subtitle">Everyone with an account, pulled live from PostgreSQL.</p>
    <div class="admin-toolbar">
      <input id="userSearch" type="search" placeholder="Search name or email" value="${esc(s.q)}" />
      <select id="userRoleFilter">
        <option value="">All roles</option>
        <option value="user" ${s.role === 'user' ? 'selected' : ''}>User</option>
        <option value="admin" ${s.role === 'admin' ? 'selected' : ''}>Admin</option>
      </select>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr>
          <th>ID</th><th>Full Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Created At</th><th>Total Orders</th>
        </tr></thead>
        <tbody id="userRows"><tr><td colspan="7" class="admin-loading">Loading…</td></tr></tbody>
      </table>
      <div id="userPagination"></div>
    </div>
  `;

  document.getElementById('userSearch').addEventListener('input', debounce((e) => {
    s.q = e.target.value;
    s.page = 1;
    loadUsers();
  }, 300));
  document.getElementById('userRoleFilter').addEventListener('change', (e) => {
    s.role = e.target.value;
    s.page = 1;
    loadUsers();
  });

  await loadUsers();
}

async function loadUsers() {
  const s = state.tabState.users;
  const tbody = document.getElementById('userRows');
  const params = new URLSearchParams({ page: s.page, pageSize: 20 });
  if (s.q) params.set('q', s.q);
  if (s.role) params.set('role', s.role);

  try {
    const result = await api(`/api/admin/users?${params}`);
    if (!result.data.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">No users match.</td></tr>';
    } else {
      tbody.innerHTML = result.data.map((u) => `
        <tr>
          <td title="${esc(u.id)}">${esc(u.id.slice(0, 8))}…</td>
          <td>${esc(u.fullName)}</td>
          <td>${esc(u.email)}</td>
          <td>${esc(u.phone)}</td>
          <td><span class="badge ${u.role === 'admin' ? 'badge-ok' : 'badge-muted'}">${esc(u.role)}</span></td>
          <td>${fmtDate(u.createdAt)}</td>
          <td>${u.totalOrders}</td>
        </tr>
      `).join('');
    }
    document.getElementById('userPagination').replaceChildren(
      paginationControls('users', result, (page) => { s.page = page; loadUsers(); })
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="admin-error">${esc(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// Products tab
// ---------------------------------------------------------------------------
async function renderProducts() {
  const s = state.tabState.products;
  main.innerHTML = `
    <h1>Products</h1>
    <p class="admin-subtitle">Catalog CRUD. Stock under 10 units is flagged low.</p>
    <div class="admin-toolbar">
      <input id="productSearch" type="search" placeholder="Search name or SKU" value="${esc(s.q)}" />
      <button id="addProductBtn">Add product</button>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr>
          <th>Image</th><th>Product Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Updated At</th><th></th>
        </tr></thead>
        <tbody id="productRows"><tr><td colspan="7" class="admin-loading">Loading…</td></tr></tbody>
      </table>
      <div id="productPagination"></div>
    </div>
  `;

  document.getElementById('productSearch').addEventListener('input', debounce((e) => {
    s.q = e.target.value;
    s.page = 1;
    loadProducts();
  }, 300));
  document.getElementById('addProductBtn').addEventListener('click', () => openProductModal(null));

  await loadProducts();
}

async function loadProducts() {
  const s = state.tabState.products;
  const tbody = document.getElementById('productRows');
  const params = new URLSearchParams({ page: s.page, pageSize: 20 });
  if (s.q) params.set('q', s.q);

  try {
    const result = await api(`/api/admin/products?${params}`);
    if (!result.data.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="admin-empty">No products match.</td></tr>';
    } else {
      tbody.innerHTML = result.data.map((p) => `
        <tr>
          <td>${p.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="">` : '—'}</td>
          <td>${esc(p.name)}<div class="muted" style="font-size:.75rem">${esc(p.sku)}</div></td>
          <td>${esc(p.category.name)}</td>
          <td>${p.salePrice ? `<s class="muted">$${p.price}</s> $${p.salePrice}` : `$${p.price}`}</td>
          <td>${p.lowStock ? `<span class="badge badge-danger">${p.stock} left</span>` : p.stock}</td>
          <td>${fmtDate(p.updatedAt)}</td>
          <td><button class="ghost" data-edit="${p.id}">Edit</button></td>
        </tr>
      `).join('');
      tbody.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const product = result.data.find((p) => String(p.id) === btn.dataset.edit);
          openProductModal(product);
        });
      });
    }
    document.getElementById('productPagination').replaceChildren(
      paginationControls('products', result, (page) => { s.page = page; loadProducts(); })
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="admin-error">${esc(err.message)}</td></tr>`;
  }
}

function openProductModal(product) {
  const isEdit = Boolean(product);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <h3>${isEdit ? 'Update product' : 'Add product'}</h3>
      <form id="productForm">
        ${!isEdit ? `
          <div class="modal-field"><label>SKU</label><input name="sku" required /></div>
          <div class="modal-field"><label>Category ID</label><input name="categoryId" type="number" min="1" required /></div>
          <div class="modal-field"><label>Description</label><textarea name="description" required></textarea></div>
        ` : ''}
        <div class="modal-field"><label>Name</label><input name="name" value="${isEdit ? esc(product.name) : ''}" required /></div>
        <div class="modal-field"><label>Price (USD)</label><input name="price" type="number" step="0.01" min="0" value="${isEdit ? product.price : ''}" required /></div>
        <div class="modal-field"><label>Sale price (optional)</label><input name="salePrice" type="number" step="0.01" min="0" value="${isEdit && product.salePrice ? product.salePrice : ''}" /></div>
        <div class="modal-field"><label>Stock</label><input name="stock" type="number" min="0" value="${isEdit ? product.stock : 0}" required /></div>
        <div class="modal-field"><label>Image URL</label><input name="imageUrl" value="${isEdit ? esc(product.imageUrl || '') : ''}" /></div>
        <div id="productModalError" class="modal-error" hidden></div>
        <div class="modal-actions">
          <button type="button" class="ghost" id="productModalCancel">Cancel</button>
          <button type="submit">${isEdit ? 'Save changes' : 'Create product'}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#productModalCancel').addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  backdrop.querySelector('#productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errorEl = backdrop.querySelector('#productModalError');
    errorEl.hidden = true;

    const payload = {
      name: fd.get('name'),
      price: Number(fd.get('price')),
      salePrice: fd.get('salePrice') ? Number(fd.get('salePrice')) : null,
      stock: Number(fd.get('stock')),
      imageUrl: fd.get('imageUrl') || null
    };
    if (!isEdit) {
      payload.sku = fd.get('sku');
      payload.categoryId = Number(fd.get('categoryId'));
      payload.description = fd.get('description');
    }

    try {
      if (isEdit) {
        await api(`/api/admin/products/${product.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await api('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) });
      }
      backdrop.remove();
      loadProducts();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Orders tab
// ---------------------------------------------------------------------------
async function renderOrders() {
  const s = state.tabState.orders;
  main.innerHTML = `
    <h1>Orders</h1>
    <p class="admin-subtitle">Live order history and revenue summary.</p>
    <div class="kpi-row" id="orderKpis">
      <div class="kpi-card"><div class="kpi-label">Total Revenue</div><div class="kpi-value">…</div></div>
      <div class="kpi-card"><div class="kpi-label">Active Orders</div><div class="kpi-value">…</div></div>
      <div class="kpi-card"><div class="kpi-label">Avg Order Value</div><div class="kpi-value">…</div></div>
    </div>
    <div class="admin-toolbar">
      <select id="orderStatusFilter">
        <option value="">All statuses</option>
        <option value="pending" ${s.status === 'pending' ? 'selected' : ''}>Pending</option>
        <option value="completed" ${s.status === 'completed' ? 'selected' : ''}>Completed</option>
        <option value="cancelled" ${s.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
      </select>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Order ID</th><th>Customer Email</th><th>Total Amount</th><th>Status</th><th>Timestamp</th></tr></thead>
        <tbody id="orderRows"><tr><td colspan="5" class="admin-loading">Loading…</td></tr></tbody>
      </table>
      <div id="orderPagination"></div>
    </div>
  `;

  document.getElementById('orderStatusFilter').addEventListener('change', (e) => {
    s.status = e.target.value;
    s.page = 1;
    loadOrders();
  });

  loadOrderKpis();
  await loadOrders();
}

async function loadOrderKpis() {
  try {
    const kpis = await api('/api/admin/orders/kpis');
    const cards = document.querySelectorAll('#orderKpis .kpi-value');
    cards[0].textContent = `$${kpis.totalRevenue}`;
    cards[1].textContent = kpis.activeOrders;
    cards[2].textContent = `$${kpis.averageOrderValue}`;
  } catch {
    // KPI failure shouldn't block the order grid below it.
  }
}

async function loadOrders() {
  const s = state.tabState.orders;
  const tbody = document.getElementById('orderRows');
  const params = new URLSearchParams({ page: s.page, pageSize: 20 });
  if (s.status) params.set('status', s.status);

  const statusBadge = (status) => {
    const cls = status === 'COMPLETED' ? 'badge-ok' : status === 'PENDING' ? 'badge-warn' : 'badge-danger';
    return `<span class="badge ${cls}">${status}</span>`;
  };

  try {
    const result = await api(`/api/admin/orders?${params}`);
    if (!result.data.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="admin-empty">No orders match.</td></tr>';
    } else {
      tbody.innerHTML = result.data.map((o) => `
        <tr>
          <td title="${esc(o.id)}">${esc(o.id.slice(0, 8))}…</td>
          <td>${esc(o.customerEmail)}</td>
          <td>$${o.totalAmount}</td>
          <td>${statusBadge(o.status)}</td>
          <td>${fmtDate(o.createdAt)}</td>
        </tr>
      `).join('');
    }
    document.getElementById('orderPagination').replaceChildren(
      paginationControls('orders', result, (page) => { s.page = page; loadOrders(); })
    );
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-error">${esc(err.message)}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// Marketing Automation tab
// ---------------------------------------------------------------------------
let activeStreamController = null;
let activeMarketingRunId = null;

async function renderMarketing() {
  main.innerHTML = `
    <h1>Marketing Automation</h1>
    <p class="admin-subtitle">Trigger and monitor the Marketing Agent pipeline. Review the latest AAVA response from GitHub Content/Content.txt before approval.</p>
    <div class="marketing-grid">
      <form id="marketingForm" class="marketing-form">
        <div class="modal-field">
          <label for="campaignName">Campaign Name <span class="muted">(optional)</span></label>
          <input id="campaignName" name="campaignName" type="text" maxlength="200" placeholder="e.g. Summer Re-engagement" />
        </div>
        <div class="modal-field">
          <label for="campaignDetails">Campaign Details <span class="muted">(optional)</span></label>
          <textarea id="campaignDetails" name="campaignDetails" rows="6" maxlength="5000" placeholder="Describe the campaign objective, audience, offer, or other context."></textarea>
        </div>
        <div class="modal-field">
          <label>Pipeline</label>
          <div id="pipelineLabel" class="pipeline-label">Loading…</div>
        </div>
        <div id="marketingFormError" class="modal-error" hidden></div>
        <button type="submit" id="triggerBtn">Trigger pipeline</button>
        <div id="runStatus" class="run-status"></div>
      </form>
      <div>
        <div class="console-panel" id="consolePanel">
          <div class="console-line meta">No run yet in this session.</div>
        </div>
        <section class="approval-panel" id="approvalPanel" hidden>
          <div class="approval-header">
            <h2>AAVA Response <span class="muted">(Content/Content.txt)</span></h2>
            <span id="approvalStatus" class="approval-state">Waiting…</span>
          </div>
          <pre id="aavaOutput" class="aava-output"></pre>
          <div id="approvalError" class="modal-error" hidden></div>
          <div class="approval-actions">
            <button type="button" id="rejectBtn" class="ghost" disabled>Reject &amp; Regenerate</button>
            <button type="button" id="approveBtn" disabled>Approve</button>
          </div>
        </section>
      </div>
    </div>
  `;

  if (activeStreamController) {
    activeStreamController.abort();
    activeStreamController = null;
  }
  activeMarketingRunId = null;

  try {
    const pipeline = await api('/api/admin/marketing/pipeline');
    document.getElementById('pipelineLabel').innerHTML =
      `<strong>${esc(pipeline.label)}</strong><br /><span class="muted">${esc(pipeline.description)}</span>`;
  } catch (err) {
    document.getElementById('marketingFormError').textContent = err.message;
    document.getElementById('marketingFormError').hidden = false;
  }

  document.getElementById('marketingForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('marketingFormError');
    const triggerBtn = document.getElementById('triggerBtn');
    const campaignName = document.getElementById('campaignName').value.trim();
    const campaignDetails = document.getElementById('campaignDetails').value.trim();
    errorEl.hidden = true;
    triggerBtn.disabled = true;

    try {
      const resp = await api('/api/admin/marketing/trigger', {
        method: 'POST',
        body: JSON.stringify({ campaignName, campaignDetails })
      });
      activeMarketingRunId = resp.runId;
      streamRun(resp.runId);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      triggerBtn.disabled = false;
    }
  });
}

function renderAavaResponse(response) {
  const output = document.getElementById('aavaOutput');
  if (!output) return;
  output.textContent = response ? JSON.stringify(response, null, 2).replace(/\\n/g, '\n') : '';
}

function setApprovalControls(enabled) {
  const approveBtn = document.getElementById('approveBtn');
  const rejectBtn = document.getElementById('rejectBtn');
  if (approveBtn) approveBtn.disabled = !enabled;
  if (rejectBtn) rejectBtn.disabled = !enabled;
}

function updateApprovalState(state) {
  const panel = document.getElementById('approvalPanel');
  const statusEl = document.getElementById('approvalStatus');
  if (!panel || !statusEl) return;

  panel.hidden = false;
  renderAavaResponse(state.response);
  const approvalStatus = state.approvalStatus || state.status;
  const runStatus = document.getElementById('runStatus');
  if (runStatus && approvalStatus === 'awaiting_approval') {
    runStatus.textContent = 'Awaiting approval';
    runStatus.className = 'run-status running';
  } else if (runStatus && approvalStatus === 'approved' && state.status === 'email_sending') {
    runStatus.textContent = 'Approved — sending emails…';
    runStatus.className = 'run-status running';
  }
  statusEl.textContent = approvalStatus === 'awaiting_approval'
    ? 'Awaiting approval'
    : approvalStatus === 'rejected'
      ? 'Regenerating…'
      : approvalStatus === 'approved'
        ? (state.status === 'email_sending' ? 'Approved — sending emails…' : 'Approved')
        : approvalStatus === 'failed'
          ? 'Failed'
          : 'Processing…';
  statusEl.className = `approval-state ${approvalStatus || ''}`;

  const errorEl = document.getElementById('approvalError');
  if (errorEl) {
    errorEl.textContent = state.error || '';
    errorEl.hidden = !state.error;
  }
  setApprovalControls(approvalStatus === 'awaiting_approval');
}

async function decideMarketingRun(action) {
  if (!activeMarketingRunId) return;
  setApprovalControls(false);
  const endpoint = action === 'approve' ? 'approve' : 'reject';
  try {
    await api(`/api/admin/marketing/runs/${activeMarketingRunId}/${endpoint}`, { method: 'POST', body: '{}' });
    const statusEl = document.getElementById('approvalStatus');
    if (statusEl) statusEl.textContent = action === 'approve' ? 'Approving…' : 'Regenerating…';
  } catch (err) {
    const errorEl = document.getElementById('approvalError');
    if (errorEl) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
    setApprovalControls(true);
  }
}

async function streamRun(runId) {
  if (activeStreamController) activeStreamController.abort();

  const consolePanel = document.getElementById('consolePanel');
  const runStatus = document.getElementById('runStatus');
  const triggerBtn = document.getElementById('triggerBtn');
  consolePanel.innerHTML = '';
  runStatus.textContent = 'Running…';
  runStatus.className = 'run-status running';
  setApprovalControls(false);
  document.getElementById('approvalPanel').hidden = true;

  const appendLine = (text, cls = '') => {
    const line = document.createElement('div');
    line.className = `console-line ${cls}`;
    line.textContent = text;
    consolePanel.appendChild(line);
    consolePanel.scrollTop = consolePanel.scrollHeight;
  };

  const controller = new AbortController();
  activeStreamController = controller;
  const processEvent = (eventName, data) => {
    if (eventName === 'log') {
      const payload = JSON.parse(data);
      appendLine(payload.line, payload.stream === 'stderr' ? 'stderr' : '');
    } else if (eventName === 'approval') {
      updateApprovalState(JSON.parse(data));
    } else if (eventName === 'exit') {
      const payload = JSON.parse(data);
      appendLine(`[runner] Finished with status "${payload.status}" (exit code ${payload.code}).`, 'meta');
      runStatus.textContent = payload.status === 'succeeded' ? 'Succeeded' : payload.status === 'failed' ? 'Failed' : payload.status;
      runStatus.className = `run-status ${payload.status}`;
      triggerBtn.disabled = false;
    }
  };

  document.getElementById('approveBtn').onclick = () => decideMarketingRun('approve');
  document.getElementById('rejectBtn').onclick = () => decideMarketingRun('reject');

  try {
    const response = await fetch(`/api/admin/marketing/stream/${runId}`, {
      headers: { Authorization: `Bearer ${state.token}`, Accept: 'text/event-stream' },
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(body || `Stream request failed (${response.status})`);
    }
    if (!response.body) throw new Error('Streaming is not supported by this browser.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        let eventName = 'message';
        let data = '';
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) processEvent(eventName, data);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      appendLine(`[runner] Connection lost: ${err.message}`, 'meta');
      // Fetch the durable approval snapshot so a dropped stream cannot hide
      // an approval decision that is already ready.
      try {
        const state = await api(`/api/admin/marketing/runs/${runId}/approval`);
        updateApprovalState(state);
        if (state.status === 'awaiting_approval' || state.approvalStatus === 'awaiting_approval') {
          runStatus.textContent = 'Awaiting approval';
          runStatus.className = 'run-status running';
          triggerBtn.disabled = true;
        }
      } catch (snapshotErr) {
        appendLine(`[runner] Unable to recover workflow state: ${snapshotErr.message}`, 'stderr');
      }
    }
  } finally {
    if (activeStreamController === controller) activeStreamController = null;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
const routes = { users: renderUsers, products: renderProducts, orders: renderOrders, marketing: renderMarketing };

function currentTab() {
  const hash = location.hash.replace(/^#\//, '');
  return routes[hash] ? hash : 'users';
}

function renderRoute() {
  const tab = currentTab();
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  routes[tab]();
}

function debounce(fn, ms) {
  let handle;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

document.getElementById('adminLogout').addEventListener('click', () => {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/';
});

window.addEventListener('hashchange', renderRoute);

// ---------------------------------------------------------------------------
// Bootstrap: verify this really is an admin session before rendering
// anything. This is a UX gate only -- the server enforces the real
// boundary on every /api/admin/* call regardless of what this does.
// ---------------------------------------------------------------------------
async function bootstrap() {
  if (!state.token) return goToLogin();

  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'admin') {
      return showDenied('This account does not have administrator access.');
    }
    state.user = me;
    localStorage.setItem('user', JSON.stringify(me));
    emailLabel.textContent = me.email;
    root.hidden = false;
    if (!location.hash) location.hash = '#/users';
    renderRoute();
  } catch (err) {
    showDenied(err.message || 'Unable to verify admin access.');
  }
}

bootstrap();
