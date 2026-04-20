// Check Please — v2.0
// =====================

(function () {
  'use strict';

  // ==========================================
  // CONFIG & STATE
  // ==========================================
  const CONFIG_KEY = 'cp_config';
  const DEFAULT_API_KEY = '';
  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const DEDUCTION_RATE = 0.04;

  let appConfig = { apiKey: DEFAULT_API_KEY, sbUrl: '', sbKey: '' };
  let selectedFiles = [];
  let objectUrls = [];
  let sbClient = null;
  let currentResults = null;
  let toastTimer = null;

  // ==========================================
  // INIT
  // ==========================================
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    loadConfig();
    initSupabase();
    setupNavigation();
    setupEventListeners();
    setupToggleVisibility();
  }

  // ==========================================
  // CONFIG
  // ==========================================
  function loadConfig() {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) {
      try {
        const p = JSON.parse(saved);
        appConfig.apiKey = p.apiKey || DEFAULT_API_KEY;
        appConfig.sbUrl = p.sbUrl || '';
        appConfig.sbKey = p.sbKey || '';
      } catch (e) { /* use defaults */ }
    }
    document.getElementById('input-api-key').value = appConfig.apiKey;
    document.getElementById('input-sb-url').value = appConfig.sbUrl;
    document.getElementById('input-sb-key').value = appConfig.sbKey;
  }

  function saveConfig() {
    appConfig.apiKey = document.getElementById('input-api-key').value.trim() || DEFAULT_API_KEY;
    appConfig.sbUrl = document.getElementById('input-sb-url').value.trim();
    appConfig.sbKey = document.getElementById('input-sb-key').value.trim();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(appConfig));
    initSupabase();
    showToast('Configuration saved');
  }

  // ==========================================
  // SUPABASE
  // ==========================================
  function initSupabase() {
    const el = document.getElementById('system-status-msg');

    if (!appConfig.sbUrl || !appConfig.sbKey) {
      sbClient = null;
      el.textContent = 'Database not configured';
      el.className = 'system-status';
      return;
    }

    try {
      sbClient = window.supabase.createClient(appConfig.sbUrl, appConfig.sbKey);
      el.textContent = '● Connected';
      el.className = 'system-status connected';
      loadHistory();
    } catch (e) {
      sbClient = null;
      el.textContent = '● Connection failed';
      el.className = 'system-status error';
    }
  }

  // ==========================================
  // NAVIGATION
  // ==========================================
  function setupNavigation() {
    const btns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');

    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));
        btn.classList.add('active');

        const target = document.getElementById(btn.dataset.target);
        if (target) target.classList.add('active');

        if (btn.dataset.target === 'history-page') loadHistory();
      });
    });
  }

  // ==========================================
  // EVENT LISTENERS
  // ==========================================
  function setupEventListeners() {
    document.getElementById('btn-save-settings').addEventListener('click', saveConfig);
    document.getElementById('btn-camera').addEventListener('click', () => document.getElementById('camera-input').click());
    document.getElementById('btn-gallery').addEventListener('click', () => document.getElementById('gallery-input').click());
    document.getElementById('camera-input').addEventListener('change', handleFileSelect);
    document.getElementById('gallery-input').addEventListener('change', handleFileSelect);
    document.getElementById('btn-process').addEventListener('click', processReceipts);
    document.getElementById('btn-save-record').addEventListener('click', saveRecord);
    document.getElementById('btn-clear').addEventListener('click', resetScanUI);
    document.getElementById('btn-new-scan').addEventListener('click', resetScanUI);
  }

  function setupToggleVisibility() {
    const pairs = [
      ['toggle-api-key', 'input-api-key'],
      ['toggle-sb-key', 'input-sb-key']
    ];
    pairs.forEach(([btnId, inputId]) => {
      document.getElementById(btnId).addEventListener('click', () => {
        const input = document.getElementById(inputId);
        input.type = input.type === 'password' ? 'text' : 'password';
      });
    });
  }

  // ==========================================
  // FILE HANDLING
  // ==========================================
  function handleFileSelect(e) {
    if (!e.target.files || e.target.files.length === 0) return;
    selectedFiles = [...selectedFiles, ...Array.from(e.target.files)];
    e.target.value = '';
    updatePreview();
  }

  function removeFile(index) {
    if (objectUrls[index]) URL.revokeObjectURL(objectUrls[index]);
    selectedFiles.splice(index, 1);
    objectUrls.splice(index, 1);
    updatePreview();
  }

  function updatePreview() {
    const section = document.getElementById('preview-section');
    const container = document.getElementById('image-preview-container');
    const countEl = document.getElementById('selected-count');
    const emptyState = document.getElementById('empty-state');

    // Revoke old URLs
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];

    if (selectedFiles.length === 0) {
      section.style.display = 'none';
      emptyState.style.display = 'flex';
      container.innerHTML = '';
      return;
    }

    emptyState.style.display = 'none';
    section.style.display = 'block';
    countEl.textContent = `${selectedFiles.length} receipt${selectedFiles.length > 1 ? 's' : ''}`;
    container.innerHTML = '';

    selectedFiles.forEach((file, i) => {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);

      const wrap = document.createElement('div');
      wrap.className = 'img-thumb-wrap';

      const img = document.createElement('img');
      img.src = url;
      img.className = 'img-thumb';
      img.alt = 'Receipt';

      const removeBtn = document.createElement('button');
      removeBtn.className = 'img-remove';
      removeBtn.innerHTML = '×';
      removeBtn.addEventListener('click', () => removeFile(i));

      wrap.appendChild(img);
      wrap.appendChild(removeBtn);
      container.appendChild(wrap);
    });
  }

  function resetScanUI() {
    selectedFiles = [];
    currentResults = null;
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];
    document.getElementById('preview-section').style.display = 'none';
    document.getElementById('results-panel').style.display = 'none';
    document.getElementById('status-indicator').style.display = 'none';
    document.getElementById('empty-state').style.display = 'flex';
    document.getElementById('image-preview-container').innerHTML = '';
    document.getElementById('currency-grid').innerHTML = '';
  }

  // ==========================================
  // PROCESSING
  // ==========================================
  const PROMPT = `You are a receipt/bill analyzer. Analyze every image. Each image is a receipt or bill.

For EACH receipt, identify the total amount and its currency (TL, USD, EUR, or GBP).
If a receipt shows multiple currencies, extract each separately.
Sum up all amounts per currency across ALL receipts.

Return ONLY valid JSON, no markdown, no explanation:
{"TL": 0, "USD": 0, "EUR": 0, "GBP": 0}

Rules:
- Use the TOTAL / TOPLAM / Grand Total line, NOT individual item prices.
- ₺ or TRY → "TL".
- If currency is unclear, default to TL.
- Plain numbers (no thousands separators). Dot for decimals.
- If no amount found for a currency, set to 0.`;

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = () => reject(new Error('Read error: ' + file.name));
      r.readAsDataURL(file);
    });
  }

  async function processReceipts() {
    if (!appConfig.apiKey) { showToast('Set your key in settings'); return; }
    if (selectedFiles.length === 0) return;

    const indicator = document.getElementById('status-indicator');
    const resultsPanel = document.getElementById('results-panel');
    const previewSection = document.getElementById('preview-section');

    previewSection.style.display = 'none';
    resultsPanel.style.display = 'none';
    indicator.style.display = 'flex';

    try {
      const parts = [];
      for (const f of selectedFiles) {
        const b64 = await toBase64(f);
        parts.push({ inlineData: { mimeType: f.type || 'image/jpeg', data: b64 } });
      }

      const payload = {
        contents: [{ parts: [...parts, { text: PROMPT }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      };

      let lastErr = null;
      for (const model of GEMINI_MODELS) {
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${appConfig.apiKey}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
          );

          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            lastErr = new Error(e?.error?.message || `HTTP ${res.status}`);
            continue;
          }

          const result = await res.json();
          const rParts = result?.candidates?.[0]?.content?.parts;
          if (!rParts?.length) { lastErr = new Error('Empty response'); continue; }

          // Find last text part (thinking models put thoughts first)
          let txt = null;
          for (let i = rParts.length - 1; i >= 0; i--) {
            if (rParts[i].text) { txt = rParts[i].text; break; }
          }
          if (!txt) { lastErr = new Error('No text'); continue; }

          renderResults(JSON.parse(txt));
          showToast('Analysis complete');
          lastErr = null;
          break;

        } catch (e) { lastErr = e; continue; }
      }

      if (lastErr) throw lastErr;

    } catch (err) {
      console.error(err);
      showToast(err.message || 'Processing failed');
      // Show preview again so user can retry
      document.getElementById('preview-section').style.display = 'block';
    } finally {
      indicator.style.display = 'none';
    }
  }

  // ==========================================
  // RESULTS
  // ==========================================
  function renderResults(data) {
    const round2 = v => Math.round((Number(v) || 0) * 100) / 100;
    currentResults = { TL: round2(data.TL), USD: round2(data.USD), EUR: round2(data.EUR), GBP: round2(data.GBP) };

    const grid = document.getElementById('currency-grid');
    grid.innerHTML = '';

    const fmt = v => v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const symbols = { TL: '₺', USD: '$', EUR: '€', GBP: '£' };
    const active = ['TL', 'USD', 'EUR', 'GBP'].filter(c => currentResults[c] > 0);

    if (active.length === 0) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-3);padding:32px 0;font-size:14px;">No amounts detected.</div>';
      document.getElementById('results-panel').style.display = 'block';
      return;
    }

    active.forEach(curr => {
      const total = currentResults[curr];
      const net = round2(total * (1 - DEDUCTION_RATE));
      const card = document.createElement('div');
      card.className = 'curr-card';
      card.innerHTML = `
        <div class="curr-label">${curr}</div>
        <div class="curr-val">${symbols[curr]}${fmt(total)}</div>
        <div class="curr-deduction">Net (-4%): <span>${symbols[curr]}${fmt(net)}</span></div>
      `;
      grid.appendChild(card);
    });

    // If only one currency, make it span full width
    if (active.length === 1) {
      grid.querySelector('.curr-card').classList.add('full-width');
    }

    document.getElementById('results-panel').style.display = 'block';
    // Scroll results into view
    document.getElementById('results-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ==========================================
  // DATABASE
  // ==========================================
  async function saveRecord() {
    if (!sbClient) { showToast('Configure database in settings'); return; }
    if (!currentResults) return;

    const btn = document.getElementById('btn-save-record');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      const { error } = await sbClient
        .from('receipt_analyses')
        .insert([{
          tl: currentResults.TL, usd: currentResults.USD,
          eur: currentResults.EUR, gbp: currentResults.GBP,
          raw_data: currentResults
        }]);
      if (error) throw error;

      showToast('Record saved');
      resetScanUI();
    } catch (e) {
      showToast('Save failed');
    } finally {
      btn.textContent = 'Save Record';
      btn.disabled = false;
    }
  }

  async function loadHistory() {
    if (!sbClient) return;
    const container = document.getElementById('history-container');

    try {
      const { data, error } = await sbClient
        .from('receipt_analyses')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      if (!data || data.length === 0) {
        container.innerHTML = `
          <div class="history-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;margin-bottom:12px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <div>No records yet</div>
            <div class="history-hint">Scanned receipts will appear here.</div>
          </div>`;
        return;
      }

      const fmt = v => Number(v || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const symbols = { tl: '₺', usd: '$', eur: '€', gbp: '£' };
      const round2 = v => Math.round(v * 100) / 100;

      container.innerHTML = data.map((row, idx) => {
        const d = new Date(row.created_at);
        const dateStr = d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' })
          + ' · ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

        const currencies = [
          { key: 'tl', label: 'TL' }, { key: 'usd', label: 'USD' },
          { key: 'eur', label: 'EUR' }, { key: 'gbp', label: 'GBP' }
        ];

        let stats = currencies
          .filter(c => Number(row[c.key] || 0) > 0)
          .map(c => {
            const v = Number(row[c.key]);
            const n = round2(v * (1 - DEDUCTION_RATE));
            return `<div class="h-stat"><span>${c.label}</span> ${symbols[c.key]}${fmt(v)}</div>`;
          })
          .join('');

        if (!stats) stats = '<div class="h-stat" style="color:var(--text-3)">No amounts</div>';

        return `
          <div class="history-item" style="animation-delay:${idx * 40}ms">
            <div class="history-header">
              <div class="history-date">${dateStr}</div>
              <button class="history-delete" onclick="window.__del('${row.id}',this)">Delete</button>
            </div>
            <div class="history-stats">${stats}</div>
          </div>`;
      }).join('');

    } catch (e) {
      container.innerHTML = '<div class="history-empty">Failed to load records.</div>';
    }
  }

  window.__del = async function (id, btn) {
    if (!sbClient || !id) return;
    btn.textContent = '...';
    btn.disabled = true;
    try {
      const { error } = await sbClient.from('receipt_analyses').delete().eq('id', id);
      if (error) throw error;
      showToast('Deleted');
      loadHistory();
    } catch (e) {
      showToast('Delete failed');
      btn.textContent = 'Delete';
      btn.disabled = false;
    }
  };

  // ==========================================
  // TOAST
  // ==========================================
  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    el.classList.add('show');
    toastTimer = setTimeout(() => { el.classList.remove('show'); toastTimer = null; }, 3000);
  }

})();
