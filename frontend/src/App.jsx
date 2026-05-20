import { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate, Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000/api";
const TOKEN_KEY = "saas_factures_ia_tokens";

const plansFallback = [
  { code: "free", name: "Free", price: "0 EUR", quota: 20, features: ["20 factures/mois"] },
  { code: "pro", name: "Pro", price: "29 EUR", quota: 500, features: ["500 factures/mois"] },
  { code: "enterprise", name: "Enterprise", price: "99 EUR", quota: null, features: ["Illimite"] },
];

function readStoredTokens() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch(path, options = {}, tokens, setTokens) {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (tokens?.access) {
    headers.set("Authorization", `Bearer ${tokens.access}`);
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (response.status !== 401 || !tokens?.refresh || path === "/auth/refresh/") {
    return response;
  }

  const refreshResponse = await fetch(`${API_BASE}/auth/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: tokens.refresh }),
  });
  if (!refreshResponse.ok) {
    clearTokens();
    setTokens(null);
    return response;
  }

  const refreshed = await refreshResponse.json();
  const nextTokens = { ...tokens, access: refreshed.access, refresh: refreshed.refresh || tokens.refresh };
  saveTokens(nextTokens);
  setTokens(nextTokens);

  headers.set("Authorization", `Bearer ${nextTokens.access}`);
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

function formatMoney(value) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value ?? 0);
}

function badgeTone(status) {
  const map = { done: "success", review: "warning", processing: "info", uploaded: "muted", error: "danger" };
  return map[status] || "muted";
}

function MainApp() {
  const navigate = useNavigate();
  const [tokens, setTokens] = useState(() => readStoredTokens());
  const [user, setUser] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [plans, setPlans] = useState(plansFallback);
  const [selectedId, setSelectedId] = useState(null);
  const [reviewDraft, setReviewDraft] = useState(null);
  const [authForm, setAuthForm] = useState({ username: "", password: "" });
  const [registerForm, setRegisterForm] = useState({ username: "", email: "", password: "", organization_name: "" });
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadStatus, setUploadStatus] = useState("");
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [teamMembers, setTeamMembers] = useState([]);
  const [inviteForm, setInviteForm] = useState({ username: "", email: "", password: "" });
  const [inviteStatus, setInviteStatus] = useState("");

  const selectedInvoice = useMemo(
    () => invoices.find((invoice) => invoice.id === selectedId) ?? invoices[0] ?? null,
    [invoices, selectedId],
  );

  useEffect(() => {
    fetch(`${API_BASE}/plans/`)
      .then((response) => response.json())
      .then((data) => setPlans(data.plans || plansFallback))
      .catch(() => setPlans(plansFallback));
  }, []);

  useEffect(() => {
    setReviewDraft(selectedInvoice ? mapInvoiceToDraft(selectedInvoice) : null);
  }, [selectedInvoice]);

  useEffect(() => {
    if (!tokens || !selectedInvoice || !["uploaded", "processing"].includes(selectedInvoice.status)) {
      return undefined;
    }

    const intervalId = setInterval(async () => {
      const response = await apiFetch(`/invoices/${selectedInvoice.id}/`, {}, tokens, setTokens);
      if (!response.ok) {
        return;
      }
      const refreshed = await response.json();
      setInvoices((current) => current.map((item) => (item.id === refreshed.id ? refreshed : item)));
      if (!["uploaded", "processing"].includes(refreshed.status)) {
        clearInterval(intervalId);
        hydrateApp(tokens);
      }
    }, 3000);

    return () => clearInterval(intervalId);
  }, [selectedInvoice, tokens]);

  useEffect(() => {
    if (!tokens) {
      setUser(null);
      setDashboard(null);
      setInvoices([]);
      return;
    }
    hydrateApp(tokens);
  }, [tokens]);

  useEffect(() => {
    if (!tokens) return;
    const delayDebounceFn = setTimeout(async () => {
      const response = await apiFetch(`/invoices/?search=${encodeURIComponent(searchQuery)}`, {}, tokens, setTokens);
      if (response.ok) {
        const data = await response.json();
        setInvoices(data.results || []);
      }
    }, 400);
    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery, tokens]);

  async function hydrateApp(activeTokens) {
    try {
      const [sessionResponse, dashboardResponse, invoicesResponse, teamResponse] = await Promise.all([
        apiFetch("/session/", {}, activeTokens, setTokens),
        apiFetch("/dashboard/", {}, activeTokens, setTokens),
        apiFetch("/invoices/", {}, activeTokens, setTokens),
        apiFetch("/team/", {}, activeTokens, setTokens).catch(() => ({ ok: false })),
      ]);
      if (!sessionResponse.ok || !dashboardResponse.ok || !invoicesResponse.ok) {
        throw new Error("Session invalide");
      }
      const sessionData = await sessionResponse.json();
      const dashboardData = await dashboardResponse.json();
      const invoiceData = await invoicesResponse.json();
      setUser(sessionData.user);
      setDashboard(dashboardData);
      setInvoices(invoiceData.results || []);
      if (teamResponse && teamResponse.ok) {
        setTeamMembers(await teamResponse.json());
      }
      setSelectedId((invoiceData.results || [])[0]?.id ?? null);
      setError("");
    } catch {
      clearTokens();
      setTokens(null);
      setError("La session a expiré. Reconnectez-vous.");
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setError("");
    const response = await fetch(`${API_BASE}/auth/login/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authForm),
    });
    const data = await response.json();
    if (!response.ok) {
      setError("Connexion impossible.");
      return;
    }
    const nextTokens = { access: data.access, refresh: data.refresh };
    saveTokens(nextTokens);
    setTokens(nextTokens);
    setUser(data.user);
  }

  async function handleRegister(event) {
    event.preventDefault();
    setError("");
    const response = await fetch(`${API_BASE}/auth/register/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerForm),
    });
    if (!response.ok) {
      setError("Inscription impossible. Vérifiez les champs.");
      return;
    }
    setAuthForm({ username: registerForm.username, password: registerForm.password });
    setRegisterForm({ username: "", email: "", password: "", organization_name: "" });
    setError("Compte créé. Connectez-vous.");
    navigate("/login");
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (!uploadFile || !tokens) {
      return;
    }
    setUploadStatus("Upload en cours...");
    setError("");

    try {
      const presignResponse = await apiFetch(
        "/storage/presign/",
        {
          method: "POST",
          body: JSON.stringify({ fileName: uploadFile.name, contentType: uploadFile.type || "application/pdf" }),
        },
        tokens,
        setTokens,
      );
      if (!presignResponse.ok) {
        throw new Error("Presign failed");
      }
      const presignData = await presignResponse.json();

      let invoiceResponse;
      if (presignData.mode === "s3" && presignData.uploadUrl) {
        const uploadResponse = await fetch(presignData.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": uploadFile.type || "application/pdf" },
          body: uploadFile,
        });
        if (!uploadResponse.ok) {
          throw new Error("S3 upload failed");
        }
        invoiceResponse = await apiFetch(
          "/invoices/",
          {
            method: "POST",
            body: JSON.stringify({
              fileName: uploadFile.name,
              fileKey: presignData.fileKey,
              fileUrl: presignData.publicUrl,
            }),
          },
          tokens,
          setTokens,
        );
      } else {
        const formData = new FormData();
        formData.append("file", uploadFile);
        invoiceResponse = await apiFetch("/invoices/local-upload/", { method: "POST", body: formData }, tokens, setTokens);
      }

      if (!invoiceResponse.ok) {
        throw new Error("Invoice create failed");
      }
      const created = await invoiceResponse.json();
      const nextInvoices = [created, ...invoices];
      setInvoices(nextInvoices);
      setSelectedId(created.id);
      setUploadFile(null);
      setUploadStatus(created.queueMode === "celery" ? "Facture envoyée au worker Celery." : "Facture envoyée au worker local.");
    } catch {
      setUploadStatus("");
      setError("Échec de l’upload ou du traitement.");
    }
  }

  async function handleValidateInvoice() {
    if (!reviewDraft || !tokens) {
      return;
    }
    const response = await apiFetch(
      `/invoices/${reviewDraft.id}/validate/`,
      {
        method: "PATCH",
        body: JSON.stringify({
          supplier: reviewDraft.supplier,
          invoiceNumber: reviewDraft.invoiceNumber,
          invoiceDate: reviewDraft.invoiceDate,
          amountHt: reviewDraft.amountHt,
          amountTva: reviewDraft.amountTva,
          amountTtc: reviewDraft.amountTtc,
          category: reviewDraft.category,
          confidence: reviewDraft.confidence,
        }),
      },
      tokens,
      setTokens,
    );
    if (!response.ok) {
      setError("Validation impossible.");
      return;
    }
    const updated = await response.json();
    setInvoices((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setReviewDraft(mapInvoiceToDraft(updated));
    hydrateApp(tokens);
  }

  async function handleSubscribe(planCode) {
    if (!tokens) return;
    try {
      const response = await apiFetch("/stripe/create-checkout-session/", {
        method: "POST",
        body: JSON.stringify({ plan_code: planCode }),
      }, tokens, setTokens);
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.success) {
        hydrateApp(tokens);
        alert(data.message);
      } else {
        alert("Erreur: " + (data.error || "inconnue"));
      }
    } catch (e) {
      alert("Erreur lors de la redirection vers Stripe.");
    }
  }

  async function handleExport(format) {
    if (!tokens) return;
    try {
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${tokens.access}`);
      const response = await fetch(`${API_BASE}/invoices/export/?format=${format}`, { headers });
      
      if (!response.ok) {
        alert("Erreur lors de l'export.");
        return;
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rapport_factures.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      alert("Erreur réseau.");
    }
  }

  async function handleInvite(e) {
    e.preventDefault();
    setInviteStatus("");
    try {
      const response = await apiFetch("/team/", {
        method: "POST",
        body: JSON.stringify(inviteForm),
      }, tokens, setTokens);
      const data = await response.json();
      if (!response.ok) {
        setInviteStatus("Erreur: " + (data.error || "impossible d'inviter"));
        return;
      }
      setInviteStatus("Membre ajouté !");
      setInviteForm({ username: "", email: "", password: "" });
      hydrateApp(tokens);
    } catch {
      setInviteStatus("Erreur réseau");
    }
  }

  function logout() {
    clearTokens();
    setTokens(null);
  }

  if (!tokens) {
    return (
      <Routes>
        <Route 
          path="/login" 
          element={
            <LoginView 
              authForm={authForm} 
              setAuthForm={setAuthForm} 
              handleLogin={handleLogin} 
              error={error} 
            />
          } 
        />
        <Route 
          path="/register" 
          element={
            <RegisterView 
              registerForm={registerForm} 
              setRegisterForm={setRegisterForm} 
              handleRegister={handleRegister} 
              error={error} 
            />
          } 
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">✦ Espace sécurisé</p>
          <h1>Factures IA</h1>
          <p className="lead">
            Gestion intelligente de vos factures avec extraction automatisée.
          </p>
        </div>
        <div className="org-card">
          <span className="badge success">{dashboard?.organization?.plan || user?.organization?.plan}</span>
          <h2>{dashboard?.organization?.name || user?.organization?.name}</h2>
          <p>👤 <strong>{user?.username}</strong> <span className="badge muted" style={{marginLeft: '6px'}}>{user?.role}</span></p>
          <p>
            📊 Quota: <strong>{dashboard?.organization?.quotaRemaining ?? user?.organization?.quotaRemaining}</strong> restant
          </p>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>📊 Vue d'ensemble</NavLink>
          <NavLink to="/invoices" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>📄 Factures & Upload</NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>⚙️ Paramètres & Équipe</NavLink>
        </nav>
        <div style={{flex: 1}}></div>
        <button id="logout-btn" type="button" className="secondary-button" onClick={logout}>
          ← Se déconnecter
        </button>
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/" element={
            <div style={{display: 'flex', flexDirection: 'column', gap: '24px'}}>
              <section className="hero-grid" style={{gridTemplateColumns: '1fr'}}>
                <article className="panel hero-panel">
            <p className="eyebrow">📊 Dashboard</p>
            <h2>Vue d'ensemble</h2>
            <div className="stats-grid">
              <StatCard label="Total factures" value={dashboard?.kpis?.invoiceCount ?? 0} />
              <StatCard label="Validées" value={dashboard?.kpis?.validatedCount ?? 0} />
              <StatCard label="En traitement" value={dashboard?.kpis?.processingCount ?? 0} />
              <StatCard label="Dépenses totales" value={formatMoney(dashboard?.kpis?.totalSpend ?? 0)} />
            </div>
          </article>

          <article className="panel chart-panel">
            <p className="eyebrow">📈 Dépenses mensuelles</p>
            <h3>Tendance</h3>
            <div className="bars">
              {(dashboard?.monthlySpend || []).map((item) => (
                <div key={item.month} className="bar-column">
                  <div className="bar-track">
                    <div className="bar-fill" style={{ height: `${Math.min(Math.max((item.total / 600) * 100, 8), 100)}%` }} />
                  </div>
                  <strong>{item.month}</strong>
                  <span>{formatMoney(item.total)}</span>
                </div>
              ))}
            </div>
          </article>
        </section>
      </div>
    } />

    <Route path="/invoices" element={
      <div style={{display: 'flex', flexDirection: 'column', gap: '24px'}}>
        <section className="hero-grid" style={{gridTemplateColumns: '1fr'}}>
          <article className="panel upload-panel">
            <p className="eyebrow">📤 Upload</p>
            <h3>Nouvelle facture</h3>
            <form onSubmit={handleUpload} className="stack-form">
              <input id="file-upload" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
              <button id="upload-submit" type="submit">Uploader et traiter →</button>
            </form>
            <p className="helper-text">
              Déposez un PDF ou une image. L'extraction IA démarre automatiquement.
            </p>
            {uploadStatus && <p className="success-text">✓ {uploadStatus}</p>}
            {error && <p className="error-text">{error}</p>}
          </article>
        </section>

        <section className="content-grid">
          <article className="panel invoice-panel">
            <div className="section-head" style={{alignItems: 'center', flexWrap: 'wrap', gap: '10px'}}>
              <div style={{flex: 1}}>
                <p className="eyebrow">📁 Factures</p>
                <h3>Liste de travail</h3>
              </div>
              <input 
                type="text" 
                placeholder="🔍 Rechercher (fournisseur, montant...)" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{padding: '8px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--panel-bg)', color: 'var(--text-primary)', flex: '1', minWidth: '200px'}}
              />
              <div style={{display: 'flex', gap: '8px'}}>
                <button type="button" className="secondary-button" style={{padding: '8px 12px'}} onClick={() => handleExport("csv")}>⬇️ CSV</button>
                <button type="button" className="secondary-button" style={{padding: '8px 12px'}} onClick={() => handleExport("pdf")}>⬇️ PDF</button>
              </div>
            </div>
            <div className="invoice-list">
              {invoices.map((invoice) => (
                <button
                  type="button"
                  key={invoice.id}
                  className={`invoice-row ${invoice.id === selectedId ? "active" : ""}`}
                  onClick={() => setSelectedId(invoice.id)}
                >
                  <div>
                    <strong>{invoice.fileName}</strong>
                    <p>{invoice.supplier || "A vérifier"}</p>
                  </div>
                  <div className="invoice-meta">
                    <span className={`badge ${badgeTone(invoice.status)}`}>{invoice.status}</span>
                    <span>{formatMoney(invoice.amountTtc)}</span>
                  </div>
                </button>
              ))}
            </div>
          </article>

          <article className="panel review-panel">
            <div className="section-head">
              <div>
                <p className="eyebrow">Validation humaine</p>
                <h3>Contrôle des champs extraits</h3>
              </div>
              {reviewDraft && <span className={`badge ${badgeTone(reviewDraft.status)}`}>{reviewDraft.status}</span>}
            </div>
            {reviewDraft ? (
              <div className="review-layout">
                <div className="pdf-preview">
                  <div className="preview-card">
                    <p className="eyebrow">Texte extrait</p>
                    <h4>{reviewDraft.fileName}</h4>
                    <p>{reviewDraft.rawText || "Aucun texte extrait."}</p>
                  </div>
                  <div className="confidence-list">
                    {Object.entries(reviewDraft.extractedData || {}).map(([key, item]) => (
                      <div key={key} className="confidence-item">
                        <span>{key}</span>
                        <strong>{Math.round(((item?.confidence || 0) * 100))}%</strong>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="review-form">
                  <label>
                    Fournisseur
                    <input value={reviewDraft.supplier || ""} onChange={(e) => setReviewDraft({ ...reviewDraft, supplier: e.target.value })} />
                  </label>
                  <label>
                    Numéro
                    <input value={reviewDraft.invoiceNumber || ""} onChange={(e) => setReviewDraft({ ...reviewDraft, invoiceNumber: e.target.value })} />
                  </label>
                  <label>
                    Date
                    <input type="date" value={reviewDraft.invoiceDate || ""} onChange={(e) => setReviewDraft({ ...reviewDraft, invoiceDate: e.target.value })} />
                  </label>
                  <div className="split-row">
                    <label>
                      HT
                      <input type="number" step="0.01" value={reviewDraft.amountHt || 0} onChange={(e) => setReviewDraft({ ...reviewDraft, amountHt: Number(e.target.value) })} />
                    </label>
                    <label>
                      TVA
                      <input type="number" step="0.01" value={reviewDraft.amountTva || 0} onChange={(e) => setReviewDraft({ ...reviewDraft, amountTva: Number(e.target.value) })} />
                    </label>
                  </div>
                  <div className="split-row">
                    <label>
                      TTC
                      <input type="number" step="0.01" value={reviewDraft.amountTtc || 0} onChange={(e) => setReviewDraft({ ...reviewDraft, amountTtc: Number(e.target.value) })} />
                    </label>
                    <label>
                      Catégorie
                      <input value={reviewDraft.category || ""} onChange={(e) => setReviewDraft({ ...reviewDraft, category: e.target.value })} />
                    </label>
                  </div>
                  <button id="validate-invoice" type="button" onClick={handleValidateInvoice}>
                    ✓ Valider la facture
                  </button>
                </div>
              </div>
            ) : (
              <p className="helper-text">Sélectionnez une facture pour la revoir.</p>
            )}
          </article>
        </section>
      </div>
    } />

    <Route path="/settings" element={
      <div style={{display: 'flex', flexDirection: 'column', gap: '24px'}}>
        <section className="bottom-grid">
          <article className="panel pricing-panel">
            <p className="eyebrow">💎 Abonnements</p>
            <h3>Choisir votre plan</h3>
            <div className="pricing-grid">
              {plans.map((plan) => (
                <div key={plan.code} className={`price-card ${plan.code === "pro" ? "featured" : ""}`}>
                  <span className="badge muted">{plan.name}</span>
                  <h4>{plan.price}</h4>
                  <p>{plan.quota ? `${plan.quota} factures / mois` : "Illimité"}</p>
                  {(plan.features || []).map((feature) => (
                    <small key={feature}>{feature}</small>
                  ))}
                  <button 
                    type="button" 
                    onClick={() => handleSubscribe(plan.code)} 
                    className={plan.code === "pro" ? "" : "secondary-button"} 
                    style={{marginTop: '10px'}}
                    disabled={dashboard?.organization?.plan === plan.code}
                  >
                    {dashboard?.organization?.plan === plan.code ? "✓ Actuel" : "Souscrire"}
                  </button>
                </div>
              ))}
            </div>
          </article>
          
          {user?.role === "owner" && (
            <article className="panel team-panel">
              <p className="eyebrow">👥 Équipe</p>
              <h3>Ajouter un membre</h3>
              <form onSubmit={handleInvite} className="stack-form" style={{marginTop: '15px'}}>
                <input required type="text" placeholder="Nom d'utilisateur" value={inviteForm.username} onChange={e => setInviteForm({...inviteForm, username: e.target.value})} />
                <input required type="email" placeholder="Email" value={inviteForm.email} onChange={e => setInviteForm({...inviteForm, email: e.target.value})} />
                <input required type="password" placeholder="Mot de passe temporaire" value={inviteForm.password} onChange={e => setInviteForm({...inviteForm, password: e.target.value})} />
                <button type="submit">Inviter dans l'équipe</button>
              </form>
              {inviteStatus && <p className={inviteStatus.startsWith("Erreur") ? "error-text" : "success-text"}>{inviteStatus}</p>}
              
              <div style={{marginTop: '20px'}}>
                <p className="eyebrow">Membres Actuels</p>
                <ul style={{listStyle: 'none', padding: 0, marginTop: '10px'}}>
                  {teamMembers.map(m => (
                    <li key={m.id} style={{padding: '8px 0', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between'}}>
                      <span>{m.username}</span>
                      <span className="badge muted">{m.role}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          )}
        </section>
      </div>
    } />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <MainApp />
    </BrowserRouter>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function mapInvoiceToDraft(invoice) {
  return {
    ...invoice,
    rawText: invoice.raw_text || invoice.rawText,
    extractedData: invoice.extracted_data || invoice.extractedData || {},
    invoiceDate: invoice.invoiceDate || invoice.invoice_date,
    amountHt: invoice.amountHt ?? invoice.amount_ht ?? 0,
    amountTva: invoice.amountTva ?? invoice.amount_tva ?? 0,
    amountTtc: invoice.amountTtc ?? invoice.amount_ttc ?? 0,
    invoiceNumber: invoice.invoiceNumber || invoice.invoice_number || "",
    fileName: invoice.fileName || invoice.file_name,
  };
}

function AuthShellLayout({ children }) {
  return (
    <div className="auth-shell">
      <section className="auth-panel intro-panel">
        <div className="intro-header">
          <div className="logo-container">
            <div className="logo-icon">✦</div>
            <span style={{ fontSize: '1.25rem', fontWeight: 'bold', fontFamily: 'Space Grotesk' }}>Factures IA</span>
          </div>
          <h1>Gerez vos factures intelligemment</h1>
          <p>
            Automatisez l'extraction, la validation et le suivi de vos factures grace a l'intelligence artificielle.
          </p>
        </div>

        <div className="intro-visual">
          <div className="mock-app-window">
            <div className="window-header">
              <div className="window-dots">
                <div className="window-dot"></div>
                <div className="window-dot"></div>
                <div className="window-dot"></div>
              </div>
              <div className="window-title">ocr-pipeline-worker.js</div>
            </div>
            <div className="mock-invoice-container">
              <div className="invoice-card-mock">
                <div className="scanner-line"></div>
                <div className="invoice-mock-line header"></div>
                <div className="invoice-mock-line long"></div>
                <div className="invoice-mock-line medium"></div>
                <div className="invoice-mock-line short"></div>
                <div className="invoice-mock-table">
                  <div className="invoice-mock-line long"></div>
                  <div className="invoice-mock-line medium"></div>
                </div>
              </div>
              <div className="extracted-nodes-mock">
                <div className="data-node-mock">
                  <div className="data-node-label">Fournisseur <span className="conf">99%</span></div>
                  <div className="data-node-val">TotalEnergies</div>
                </div>
                <div className="data-node-mock">
                  <div className="data-node-label">Montant TTC <span className="conf">98%</span></div>
                  <div className="data-node-val">142,50 EUR</div>
                </div>
                <div className="data-node-mock">
                  <div className="data-node-label">TVA <span className="conf">97%</span></div>
                  <div className="data-node-val">23,75 EUR</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="intro-footer">
          <div className="security-dot"></div>
          <span>Chiffrement AES-256 et IA souveraine</span>
        </div>
      </section>

      <section className="auth-panel auth-form-container">
        {children}
      </section>
    </div>
  );
}

function LoginView({ authForm, setAuthForm, handleLogin, error }) {
  return (
    <AuthShellLayout>
      <div className="auth-card">
        <div className="auth-card-header">
          <h2>Bon retour !</h2>
          <p>Connectez-vous a votre espace Factures IA</p>
        </div>

        <form onSubmit={handleLogin} className="stack-form">
          <div className="form-group">
            <label htmlFor="login-username">Nom d'utilisateur</label>
            <input 
              id="login-username" 
              required
              value={authForm.username} 
              onChange={(e) => setAuthForm({ ...authForm, username: e.target.value })} 
              placeholder="Ex: owner" 
            />
          </div>

          <div className="form-group">
            <label htmlFor="login-password">Mot de passe</label>
            <input 
              id="login-password" 
              type="password" 
              required
              value={authForm.password} 
              onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} 
              placeholder="••••••••" 
            />
          </div>

          <button id="login-submit" type="submit">
            Se connecter →
          </button>
        </form>

        {error && (
          <p className={error.includes("créé") ? "success-text" : "error-text"} style={{ marginTop: '16px', textAlign: 'center' }}>
            {error}
          </p>
        )}

        <div className="auth-toggle-footer">
          Nouveau sur la plateforme ? 
          <Link to="/register">Creer une organisation</Link>
        </div>
      </div>
    </AuthShellLayout>
  );
}

function RegisterView({ registerForm, setRegisterForm, handleRegister, error }) {
  return (
    <AuthShellLayout>
      <div className="auth-card">
        <div className="auth-card-header">
          <h2>Creer un compte</h2>
          <p>Rejoignez Factures IA aujourd'hui</p>
        </div>

        <form onSubmit={handleRegister} className="stack-form">
          <div className="form-group">
            <label htmlFor="reg-org">Nom de l'organisation</label>
            <input 
              id="reg-org" 
              required
              value={registerForm.organization_name} 
              onChange={(e) => setRegisterForm({ ...registerForm, organization_name: e.target.value })} 
              placeholder="Ex: ACME Corp" 
            />
          </div>

          <div className="form-group">
            <label htmlFor="reg-user">Nom d'utilisateur</label>
            <input 
              id="reg-user" 
              required
              value={registerForm.username} 
              onChange={(e) => setRegisterForm({ ...registerForm, username: e.target.value })} 
              placeholder="Ex: alex" 
            />
          </div>

          <div className="form-group">
            <label htmlFor="reg-email">Adresse email</label>
            <input 
              id="reg-email" 
              type="email" 
              required
              value={registerForm.email} 
              onChange={(e) => setRegisterForm({ ...registerForm, email: e.target.value })} 
              placeholder="alex@example.com" 
            />
          </div>

          <div className="form-group">
            <label htmlFor="reg-pass">Mot de passe</label>
            <input 
              id="reg-pass" 
              type="password" 
              required
              value={registerForm.password} 
              onChange={(e) => setRegisterForm({ ...registerForm, password: e.target.value })} 
              placeholder="••••••••" 
            />
          </div>

          <button id="reg-submit" type="submit">
            Creer le compte →
          </button>
        </form>

        {error && (
          <p className={error.includes("créé") ? "success-text" : "error-text"} style={{ marginTop: '16px', textAlign: 'center' }}>
            {error}
          </p>
        )}

        <div className="auth-toggle-footer">
          Deja un compte ? 
          <Link to="/login">Se connecter</Link>
        </div>
      </div>
    </AuthShellLayout>
  );
}
