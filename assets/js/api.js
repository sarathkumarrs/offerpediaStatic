/**
 * Offerpedia client-side API layer.
 *
 * This site is hosted statically, so there is no server yet. This module
 * exposes the same async, token-authenticated REST-style surface a real backend
 * would (POST /api/auth/login, GET /api/orders, ...) and persists everything in
 * localStorage. To go live, replace `request()` with a real fetch() to your
 * server; the pages call nothing else.
 */
(function (global) {
  "use strict";

  const DB_KEY = "op_db_v1";
  const SESSION_KEY = "op_session_v1";
  const TOKEN_TTL_MS = 60 * 60 * 1000;
  const MAX_ATTEMPTS = 5;
  const LOCK_MS = 30 * 1000;

  const listeners = [];
  const onRequest = (fn) => listeners.push(fn);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const pick = (arr) => arr[rand(0, arr.length - 1)];

  class ApiError extends Error {
    constructor(status, message, extra) {
      super(message);
      this.status = status;
      Object.assign(this, extra || {});
    }
  }

  /* ---------- password hashing (SHA-256 + salt; never store plain text) ---------- */
  async function hash(pw, salt) {
    const data = new TextEncoder().encode(salt + ":" + pw);
    if (global.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", data);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 5381;
    for (const c of salt + pw) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
    return "x" + h;
  }

  /* ---------- seed data ---------- */
  const FIRST = ["Aisha", "Omar", "Fatima", "Yusuf", "Layla", "Hassan", "Mariam", "Khalid", "Noor", "Ali", "Sara", "Ahmed", "Hana", "Ebrahim", "Zainab", "Faisal"];
  const LAST = ["Al Khalifa", "Mansoor", "Hussain", "Jassim", "Rashid", "Salman", "Abdulla", "Nasser", "Yaqoob", "Haji"];
  const AREAS = ["Manama", "Riffa", "Muharraq", "Isa Town", "Hamad Town", "Saar", "Budaiya", "Sitra"];

  function seedProducts() {
    const items = [
      ["Classic Abaya", "Fashion", 18.5, 42], ["Oud Perfume 50ml", "Beauty", 24, 17],
      ["Arabic Coffee Set", "Home", 32, 9], ["Date Gift Box", "Food", 12.5, 64],
      ["Leather Wallet", "Accessories", 15, 28], ["Wireless Earbuds", "Electronics", 21, 5],
      ["Prayer Mat Deluxe", "Home", 9.5, 51], ["Saffron Honey 250g", "Food", 7.25, 33]
    ];
    return items.map((p, i) => ({ id: "P" + (100 + i), name: p[0], category: p[1], price: p[2], stock: p[3], active: true }));
  }

  function makeCustomers() {
    const out = [];
    for (let i = 0; i < 14; i++) {
      const n = pick(FIRST) + " " + pick(LAST);
      out.push({ id: "C" + (500 + i), name: n, phone: "+973 3" + rand(100, 999) + " " + rand(1000, 9999), area: pick(AREAS) });
    }
    return out;
  }

  function makeOrder(n, customers, products, ageMinutes, statusOverride) {
    const c = pick(customers);
    const lines = [];
    for (let i = 0, k = rand(1, 3); i < k; i++) {
      const p = pick(products);
      lines.push({ productId: p.id, name: p.name, qty: rand(1, 3), price: p.price });
    }
    const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
    return {
      id: "OP-" + n, customerId: c.id, customer: c.name, area: c.area, items: lines,
      total: Math.round(total * 100) / 100,
      status: statusOverride || pick(["delivered", "delivered", "delivered", "shipped", "processing", "pending"]),
      channel: pick(["WhatsApp", "WhatsApp", "Store link", "Instagram"]),
      createdAt: Date.now() - ageMinutes * 60000
    };
  }

  async function seedDb() {
    const customers = makeCustomers();
    const products = seedProducts();
    const orders = [];
    for (let i = 0; i < 60; i++) orders.push(makeOrder(2000 + i, customers, products, rand(5, 60 * 24 * 7)));
    orders.sort((a, b) => b.createdAt - a.createdAt);
    const salt = "demo";
    return {
      nextOrder: 2060,
      users: [{
        id: "U1", name: "Demo Merchant", email: "demo@offerpedia.org", salt,
        passHash: await hash("Offerpedia@123", salt), store: "Demo Store", phone: "+973 3921 7883",
        plan: "Free", createdAt: Date.now() - 90 * 864e5
      }],
      products, customers, orders,
      campaigns: [
        { id: "K1", name: "Ramadan Early Bird", channel: "WhatsApp", discount: 15, status: "active", sent: 1280, redeemed: 214 },
        { id: "K2", name: "Weekend Flash Sale", channel: "Instagram", discount: 10, status: "active", sent: 860, redeemed: 97 },
        { id: "K3", name: "Win-back: 30 days quiet", channel: "WhatsApp", discount: 20, status: "paused", sent: 410, redeemed: 38 },
        { id: "K4", name: "New Arrivals Teaser", channel: "Store link", discount: 5, status: "draft", sent: 0, redeemed: 0 }
      ]
    };
  }

  async function db() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to reseed */ }
    const fresh = await seedDb();
    save(fresh);
    return fresh;
  }
  function save(d) { try { localStorage.setItem(DB_KEY, JSON.stringify(d)); } catch (e) { /* storage full/blocked */ } }

  /* ---------- sessions ---------- */
  function getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || "null");
      if (s && s.exp > Date.now()) return s;
    } catch (e) { /* ignore */ }
    return null;
  }
  function setSession(s, remember) {
    clearSession();
    try { (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }
  function newToken(user) {
    const b = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "");
    return b({ alg: "HS256", typ: "JWT" }) + "." + b({ sub: user.id, iat: Date.now() }) + "." +
      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function auth() {
    const s = getSession();
    if (!s) throw new ApiError(401, "Your session has expired. Please sign in again.");
    return s;
  }
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, store: u.store, phone: u.phone, plan: u.plan });

  /* ---------- failed-attempt throttling ---------- */
  function attempts() { try { return JSON.parse(localStorage.getItem("op_attempts") || "{}"); } catch (e) { return {}; } }
  function setAttempts(a) { try { localStorage.setItem("op_attempts", JSON.stringify(a)); } catch (e) { /* ignore */ } }

  /* ---------- route table ---------- */
  const routes = {
    "POST /api/auth/login": async (body) => {
      const email = String(body.email || "").trim().toLowerCase();
      const a = attempts();
      const rec = a[email] || { n: 0, until: 0 };
      if (rec.until > Date.now()) {
        throw new ApiError(429, "Too many failed attempts. Try again in " + Math.ceil((rec.until - Date.now()) / 1000) + "s.", { retryAfter: rec.until - Date.now() });
      }
      const d = await db();
      const user = d.users.find((u) => u.email === email);
      const ok = user && (await hash(body.password || "", user.salt)) === user.passHash;
      if (!ok) {
        rec.n += 1;
        if (rec.n >= MAX_ATTEMPTS) { rec.until = Date.now() + LOCK_MS; rec.n = 0; }
        a[email] = rec; setAttempts(a);
        throw new ApiError(401, "Incorrect email or password.", { remaining: rec.until ? 0 : MAX_ATTEMPTS - rec.n });
      }
      delete a[email]; setAttempts(a);
      const session = { token: newToken(user), userId: user.id, exp: Date.now() + TOKEN_TTL_MS };
      setSession(session, !!body.remember);
      return { token: session.token, expiresIn: TOKEN_TTL_MS / 1000, user: publicUser(user) };
    },

    "POST /api/auth/register": async (body) => {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(422, "Enter a valid email address.", { field: "email" });
      if (String(body.password || "").length < 8) throw new ApiError(422, "Password must be at least 8 characters.", { field: "password" });
      if (!String(body.name || "").trim()) throw new ApiError(422, "Please tell us your name.", { field: "name" });
      const d = await db();
      if (d.users.some((u) => u.email === email)) throw new ApiError(409, "An account with this email already exists.", { field: "email" });
      const salt = Math.random().toString(36).slice(2);
      const user = {
        id: "U" + (d.users.length + 1), name: body.name.trim(), email, salt, passHash: await hash(body.password, salt),
        store: body.store ? body.store.trim() : body.name.trim() + "'s Store", phone: "", plan: "Free", createdAt: Date.now()
      };
      d.users.push(user); save(d);
      const session = { token: newToken(user), userId: user.id, exp: Date.now() + TOKEN_TTL_MS };
      setSession(session, true);
      return { token: session.token, user: publicUser(user) };
    },

    "POST /api/auth/logout": async () => { clearSession(); return { ok: true }; },

    "POST /api/auth/forgot": async (body) => {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email || ""))) throw new ApiError(422, "Enter a valid email address.");
      return { ok: true, message: "If an account exists for " + body.email + ", a reset link has been sent." };
    },

    "GET /api/me": async () => {
      const s = auth(); const d = await db();
      const u = d.users.find((x) => x.id === s.userId);
      if (!u) { clearSession(); throw new ApiError(401, "Account not found."); }
      return publicUser(u);
    },

    "PUT /api/me": async (body) => {
      const s = auth(); const d = await db();
      const u = d.users.find((x) => x.id === s.userId);
      ["name", "store", "phone"].forEach((k) => { if (typeof body[k] === "string") u[k] = body[k].trim(); });
      if (!u.name || !u.store) throw new ApiError(422, "Name and store name are required.");
      save(d); return publicUser(u);
    },

    "GET /api/overview": async () => {
      auth(); const d = await db();
      const day = 864e5, now = Date.now();
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const from = new Date(now - i * day); from.setHours(0, 0, 0, 0);
        const to = from.getTime() + day;
        const os = d.orders.filter((o) => o.createdAt >= from.getTime() && o.createdAt < to && o.status !== "cancelled");
        days.push({ label: from.toLocaleDateString(undefined, { weekday: "short" }), revenue: round(os.reduce((s, o) => s + o.total, 0)), orders: os.length });
      }
      const live = d.orders.filter((o) => o.status !== "cancelled");
      const today = days[6], yest = days[5];
      return {
        revenue: round(live.reduce((s, o) => s + o.total, 0)),
        orders: live.length,
        pending: d.orders.filter((o) => o.status === "pending" || o.status === "processing").length,
        customers: d.customers.length,
        todayRevenue: today.revenue, todayDelta: yest.revenue ? Math.round((today.revenue - yest.revenue) / yest.revenue * 100) : 0,
        days, lowStock: d.products.filter((p) => p.stock <= 10 && p.active).map((p) => ({ id: p.id, name: p.name, stock: p.stock })),
        recent: d.orders.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 6)
      };
    },

    "GET /api/orders": async (_b, q) => {
      auth(); const d = await db();
      let list = d.orders.slice().sort((a, b) => b.createdAt - a.createdAt);
      if (q.status && q.status !== "all") list = list.filter((o) => o.status === q.status);
      if (q.q) { const s = q.q.toLowerCase(); list = list.filter((o) => o.id.toLowerCase().includes(s) || o.customer.toLowerCase().includes(s)); }
      const per = 10, page = Math.max(1, +q.page || 1);
      return { total: list.length, page, pages: Math.max(1, Math.ceil(list.length / per)), items: list.slice((page - 1) * per, page * per) };
    },

    "PATCH /api/orders": async (body) => {
      auth(); const d = await db();
      const o = d.orders.find((x) => x.id === body.id);
      if (!o) throw new ApiError(404, "Order not found.");
      if (!["pending", "processing", "shipped", "delivered", "cancelled"].includes(body.status)) throw new ApiError(422, "Invalid status.");
      o.status = body.status; save(d); return o;
    },

    "GET /api/products": async () => { auth(); return (await db()).products; },

    "POST /api/products": async (body) => {
      auth(); const d = await db();
      const price = parseFloat(body.price), stock = parseInt(body.stock, 10);
      if (!String(body.name || "").trim()) throw new ApiError(422, "Product name is required.");
      if (!(price >= 0)) throw new ApiError(422, "Enter a valid price.");
      if (!(stock >= 0)) throw new ApiError(422, "Enter a valid stock count.");
      const p = { id: "P" + (100 + d.products.length + rand(0, 0)), name: body.name.trim(), category: body.category || "General", price: round(price), stock, active: true };
      while (d.products.some((x) => x.id === p.id)) p.id += "x";
      d.products.unshift(p); save(d); return p;
    },

    "PATCH /api/products": async (body) => {
      auth(); const d = await db();
      const p = d.products.find((x) => x.id === body.id);
      if (!p) throw new ApiError(404, "Product not found.");
      if (typeof body.active === "boolean") p.active = body.active;
      if (body.stock != null && body.stock >= 0) p.stock = parseInt(body.stock, 10);
      save(d); return p;
    },

    "DELETE /api/products": async (body) => {
      auth(); const d = await db();
      d.products = d.products.filter((x) => x.id !== body.id); save(d); return { ok: true };
    },

    "GET /api/customers": async (_b, q) => {
      auth(); const d = await db();
      let list = d.customers.map((c) => {
        const os = d.orders.filter((o) => o.customerId === c.id && o.status !== "cancelled");
        return Object.assign({}, c, { orders: os.length, spent: round(os.reduce((s, o) => s + o.total, 0)), last: os.length ? Math.max.apply(null, os.map((o) => o.createdAt)) : null });
      });
      if (q.q) { const s = q.q.toLowerCase(); list = list.filter((c) => c.name.toLowerCase().includes(s) || c.area.toLowerCase().includes(s)); }
      return list.sort((a, b) => b.spent - a.spent);
    },

    "GET /api/campaigns": async () => { auth(); return (await db()).campaigns; },

    "PATCH /api/campaigns": async (body) => {
      auth(); const d = await db();
      const c = d.campaigns.find((x) => x.id === body.id);
      if (!c) throw new ApiError(404, "Campaign not found.");
      if (!["active", "paused"].includes(body.status)) throw new ApiError(422, "Invalid status.");
      c.status = body.status; save(d); return c;
    },

    /* what a websocket / push channel would deliver */
    "GET /api/orders/poll": async () => {
      auth(); const d = await db();
      if (Math.random() < 0.35) return { order: null };
      const o = makeOrder(d.nextOrder++, d.customers, d.products, 0, "pending");
      d.orders.unshift(o); save(d); return { order: o };
    }
  };

  const round = (n) => Math.round(n * 100) / 100;

  /* ---------- transport ---------- */
  async function request(method, path, body, query) {
    const key = method + " " + path;
    const handler = routes[key];
    const t0 = performance.now();
    const quiet = path === "/api/orders/poll";
    let status = 200, err = null;
    try {
      await sleep(rand(280, 780)); // network latency
      if (!handler) throw new ApiError(404, "No such endpoint: " + key);
      return await handler(body || {}, query || {});
    } catch (e) {
      err = e; status = e instanceof ApiError ? e.status : 500;
      if (!(e instanceof ApiError)) err = new ApiError(500, "Something went wrong on our side. Please try again.");
      throw err;
    } finally {
      const ms = Math.round(performance.now() - t0);
      if (!quiet) console.log("%c[api] " + key + " → " + status + " (" + ms + "ms)", "color:" + (status < 400 ? "#3fb68b" : "#e5534b"));
      listeners.forEach((fn) => { try { fn({ method, path, status, ms, quiet }); } catch (e2) { /* ignore */ } });
    }
  }

  const qs = (o) => o || {};
  global.OfferpediaAPI = {
    ApiError, onRequest, getSession,
    login: (email, password, remember) => request("POST", "/api/auth/login", { email, password, remember }),
    register: (b) => request("POST", "/api/auth/register", b),
    logout: () => request("POST", "/api/auth/logout"),
    forgot: (email) => request("POST", "/api/auth/forgot", { email }),
    me: () => request("GET", "/api/me"),
    updateMe: (b) => request("PUT", "/api/me", b),
    overview: () => request("GET", "/api/overview"),
    orders: (q) => request("GET", "/api/orders", null, qs(q)),
    setOrderStatus: (id, status) => request("PATCH", "/api/orders", { id, status }),
    pollOrders: () => request("GET", "/api/orders/poll"),
    products: () => request("GET", "/api/products"),
    addProduct: (b) => request("POST", "/api/products", b),
    updateProduct: (b) => request("PATCH", "/api/products", b),
    deleteProduct: (id) => request("DELETE", "/api/products", { id }),
    customers: (q) => request("GET", "/api/customers", null, qs(q)),
    campaigns: () => request("GET", "/api/campaigns"),
    setCampaignStatus: (id, status) => request("PATCH", "/api/campaigns", { id, status }),
    DEMO: { email: "demo@offerpedia.org", password: "Offerpedia@123" }
  };
})(window);
