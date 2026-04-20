// Check Please — Application Logic
// ==================================

(function () {
  'use strict';

  // ==========================================
  // CONFIG & STATE
  // ==========================================
  const CONFIG_KEY = 'cp_config';
  const DEFAULT_API_KEY = ''; // Enter via Settings page
  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const DEDUCTION_RATE = 0.04; // 4%

  let appConfig = {
    apiKey: DEFAULT_API_KEY,
    sbUrl: '',
    sbKey: ''
  };

  let selectedFiles = [];
  let objectUrls = [];       // Track to revoke later
  let sbClient = null;       // Supabase client (renamed to avoid global collision)
  let currentResults = null;
  let toastTimer = null;

  // ==========================================
  // INITIALIZATION
  // ==========================================
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    loadConfig();
    initSupabase();
    setupNavigation();
    setupEventListeners();
  }

  // ==========================================
  // CONFIG MANAGEMENT
  // ==========================================
  function loadConfig() {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        appConfig.apiKey = parsed.apiKey || DEFAULT_API_KEY;
        appConfig.sbUrl = parsed.sbUrl || '';
        appConfig.sbKey = parsed.sbKey || '';
      } catch (e) {
        console.warn('Config parse error, using defaults');
      }
    }
    // Populate settings form
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
    const statusEl = document.getElementById('system-status-msg');

    if (!appConfig.sbUrl || !appConfig.sbKey) {
      sbClient = null;
      statusEl.textContent = 'Database not configured';
      return;
    }

    try {
      sbClient = window.supabase.createClient(appConfig.sbUrl, appConfig.sbKey);
      statusEl.textContent = 'Database: Connected';
      loadHistory(); // only load history after successful init
    } catch (e) {
      sbClient = null;
      statusEl.textContent = 'Database connection failed';
      console.error('Supabase init error:', e);
    }
  }

  // ==========================================
  // NAVIGATION
  // ==========================================
  function setupNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    const views = document.querySelectorAll('.view');

    navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        navBtns.forEach(b => b.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.getAttribute('data-target');
        const targetView = document.getElementById(targetId);
        if (targetView) targetView.classList.add('active');

        if (targetId === 'history-page') loadHistory();
      });
    });
  }

  // ==========================================
  // EVENT LISTENERS
  // ==========================================
  function setupEventListeners() {
    document.getElementById('btn-save-settings').addEventListener('click', saveConfig);

    document.getElementById('btn-camera').addEventListener('click', () => {
      document.getElementById('camera-input').click();
    });

    document.getElementById('btn-gallery').addEventListener('click', () => {
      document.getElementById('gallery-input').click();
    });

    document.getElementById('camera-input').addEventListener('change', handleFileSelect);
    document.getElementById('gallery-input').addEventListener('change', handleFileSelect);

    document.getElementById('btn-process').addEventListener('click', processReceipts);
    document.getElementById('btn-save-record').addEventListener('click', saveRecordToDatabase);
    document.getElementById('btn-clear').addEventListener('click', resetScanUI);
  }

  function handleFileSelect(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    selectedFiles = [...selectedFiles, ...Array.from(files)];
    renderImagePreviews();
    document.getElementById('btn-process').style.display = 'block';
    document.getElementById('btn-clear').style.display = 'block';

    // Reset input value so the same file can be re-selected
    e.target.value = '';
  }

  // ==========================================
  // IMAGE PREVIEW
  // ==========================================
  function renderImagePreviews() {
    const container = document.getElementById('image-preview-container');
    const countEl = document.getElementById('selected-count');

    // Revoke previous object URLs to prevent memory leaks
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];

    if (selectedFiles.length === 0) {
      container.style.display = 'none';
      countEl.style.display = 'none';
      container.innerHTML = '';
      return;
    }

    container.style.display = 'flex';
    countEl.style.display = 'block';
    countEl.textContent = `${selectedFiles.length} receipt${selectedFiles.length > 1 ? 's' : ''} selected`;
    container.innerHTML = '';

    selectedFiles.forEach(file => {
      const url = URL.createObjectURL(file);
      objectUrls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.className = 'img-thumb';
      img.alt = 'Receipt preview';
      container.appendChild(img);
    });
  }

  function resetScanUI() {
    selectedFiles = [];
    currentResults = null;
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];
    renderImagePreviews();
    document.getElementById('btn-process').style.display = 'none';
    document.getElementById('btn-clear').style.display = 'none';
    document.getElementById('results-panel').style.display = 'none';
    document.getElementById('status-indicator').style.display = 'none';
    document.getElementById('currency-grid').innerHTML = '';
  }

  // ==========================================
  // RECEIPT PROCESSING
  // ==========================================
  const PROMPT = `You are a receipt/bill analyzer. Analyze every image provided. Each image is a receipt or bill.

For EACH receipt, identify the total amount and its currency (TL, USD, EUR, or GBP).
If a receipt shows multiple currencies, extract each separately.
Sum up all amounts per currency across ALL receipts.

Return ONLY valid JSON, no markdown, no explanation:
{"TL": 0, "USD": 0, "EUR": 0, "GBP": 0}

Rules:
- Use the TOTAL / TOPLAM / Grand Total line, not individual item prices.
- If the currency symbol is ₺ or "TRY", map it to "TL".
- If you can't determine the currency, default to TL.
- Numbers must be plain (no thousands separators). Use dot for decimals.
- If no amount found for a currency, set it to 0.`;

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Failed to read file: ' + file.name));
      reader.readAsDataURL(file);
    });
  }

  async function processReceipts() {
    if (!appConfig.apiKey) {
      showToast('Set configuration key in settings');
      return;
    }
    if (selectedFiles.length === 0) return;

    const btnProcess = document.getElementById('btn-process');
    const indicator = document.getElementById('status-indicator');
    const resultsPanel = document.getElementById('results-panel');

    btnProcess.style.display = 'none';
    resultsPanel.style.display = 'none';
    indicator.style.display = 'flex';

    try {
      // Convert all images to base64
      const imageParts = [];
      for (const file of selectedFiles) {
        const b64 = await toBase64(file);
        imageParts.push({
          inlineData: { mimeType: file.type || 'image/jpeg', data: b64 }
        });
      }

      const payload = {
        contents: [{ parts: [...imageParts, { text: PROMPT }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json'
        }
      };

      // Try models in fallback order
      let lastError = null;
      for (const model of GEMINI_MODELS) {
        try {
          console.log('Trying model:', model);
          const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${appConfig.apiKey}`;

          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            const msg = errBody?.error?.message || `HTTP ${response.status}`;
            console.warn(`Model ${model} failed:`, msg);
            lastError = new Error(msg);
            continue; // try next model
          }

          const result = await response.json();

          // Safely navigate — thinking models return thought parts before text
          const parts = result?.candidates?.[0]?.content?.parts;
          if (!parts || parts.length === 0) {
            lastError = new Error('Empty response');
            continue;
          }

          // Find the last text part
          let text = null;
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i].text) { text = parts[i].text; break; }
          }

          if (!text) { lastError = new Error('No text in response'); continue; }

          console.log('Success with model:', model);
          const data = JSON.parse(text);
          renderResults(data);
          showToast('Analysis complete');
          lastError = null;
          break; // success, stop trying

        } catch (e) {
          console.warn(`Model ${model} error:`, e.message);
          lastError = e;
          continue;
        }
      }

      if (lastError) throw lastError;

    } catch (err) {
      console.error('Process error:', err);
      showToast(err.message || 'Processing failed');
      btnProcess.style.display = 'block';
    } finally {
      indicator.style.display = 'none';
    }
  }

  // ==========================================
  // RESULTS RENDERING
  // ==========================================
  function renderResults(data) {
    currentResults = {
      TL: Math.round((Number(data.TL) || 0) * 100) / 100,
      USD: Math.round((Number(data.USD) || 0) * 100) / 100,
      EUR: Math.round((Number(data.EUR) || 0) * 100) / 100,
      GBP: Math.round((Number(data.GBP) || 0) * 100) / 100
    };

    const grid = document.getElementById('currency-grid');
    grid.innerHTML = '';

    const currencies = ['TL', 'USD', 'EUR', 'GBP'];
    const fmt = (v) => v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    currencies.forEach(curr => {
      const total = currentResults[curr];
      if (total === 0) return; // only show currencies with value

      const net = Math.round(total * (1 - DEDUCTION_RATE) * 100) / 100;

      const card = document.createElement('div');
      card.className = 'curr-card';
      card.innerHTML = `
        <div class="curr-label">${curr}</div>
        <div class="curr-val">${fmt(total)}</div>
        <div class="curr-deduction">Net (-4%): <span>${fmt(net)}</span></div>
      `;
      grid.appendChild(card);
    });

    // If ALL are zero, show a message
    const allZero = currencies.every(c => currentResults[c] === 0);
    if (allZero) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:20px;">No amounts detected in receipts.</div>';
    }

    document.getElementById('results-panel').style.display = 'block';
  }

  // ==========================================
  // DATABASE — SAVE
  // ==========================================
  async function saveRecordToDatabase() {
    if (!sbClient) {
      showToast('Database not configured');
      return;
    }
    if (!currentResults) return;

    const btn = document.getElementById('btn-save-record');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      const { error } = await sbClient
        .from('receipt_analyses')
        .insert([{
          tl: currentResults.TL,
          usd: currentResults.USD,
          eur: currentResults.EUR,
          gbp: currentResults.GBP,
          raw_data: currentResults
        }]);

      if (error) throw error;

      showToast('Record saved');
      resetScanUI();
    } catch (e) {
      console.error('Save error:', e);
      showToast('Save failed: ' + (e.message || 'Unknown error'));
    } finally {
      btn.textContent = 'Save Record';
      btn.disabled = false;
    }
  }

  // ==========================================
  // DATABASE — HISTORY
  // ==========================================
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
        container.innerHTML = '<div class="history-empty">No records yet.</div>';
        return;
      }

      const fmt = (v) => Number(v || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      container.innerHTML = data.map(row => {
        const d = new Date(row.created_at);
        const dateStr = d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' })
          + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

        const currencies = [
          { key: 'tl', label: 'TL' },
          { key: 'usd', label: 'USD' },
          { key: 'eur', label: 'EUR' },
          { key: 'gbp', label: 'GBP' }
        ];

        let statsHTML = currencies
          .filter(c => Number(row[c.key] || 0) > 0)
          .map(c => {
            const val = Number(row[c.key]);
            const net = Math.round(val * (1 - DEDUCTION_RATE) * 100) / 100;
            return `<div class="h-stat"><span>${c.label}:</span> ${fmt(val)} (Net: ${fmt(net)})</div>`;
          })
          .join('');

        if (!statsHTML) statsHTML = '<div class="h-stat">No amounts</div>';

        return `
          <div class="history-item">
            <div class="history-header">
              <div class="history-date">${dateStr}</div>
              <button class="history-delete" onclick="window.__deleteRecord('${row.id}', this)">Delete</button>
            </div>
            <div class="history-stats">${statsHTML}</div>
          </div>
        `;
      }).join('');

    } catch (e) {
      console.error('History load error:', e);
      container.innerHTML = '<div class="history-empty">Failed to load records.</div>';
    }
  }

  // Expose delete to global scope (needed for onclick in dynamic HTML)
  window.__deleteRecord = async function (id, btnEl) {
    if (!sbClient || !id) return;

    btnEl.textContent = '...';
    btnEl.disabled = true;

    try {
      const { error } = await sbClient
        .from('receipt_analyses')
        .delete()
        .eq('id', id);

      if (error) throw error;

      showToast('Record deleted');
      loadHistory();
    } catch (e) {
      console.error('Delete error:', e);
      showToast('Delete failed');
      btnEl.textContent = 'Delete';
      btnEl.disabled = false;
    }
  };

  // ==========================================
  // TOAST
  // ==========================================
  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;

    // Clear previous timer to prevent overlap
    if (toastTimer) clearTimeout(toastTimer);

    toast.classList.add('show');
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      toastTimer = null;
    }, 3000);
  }

})();
