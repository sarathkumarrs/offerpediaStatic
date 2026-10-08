(function () {
  "use strict";
  const api = window.OfferpediaAPI;
  const $ = (id) => document.getElementById(id);

  // Already signed in? Skip straight to the dashboard.
  if (api.getSession()) { location.replace("dashboard.html"); return; }

  const alertBox = $("alert");
  function showAlert(type, msg) { alertBox.className = "alert show " + type; alertBox.textContent = msg; }
  function clearAlert() { alertBox.className = "alert"; }
  function fieldError(id, msg) {
    const f = $(id); f.classList.toggle("invalid", !!msg); f.querySelector(".err").textContent = msg || "";
  }
  function busy(btn, on, label) {
    btn.disabled = on; btn.classList.toggle("loading", on);
    btn.querySelector(".lbl").textContent = on ? label : btn.dataset.label;
  }
  ["submit-in", "submit-up"].forEach((id) => { $(id).dataset.label = $(id).querySelector(".lbl").textContent; });

  /* tabs */
  function setTab(signIn) {
    $("form-in").classList.toggle("hidden", !signIn);
    $("form-up").classList.toggle("hidden", signIn);
    $("tab-in").setAttribute("aria-selected", signIn);
    $("tab-up").setAttribute("aria-selected", !signIn);
    $("title").textContent = signIn ? "Welcome back" : "Start selling online";
    $("subtitle").textContent = signIn ? "Sign in to manage your store." : "Create your free store in under a minute.";
    clearAlert();
  }
  $("tab-in").onclick = () => setTab(true);
  $("tab-up").onclick = () => setTab(false);
  if (location.hash === "#signup") setTab(false);

  /* show / hide password */
  document.querySelector(".eye").onclick = function () {
    const p = $("password"), show = p.type === "password";
    p.type = show ? "text" : "password";
    this.firstElementChild.className = "bi " + (show ? "bi-eye-slash" : "bi-eye");
  };

  $("fill-demo").onclick = () => {
    $("email").value = api.DEMO.email; $("password").value = api.DEMO.password;
    fieldError("f-email"); fieldError("f-password"); $("password").focus();
  };

  const go = () => { location.href = new URLSearchParams(location.search).get("next") === "orders" ? "dashboard.html#orders" : "dashboard.html"; };
  const emailOk = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

  /* sign in */
  let lockTimer = null;
  $("form-in").addEventListener("submit", async (e) => {
    e.preventDefault(); clearAlert();
    const email = $("email").value.trim(), pw = $("password").value;
    fieldError("f-email", email ? (emailOk(email) ? "" : "Enter a valid email address.") : "Email is required.");
    fieldError("f-password", pw ? "" : "Password is required.");
    if (!email || !emailOk(email) || !pw) return;
    const btn = $("submit-in");
    busy(btn, true, "Signing in…");
    try {
      await api.login(email, pw, $("remember").checked);
      busy(btn, true, "Redirecting…");
      showAlert("success", "Signed in. Loading your dashboard…");
      go();
    } catch (err) {
      busy(btn, false);
      if (err.status === 429) {
        const until = Date.now() + (err.retryAfter || 30000);
        btn.disabled = true; clearInterval(lockTimer);
        lockTimer = setInterval(() => {
          const s = Math.ceil((until - Date.now()) / 1000);
          if (s <= 0) { clearInterval(lockTimer); btn.disabled = false; clearAlert(); return; }
          showAlert("error", "Too many failed attempts. Try again in " + s + "s.");
        }, 500);
        showAlert("error", err.message);
      } else {
        const hint = typeof err.remaining === "number" && err.remaining > 0 && err.remaining < 3 ? " " + err.remaining + " attempt(s) left." : "";
        showAlert("error", err.message + hint);
        if (err.status === 401) $("password").select();
      }
    }
  });

  /* forgot password */
  $("forgot").onclick = async (e) => {
    e.preventDefault(); clearAlert();
    const email = $("email").value.trim();
    if (!emailOk(email)) { fieldError("f-email", "Enter your email above first."); $("email").focus(); return; }
    fieldError("f-email");
    try { showAlert("success", (await api.forgot(email)).message); } catch (err) { showAlert("error", err.message); }
  };

  /* sign up */
  function strength(pw) {
    let s = 0;
    if (pw.length >= 8) s++; if (pw.length >= 12) s++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  }
  $("r-password").addEventListener("input", (e) => {
    const s = strength(e.target.value), bar = $("strength-bar");
    bar.style.width = (s * 25) + "%";
    bar.style.background = ["#e5534b", "#e5534b", "#e0a43a", "#3fb68b", "#3fb68b"][s];
  });

  $("form-up").addEventListener("submit", async (e) => {
    e.preventDefault(); clearAlert();
    const v = { name: $("r-name").value, store: $("r-store").value, email: $("r-email").value.trim(), password: $("r-password").value };
    fieldError("g-name", v.name.trim() ? "" : "Please tell us your name.");
    fieldError("g-email", emailOk(v.email) ? "" : "Enter a valid email address.");
    fieldError("g-password", v.password.length >= 8 ? "" : "Use at least 8 characters.");
    if (!v.name.trim() || !emailOk(v.email) || v.password.length < 8) return;
    const btn = $("submit-up");
    busy(btn, true, "Creating your store…");
    try {
      await api.register(v);
      showAlert("success", "Account created. Setting up your dashboard…");
      go();
    } catch (err) {
      busy(btn, false);
      if (err.field) fieldError({ name: "g-name", email: "g-email", password: "g-password" }[err.field], err.message);
      else showAlert("error", err.message);
    }
  });
})();
