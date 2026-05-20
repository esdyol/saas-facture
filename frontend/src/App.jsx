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
              <div className="dashboard-header">
                <div className="dashboard-header-text">
                  <h2>Vue d'ensemble</h2>
                  <p>Suivez l'extraction de vos factures et vos dépenses en temps réel.</p>
                </div>
                <button 
                  type="button" 
                  className="btn-primary" 
                  onClick={() => navigate("/invoices")}
                >
                  📤 Importer une facture
                </button>
              </div>

              <div className="dashboard-layout-grid">
                <div className="dashboard-main-col">
                  {/* KPI Cards */}
                  <article className="panel hero-panel" style={{ paddingBottom: '20px' }}>
                    <p className="eyebrow" style={{ color: 'var(--brand-light)' }}>📊 Indicateurs clés</p>
                    <div className="stats-grid" style={{ marginTop: '12px' }}>
                      <StatCard 
                        label="Total factures" 
                        value={dashboard?.kpis?.invoiceCount ?? invoices.length} 
                        icon="📄" 
                        trendText="Tous documents"
                        trendType="neutral"
                      />
                      <StatCard 
                        label="Validées" 
                        value={dashboard?.kpis?.validatedCount ?? invoices.filter(i => i.status === 'done').length} 
                        icon="✓" 
                        trendText="Prêt compta"
                        trendType="positive"
                      />
                      <StatCard 
                        label="En traitement" 
                        value={dashboard?.kpis?.processingCount ?? invoices.filter(i => ['uploaded', 'processing'].includes(i.status)).length} 
                        icon="⚙️" 
                        trendText="IA en cours"
                        trendType="neutral"
                      />
                      <StatCard 
                        label="Dépenses totales" 
                        value={formatMoney(dashboard?.kpis?.totalSpend ?? invoices.filter(i => i.status === 'done').reduce((acc, i) => acc + (i.amountTtc || 0), 0))} 
                        icon="💶" 
                        trendText="TTC Validé"
                        trendType="positive"
                      />
                    </div>
                  </article>

                  {/* Monthly Trend Area Chart */}
                  <article className="panel chart-panel-premium">
                    <div className="panel-title-row">
                      <div>
                        <p className="eyebrow" style={{ color: 'var(--brand-light)' }}>📈 Analyse financière</p>
                        <h3>Tendance des dépenses</h3>
                      </div>
                      <div className="chart-legend">
                        <div className="legend-item">
                          <span className="legend-color-dot" />
                          <span>Dépenses mensuelles (EUR)</span>
                        </div>
                      </div>
                    </div>
                    <CustomAreaChart data={dashboard?.monthlySpend || []} />
                  </article>

                  {/* Recent Invoices Table */}
                  <article className="panel recent-invoices-card">
                    <div className="recent-invoices-header">
                      <div>
                        <p className="eyebrow" style={{ color: 'var(--brand-light)' }}>📁 Activité récente</p>
                        <h3>Derniers documents traités</h3>
                      </div>
                      <Link to="/invoices" style={{ fontSize: '0.82rem', fontWeight: 600 }}>Voir tout →</Link>
                    </div>
                    <RecentInvoicesTable 
                      invoices={dashboard?.latestInvoices ?? invoices.slice(0, 5)} 
                      onReview={(id) => {
                        setSelectedId(id);
                        navigate("/invoices");
                      }}
                    />
                  </article>
                </div>

                <div className="dashboard-side-col">
                  {/* Quota Gauge */}
                  <article className="panel">
                    <p className="eyebrow" style={{ color: 'var(--teal)' }}>⚡ Quota de l'organisation</p>
                    <h3>Consommation mensuelle</h3>
                    <QuotaRadialCircle 
                      used={dashboard?.organization?.quotaUsed ?? user?.organization?.quotaUsed ?? invoices.length}
                      total={dashboard?.organization?.monthlyQuota ?? user?.organization?.monthlyQuota ?? 20}
                    />
                  </article>

                  {/* Category Spend Progress Bar */}
                  <article className="panel">
                    <p className="eyebrow" style={{ color: 'var(--teal)' }}>🏷️ Répartition analytique</p>
                    <h3>Dépenses par catégorie</h3>
                    <CategoryBars categories={dashboard?.categorySpend || []} />
                  </article>
                </div>
              </div>
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

