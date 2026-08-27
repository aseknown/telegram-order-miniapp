const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const state = { config: null, product: null, qty: 1 };
const $ = (id) => document.getElementById(id);
const productsEl = $("products");
const checkoutEl = $("checkout");
const successEl = $("success");
const alertEl = $("alert");

function money(n) { return `${Number(n).toFixed(2)} ${state.config.currency}`; }
function showError(message) {
  alertEl.textContent = message;
  alertEl.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function clearError() { alertEl.classList.add("hidden"); }

function renderProducts() {
  productsEl.innerHTML = "";
  for (const p of state.config.products) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="eyebrow">PRODUCT</div>
      <h3></h3>
      <p class="muted"></p>
      <div class="price"></div>
      <button class="primary" type="button">Order</button>`;
    card.querySelector("h3").textContent = p.name;
    card.querySelector("p").textContent = p.description || "";
    card.querySelector(".price").textContent = money(p.price);
    card.querySelector("button").addEventListener("click", () => selectProduct(p));
    productsEl.appendChild(card);
  }
}
function selectProduct(p) {
  state.product = p;
  state.qty = 1;
  $("qtyInput").value = 1;
  productsEl.classList.add("hidden");
  checkoutEl.classList.remove("hidden");
  renderSummary();
}
function renderSummary() {
  const total = Number(state.product.price) * state.qty;
  $("orderSummary").textContent = `${state.product.name} × ${state.qty} — ${money(total)}`;
}
function setQty(value) {
  state.qty = Math.max(1, Math.min(20, Number(value) || 1));
  $("qtyInput").value = state.qty;
  renderSummary();
}

async function loadConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Could not load shop configuration.");
  state.config = await res.json();
  $("paymentLabel").textContent = state.config.payment.label;
  $("paymentNumber").textContent = state.config.payment.number;
  $("paymentHolder").textContent = state.config.payment.holder;
  $("paymentNote").textContent = state.config.payment.note;
  renderProducts();
}

$("backBtn").addEventListener("click", () => {
  checkoutEl.classList.add("hidden");
  productsEl.classList.remove("hidden");
});
$("minusBtn").addEventListener("click", () => setQty(state.qty - 1));
$("plusBtn").addEventListener("click", () => setQty(state.qty + 1));
$("qtyInput").addEventListener("change", e => setQty(e.target.value));
$("copyBtn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.config.payment.number);
  $("copyBtn").textContent = "Copied";
  setTimeout(() => $("copyBtn").textContent = "Copy", 1200);
});
$("closeBtn").addEventListener("click", () => tg?.close());

$("submitBtn").addEventListener("click", async () => {
  clearError();
  if (!tg?.initData) {
    showError("Open this shop from inside the Telegram bot. Telegram authentication data is missing.");
    return;
  }
  const file = $("receiptInput").files[0];
  if (!file) return showError("Please upload the payment screenshot.");
  if (!["image/jpeg","image/png","image/webp"].includes(file.type)) return showError("Receipt must be JPG, PNG or WebP.");
  if (file.size > 10 * 1024 * 1024) return showError("Receipt image is larger than 10 MB.");

  const btn = $("submitBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  try {
    const fd = new FormData();
    fd.append("initData", tg.initData);
    fd.append("productId", state.product.id);
    fd.append("quantity", String(state.qty));
    fd.append("receipt", file);

    const res = await fetch("/api/order", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Order submission failed.");

    checkoutEl.classList.add("hidden");
    successEl.classList.remove("hidden");
    $("successText").textContent = `Order #${data.orderId} was submitted and is waiting for manual review.`;
    tg.HapticFeedback?.notificationOccurred("success");
  } catch (err) {
    showError(err.message || "Something went wrong.");
    tg?.HapticFeedback?.notificationOccurred("error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit order";
  }
});

loadConfig().catch(err => showError(err.message));
