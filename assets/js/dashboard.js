(function () {
  "use strict";
  const api = window.OfferpediaAPI;
  if (!api.getSession()) { location.replace("signin.html"); return; }

  const $ = (s) => document.querySelector(s);
  const view = $("#view");
  const money = (n) => "BD " + Number(n).toFixed(2);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + " min ago";
    if (m < 1440) return Math.round(m / 60) + " h ago"; return Math.round(m / 1440) + " d ago";
  };
  const TITLES = { overview: "Overview", orders: "Orders", products: "Products", customers: "Customers", campaigns: "Campaigns", settings: "Settings" };
  const STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];
  let current = "overview", user = null, newCount = 0, poller = null, token = 0;

  function toast(msg, error) {
    const t = document.createElement("div");
    t.className = "toast" + (error ? " error" : ""); t.textContent = msg;
    $("#toasts").appendChild(t); setTimeout(() => t.remove(), 4500);
  }
  function skeleton() { return '<div class="sk tall"></div><div class="sk"></div><div class="sk"></div><div class="sk"></div>'; }

  /* every API failure funnels here; an expired token bounces to sign-in */
  function fail(err) {
    if (err.status === 401) { location.replace("signin.html"); return; }
    toast(err.message, true);
  }

  api.onRequest((r) => {
    if (r.quiet) return;
    $("#netlog").innerHTML = r.method + " " + r.path + "<br><b class='" + (r.status >= 400 ? "bad" : "") + "'>" + r.status + "</b> · " + r.ms + "ms";
  });

  /* ---------- views ---------- */
  const views = {
    async overview() {
      const o = await api.overview();
      const max = Math.max.apply(null, o.days.map((d) => d.revenue)) || 1;
      const arrow = o.todayDelta >= 0 ? "up" : "down";
      return `
      <div class="cards">
        <div class="card"><div class="k">Total revenue</div><div class="v">${money(o.revenue)}</div><div class="d">Last 7 days shown below</div></div>
        <div class="card"><div class="k">Today</div><div class="v">${money(o.todayRevenue)}</div><div class="d ${arrow}">${o.todayDelta >= 0 ? "▲" : "▼"} ${Math.abs(o.todayDelta)}% vs yesterday</div></div>
        <div class="card"><div class="k">Orders</div><div class="v">${o.orders}</div><div class="d">${o.pending} need attention</div></div>
        <div class="card"><div class="k">Customers</div><div class="v">${o.customers}</div><div class="d">Across Bahrain</div></div>
      </div>
      <div class="grid2">
        <div class="card"><h3>Sales, last 7 days</h3>
          <div class="bars">${o.days.map((d) => `<div class="b"><em>${d.revenue ? Math.round(d.revenue) : ""}</em><i style="height:0" data-h="${Math.max(2, d.revenue / max * 100)}%" title="${d.orders} orders"></i><span>${esc(d.label)}</span></div>`).join("")}</div></div>
        <div class="card"><h3>Low stock</h3>
          ${o.lowStock.length ? `<div class="list-low">${o.lowStock.map((p) => `<div><span>${esc(p.name)}</span><span class="${p.stock < 6 ? "down" : ""}">${p.stock} left</span></div>`).join("")}</div>` : '<div class="empty">All stocked up 🎉</div>'}</div>
      </div>
      <div class="card"><h3>Recent orders <button class="btn-sm" data-go="orders">View all</button></h3>
        <div class="scroll-x">${orderTable(o.recent, false)}</div></div>`;
    },

    async orders() {
      return `
      <div class="toolbar">
        <input class="grow" id="o-q" placeholder="Search by order ID or customer" value="${esc(state.orders.q)}">
        <select id="o-status"><option value="all">All statuses</option>${STATUSES.map((s) => `<option ${state.orders.status === s ? "selected" : ""} value="${s}">${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select>
      </div>
      <div class="card"><div id="o-body">${skeleton()}</div></div>`;
    },

    async products() {
      const items = await api.products();
      return `
      <form class="inline-form" id="p-form">
        <input name="name" placeholder="Product name" required>
        <select name="category">${["General", "Fashion", "Beauty", "Home", "Food", "Electronics", "Accessories"].map((c) => `<option>${c}</option>`).join("")}</select>
        <input name="price" type="number" step="0.01" min="0" placeholder="Price (BD)" required style="max-width:140px">
        <input name="stock" type="number" min="0" placeholder="Stock" required style="max-width:110px">
        <button class="btn-sm solid" type="submit">Add product</button>
      </form>
      <div class="card scroll-x"><table class="t"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Visible</th><th></th></tr></thead><tbody>
      ${items.map((p) => `<tr data-id="${esc(p.id)}"><td><strong>${esc(p.name)}</strong><div class="netlog">${esc(p.id)}</div></td><td>${esc(p.category)}</td><td>${money(p.price)}</td>
        <td><span class="${p.stock <= 10 ? "down" : ""}">${p.stock}</span></td>
        <td><button class="switch" role="switch" aria-checked="${p.active}" data-act="toggle" aria-label="Toggle visibility"></button></td>
        <td><button class="btn-sm danger" data-act="del">Delete</button></td></tr>`).join("")}
      </tbody></table></div>`;
    },

    async customers() {
      return `<div class="toolbar"><input class="grow" id="c-q" placeholder="Search customers or area"></div><div class="card scroll-x" id="c-body">${skeleton()}</div>`;
    },

    async campaigns() {
      const list = await api.campaigns();
      const rate = (c) => c.sent ? Math.round(c.redeemed / c.sent * 100) + "%" : "–";
      return `<div class="card scroll-x"><table class="t"><thead><tr><th>Campaign</th><th>Channel</th><th>Discount</th><th>Sent</th><th>Redeemed</th><th>Rate</th><th>Status</th><th>Running</th></tr></thead><tbody>
      ${list.map((c) => `<tr data-id="${esc(c.id)}"><td><strong>${esc(c.name)}</strong></td><td>${esc(c.channel)}</td><td>${c.discount}%</td><td>${c.sent}</td><td>${c.redeemed}</td><td>${rate(c)}</td>
        <td><span class="pill ${c.status}">${c.status}</span></td>
        <td>${c.status === "draft" ? '<span class="netlog">not published</span>' : `<button class="switch" role="switch" aria-checked="${c.status === "active"}" data-act="camp" aria-label="Pause or resume"></button>`}</td></tr>`).join("")}
      </tbody></table></div>`;
    },

    async settings() {
      return `<div class="card"><h3>Store profile</h3><form class="settings" id="s-form">
        <label>Your name<input name="name" value="${esc(user.name)}" required></label>
        <label>Store name<input name="store" value="${esc(user.store)}" required></label>
        <label>WhatsApp number<input name="phone" value="${esc(user.phone)}" placeholder="+973 ..."></label>
        <label>Email<input value="${esc(user.email)}" disabled></label>
        <div><button class="btn-sm solid" type="submit">Save changes</button> <span class="pill active" style="margin-left:8px">${esc(user.plan)} plan</span></div>
      </form></div>`;
    }
  };

  const state = { orders: { q: "", status: "all", page: 1 } };

  function orderTable(items, actions) {
    if (!items.length) return '<div class="empty">No orders match your filters.</div>';
    return `<table class="t"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Channel</th><th>Placed</th><th>Status</th></tr></thead><tbody>
    ${items.map((o) => `<tr data-id="${esc(o.id)}" ${o.fresh ? 'class="fresh"' : ""}><td><strong>${esc(o.id)}</strong></td><td>${esc(o.customer)}<div class="netlog">${esc(o.area)}</div></td>
      <td>${o.items.map((l) => l.qty + "× " + esc(l.name)).join("<br>")}</td><td>${money(o.total)}</td><td>${esc(o.channel)}</td><td>${ago(o.createdAt)}</td>
      <td>${actions ? `<select data-act="status" class="plain" style="background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px">${STATUSES.map((s) => `<option value="${s}" ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>` : `<span class="pill ${o.status}">${o.status}</span>`}</td></tr>`).join("")}
    </tbody></table>`;
  }

  async function loadOrders() {
    const body = $("#o-body"); if (!body) return;
    const my = ++token;
    try {
      const r = await api.orders(state.orders);
      if (my !== token || !$("#o-body")) return;
      body.innerHTML = `<div class="scroll-x">${orderTable(r.items, true)}</div>
        <div class="pager"><span>${r.total} orders</span><button class="btn-sm" data-pg="-1" ${r.page <= 1 ? "disabled" : ""}>Prev</button><span>Page ${r.page} / ${r.pages}</span><button class="btn-sm" data-pg="1" ${r.page >= r.pages ? "disabled" : ""}>Next</button></div>`;
    } catch (e) { fail(e); }
  }
  async function loadCustomers(q) {
    const my = ++token;
    try {
      const list = await api.customers({ q });
      if (my !== token || !$("#c-body")) return;
      $("#c-body").innerHTML = list.length ? `<table class="t"><thead><tr><th>Customer</th><th>Phone</th><th>Area</th><th>Orders</th><th>Total spent</th><th>Last order</th></tr></thead><tbody>
        ${list.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.phone)}</td><td>${esc(c.area)}</td><td>${c.orders}</td><td>${money(c.spent)}</td><td>${c.last ? ago(c.last) : "–"}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No customers found.</div>';
    } catch (e) { fail(e); }
  }

  async function show(name) {
    current = name; const my = ++token;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    $("#page-title").textContent = TITLES[name];
    $("#side").classList.remove("open");
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
    view.innerHTML = skeleton();
    if (name === "orders") { newCount = 0; badge(); }
    try {
      const html = await views[name]();
      if (my !== token && name !== "orders" && name !== "customers") return;
      view.innerHTML = html;
      view.querySelectorAll(".bars i[data-h]").forEach((el) => requestAnimationFrame(() => requestAnimationFrame(() => { el.style.height = el.dataset.h; })));
      if (name === "orders") loadOrders();
      if (name === "customers") loadCustomers("");
    } catch (e) { fail(e); view.innerHTML = '<div class="empty">Could not load this section. <button class="btn-sm" data-go="' + name + '">Retry</button></div>'; }
  }
  function badge() { const b = $("#badge-orders"); b.textContent = newCount; b.classList.toggle("hidden", !newCount); }

  /* ---------- events (delegated) ---------- */
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.view) return show(t.dataset.view);
    if (t.dataset.go) return show(t.dataset.go);
    if (t.id === "menu") return $("#side").classList.toggle("open");
    if (t.id === "logout") { t.disabled = true; await api.logout(); return location.replace("signin.html"); }
    if (t.dataset.pg) { state.orders.page = Math.max(1, state.orders.page + (+t.dataset.pg)); return loadOrders(); }
    const row = t.closest("tr"); const id = row && row.dataset.id;
    try {
      if (t.dataset.act === "toggle") {
        const on = t.getAttribute("aria-checked") !== "true";
        t.setAttribute("aria-checked", on); await api.updateProduct({ id, active: on });
        toast(on ? "Product is now visible in your store" : "Product hidden from your store");
      } else if (t.dataset.act === "del") {
        if (!confirm("Delete this product?")) return;
        await api.deleteProduct(id); row.remove(); toast("Product deleted");
      } else if (t.dataset.act === "camp") {
        const on = t.getAttribute("aria-checked") !== "true";
        t.setAttribute("aria-checked", on); const c = await api.setCampaignStatus(id, on ? "active" : "paused");
        row.querySelector(".pill").className = "pill " + c.status; row.querySelector(".pill").textContent = c.status;
        toast("Campaign " + (on ? "resumed" : "paused"));
      }
    } catch (err) { fail(err); show(current); }
  });

  document.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.id === "o-status") { state.orders.status = t.value; state.orders.page = 1; loadOrders(); }
    if (t.dataset.act === "status") {
      const id = t.closest("tr").dataset.id;
      try { await api.setOrderStatus(id, t.value); toast(id + " marked " + t.value); } catch (err) { fail(err); loadOrders(); }
    }
  });

  let debounce;
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "o-q") { clearTimeout(debounce); debounce = setTimeout(() => { state.orders.q = t.value; state.orders.page = 1; loadOrders(); }, 300); }
    if (t.id === "c-q") { clearTimeout(debounce); debounce = setTimeout(() => loadCustomers(t.value), 300); }
  });

  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector("button[type=submit]");
    const data = Object.fromEntries(new FormData(f));
    btn.disabled = true;
    try {
      if (f.id === "p-form") { await api.addProduct(data); toast("Product added"); show("products"); }
      if (f.id === "s-form") { user = await api.updateMe(data); fillUser(); toast("Settings saved"); }
    } catch (err) { fail(err); }
    btn.disabled = false;
  });

  /* ---------- live order feed ---------- */
  function startPolling() {
    poller = setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await api.pollOrders();
        if (!r.order) return;
        toast("New order " + r.order.id + " · " + money(r.order.total) + " from " + r.order.customer);
        if (current === "orders" && state.orders.page === 1 && state.orders.status === "all" && !state.orders.q) {
          await loadOrders(); const row = document.querySelector('tr[data-id="' + r.order.id + '"]'); if (row) row.classList.add("fresh");
        } else if (current === "overview") show("overview");
        else { newCount++; badge(); }
      } catch (err) { if (err.status === 401) fail(err); }
    }, 18000);
  }

  function fillUser() {
    $("#who-name").textContent = user.name; $("#who-store").textContent = user.store;
    $("#avatar").textContent = user.name.trim().charAt(0).toUpperCase();
  }

  /* ---------- boot ---------- */
  (async function () {
    try {
      user = await api.me(); fillUser();
      $("#splash").remove();
      const h = location.hash.slice(1);
      await show(views[h] ? h : "overview");
      startPolling();
    } catch (e) { fail(e); }
  })();
})();