function StatCard({ label, value, icon, trendText, trendType = "positive" }) {
  return (
    <div className="stat-card">
      <div className="stat-card-header">
        <span>{label}</span>
        {icon && <span className="stat-card-icon">{icon}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <strong>{value}</strong>
        {trendText && (
          <span className={`kpi-trend ${trendType}`}>
            {trendText}
          </span>
        )}
      </div>
    </div>
  );
}

function CustomAreaChart({ data }) {
  const [activePoint, setActivePoint] = useState(null);

  if (!data || data.length === 0) {
    return (
      <div className="svg-chart-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="svg-no-data">Aucune donnée disponible pour le graphique.</div>
      </div>
    );
  }

  // Margin and dimensions
  const margin = { top: 20, right: 20, bottom: 30, left: 55 };
  const containerWidth = 500;
  const containerHeight = 200;
  
  const chartWidth = containerWidth - margin.left - margin.right;
  const chartHeight = containerHeight - margin.top - margin.bottom;

  // Max value calculation
  const maxVal = Math.max(...data.map((d) => d.total), 100);
  const maxY = Math.ceil(maxVal * 1.15); // Add padding to top

  // Map data to SVG coordinates
  const points = data.map((d, index) => {
    const x = margin.left + (index / (data.length - 1 || 1)) * chartWidth;
    const y = margin.top + chartHeight - (d.total / maxY) * chartHeight;
    return { x, y, month: d.month, total: d.total };
  });

  // SVG Bezier path string
  const getBezierPath = (pts) => {
    if (pts.length === 0) return "";
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const cpX1 = p0.x + (p1.x - p0.x) / 3;
      const cpY1 = p0.y;
      const cpX2 = p0.x + 2 * (p1.x - p0.x) / 3;
      const cpY2 = p1.y;
      d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${p1.x} ${p1.y}`;
    }
    return d;
  };

  const getAreaPath = (pts) => {
    if (pts.length === 0) return "";
    const linePath = getBezierPath(pts);
    return `${linePath} L ${pts[pts.length - 1].x} ${margin.top + chartHeight} L ${pts[0].x} ${margin.top + chartHeight} Z`;
  };

  const linePath = getBezierPath(points);
  const areaPath = getAreaPath(points);

  // Y-axis grid labels (4 ticks)
  const yTicks = [0, Math.round(maxY / 3), Math.round((2 * maxY) / 3), maxY];

  return (
    <div className="svg-chart-wrapper">
      <svg className="svg-chart-container" viewBox={`0 0 ${containerWidth} ${containerHeight}`} width="100%" height="100%">
        <defs>
          <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brand-light)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="var(--brand-glow)" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Gridlines */}
        {yTicks.map((tick, index) => {
          const yPos = margin.top + chartHeight - (tick / maxY) * chartHeight;
          return (
            <g key={index}>
              <line
                className="svg-chart-gridline"
                x1={margin.left}
                y1={yPos}
                x2={containerWidth - margin.right}
                y2={yPos}
              />
              <text
                className="svg-chart-axis-text svg-chart-axis-text-y"
                x={margin.left - 8}
                y={yPos + 4}
              >
                {formatMoney(tick)}
              </text>
            </g>
          );
        })}

        {/* X axis line */}
        <line
          className="svg-chart-axis-line"
          x1={margin.left}
          y1={margin.top + chartHeight}
          x2={containerWidth - margin.right}
          y2={margin.top + chartHeight}
        />

        {/* Filled Area */}
        {areaPath && <path className="svg-chart-area" d={areaPath} />}

        {/* Smooth Line */}
        {linePath && <path className="svg-chart-line" d={linePath} />}

        {/* Points & Interactive Hover Circles */}
        {points.map((pt, index) => (
          <g key={index}>
            <circle
              className="svg-chart-point-outer"
              cx={pt.x}
              cy={pt.y}
              r="5"
              onMouseEnter={() => setActivePoint(pt)}
              onMouseLeave={() => setActivePoint(null)}
            />
            <circle
              className="svg-chart-point-inner"
              cx={pt.x}
              cy={pt.y}
              r="2"
            />
            {/* X axis labels */}
            <text
              className="svg-chart-axis-text"
              x={pt.x}
              y={containerHeight - 8}
            >
              {pt.month}
            </text>
          </g>
        ))}
      </svg>

      {/* Interactive Tooltip */}
      {activePoint && (
        <div
          className="chart-tooltip-portal"
          style={{
            left: `${(activePoint.x / containerWidth) * 100}%`,
            top: `${(activePoint.y / containerHeight) * 100}%`,
            opacity: 1,
          }}
        >
          <span className="chart-tooltip-month">{activePoint.month}</span>
          <span className="chart-tooltip-value">{formatMoney(activePoint.total)}</span>
        </div>
      )}
    </div>
  );
}

function QuotaRadialCircle({ used = 0, total = 0 }) {
  const hasLimit = total && total > 0;
  const percentage = hasLimit ? Math.min(Math.round((used / total) * 100), 100) : 0;
  
  // Circumference for r = 40 (cx = 50, cy = 50)
  const strokeDasharray = 251.2;
  const strokeDashoffset = hasLimit ? strokeDasharray - (percentage / 100) * strokeDasharray : 0;

  return (
    <div className="quota-radial-widget">
      <div className="radial-svg-container">
        <svg viewBox="0 0 100 100" width="100%" height="100%">
          <circle
            className="radial-svg-circle-bg"
            cx="50"
            cy="50"
            r="40"
          />
          <circle
            className="radial-svg-circle-fill"
            cx="50"
            cy="50"
            r="40"
            strokeDasharray={strokeDasharray}
            strokeDashoffset={strokeDashoffset}
          />
        </svg>
        <div className="radial-label-container">
          <span className="radial-label-value">
            {hasLimit ? `${percentage}%` : "∞"}
          </span>
          <span className="radial-label-text">
            {hasLimit ? "Utilisé" : "Illimité"}
          </span>
        </div>
      </div>
      <div className="quota-radial-footer">
        {hasLimit ? (
          <>
            <strong>{used}</strong> sur <strong>{total}</strong> factures traitées ce mois-ci
          </>
        ) : (
          <>
            <strong>{used}</strong> factures traitées ce mois-ci (Plan illimité)
          </>
        )}
      </div>
    </div>
  );
}

function CategoryBars({ categories = [] }) {
  const colors = ["#6366f1", "#14b8a6", "#f59e0b", "#f43f5e", "#10b981"];
  
  if (!categories || categories.length === 0) {
    return <p className="helper-text" style={{ fontStyle: 'italic', textAlign: 'center', marginTop: '16px' }}>Aucune donnée de catégorie disponible.</p>;
  }

  const maxVal = Math.max(...categories.map((c) => c.total), 1) || 1;

  return (
    <div className="category-spend-list">
      {categories.map((item, index) => {
        const color = colors[index % colors.length];
        const pct = Math.max((item.total / maxVal) * 100, 5); // at least 5% visual fill
        return (
          <div key={item.category || index} className="category-item">
            <div className="category-item-header">
              <span className="category-name-badge">
                <span className="category-color-pill" style={{ backgroundColor: color }} />
                {item.category || "Autre"}
              </span>
              <span className="category-amount" style={{ color: color }}>
                {formatMoney(item.total)}
              </span>
            </div>
            <div className="category-bar-track">
              <div 
                className="category-bar-fill" 
                style={{ 
                  width: `${pct}%`, 
                  backgroundColor: color,
                  color: color
                }} 
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecentInvoicesTable({ invoices = [], onReview }) {
  if (!invoices || invoices.length === 0) {
    return <p className="helper-text" style={{ fontStyle: 'italic', textAlign: 'center', marginTop: '16px' }}>Aucune facture récente.</p>;
  }

  return (
    <div className="recent-table-wrapper">
      <table className="recent-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Fournisseur</th>
            <th>Statut</th>
            <th>Total TTC</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id}>
              <td>
                <div className="recent-inv-name" title={inv.fileName}>{inv.fileName}</div>
                <div className="recent-inv-date">{inv.invoiceDate || "Sans date"}</div>
              </td>
              <td>
                <span style={{ fontWeight: 500 }}>{inv.supplier || "À identifier"}</span>
              </td>
              <td>
                <span className={`badge ${badgeTone(inv.status)}`}>{inv.status}</span>
              </td>
              <td>
                <span className="recent-inv-amount">{formatMoney(inv.amountTtc)}</span>
              </td>
              <td>
                <button 
                  type="button" 
                  className="recent-inv-action-btn"
                  onClick={() => onReview(inv.id)}
                >
                  🔍 Revoir
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
