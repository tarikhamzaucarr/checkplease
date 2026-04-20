// Check Please - Application Logic

// ==========================================
// STATE & CONFIG
// ==========================================
const CONFIG_KEY = 'cp_config';
let appConfig = {
  apiKey: 'AIzaSyDgqxL14Q4JxlIHFO-X76OYqpRp4gywIlY',     // The "processing key" (Gemini AI Key)
  sbUrl: '',      // Supabase URL
  sbKey: ''       // Supabase Anon Key
};

let selectedFiles = [];
let supabase = null;
let currentResults = null; // Stores parsed output of the current operation

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  initSupabase();
  setupNavigation();
  setupEventListeners();
  loadHistory();
});

function loadConfig() {
  const saved = localStorage.getItem(CONFIG_KEY);
  if (saved) {
    try {
      appConfig = JSON.parse(saved);
      document.getElementById('input-api-key').value = appConfig.apiKey || '';
      document.getElementById('input-sb-url').value = appConfig.sbUrl || '';
      document.getElementById('input-sb-key').value = appConfig.sbKey || '';
    } catch(e) {}
  }
}

function saveConfig() {
  appConfig.apiKey = document.getElementById('input-api-key').value.trim();
  appConfig.sbUrl = document.getElementById('input-sb-url').value.trim();
  appConfig.sbKey = document.getElementById('input-sb-key').value.trim();
  localStorage.setItem(CONFIG_KEY, JSON.stringify(appConfig));
  initSupabase();
  showToast('Configuration saved');
}

function initSupabase() {
  if (appConfig.sbUrl && appConfig.sbKey) {
    try {
      supabase = window.supabase.createClient(appConfig.sbUrl, appConfig.sbKey);
      document.getElementById('system-status-msg').textContent = 'Database connected state: Active';
      loadHistory();
    } catch(e) {
      document.getElementById('system-status-msg').textContent = 'Database connection failed';
    }
  } else {
    document.getElementById('system-status-msg').textContent = 'Database configuration missing';
  }
}

// ==========================================
// UI / NAVIGATION
// ==========================================
function setupNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  const views = document.querySelectorAll('.view');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Clear active states
      navBtns.forEach(b => b.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));
      
      // Set new active
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');

      if(targetId === 'history-page') {
        loadHistory();
      }
    });
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ==========================================
// FILE HANDLING
// ==========================================
function setupEventListeners() {
  // Settings
  document.getElementById('btn-save-settings').addEventListener('click', saveConfig);

  // Scan Actions
  document.getElementById('btn-camera').addEventListener('click', () => {
    document.getElementById('camera-input').click();
  });
  
  document.getElementById('btn-gallery').addEventListener('click', () => {
    document.getElementById('gallery-input').click();
  });

  const handleFiles = (e) => {
    if(e.target.files.length > 0) {
      // Append to selected files
      selectedFiles = [...selectedFiles, ...Array.from(e.target.files)];
      renderImagePreviews();
      document.getElementById('btn-process').style.display = 'block';
    }
    // reset input so same file can trigger change again if needed
    e.target.value = null; 
  };

  document.getElementById('camera-input').addEventListener('change', handleFiles);
  document.getElementById('gallery-input').addEventListener('change', handleFiles);

  // Process
  document.getElementById('btn-process').addEventListener('click', processReceipts);

  // Save Record
  document.getElementById('btn-save-record').addEventListener('click', saveRecordToDatabase);
}

function renderImagePreviews() {
  const container = document.getElementById('image-preview-container');
  container.style.display = selectedFiles.length > 0 ? 'flex' : 'none';
  container.innerHTML = '';
  
  selectedFiles.forEach(file => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.className = 'img-thumb';
    container.appendChild(img);
  });
}

function resetScanUI() {
  selectedFiles = [];
  currentResults = null;
  renderImagePreviews();
  document.getElementById('btn-process').style.display = 'none';
  document.getElementById('results-panel').style.display = 'none';
  
  const resets = ['tl', 'usd', 'eur', 'gbp'];
  resets.forEach(c => {
    document.getElementById(`res-val-${c}`).textContent = '0.00';
    document.getElementById(`res-net-${c}`).textContent = '0.00';
  });
}

// ==========================================
// PROCESSING LOGIC (GEMINI API)
// ==========================================
const PROMPT = `Analyze these images of receipts/bills. Find the TOTAL amounts charged, and categorize them strictly into the following currencies: TL (Turkish Lira), USD (US Dollars), EUR (Euros), GBP (British Pounds). 
If there are multiple receipts with the same currency, sum them up. 
Respond ONLY with a valid JSON document in the exact format shown below, and NO OTHER TEXT or formatting:
{"TL": 0.00, "USD": 0.00, "EUR": 0.00, "GBP": 0.00}`;

async function toBase64(file) {
  return new Promise((resolve) => {
    const rd = new FileReader();
    rd.onload = () => resolve(rd.result.split(',')[1]);
    rd.readAsDataURL(file);
  });
}

async function processReceipts() {
  if (!appConfig.apiKey) {
    showToast('Configuration key missing in settings.');
    return;
  }
  if (selectedFiles.length === 0) return;

  const btn = document.getElementById('btn-process');
  const ind = document.getElementById('status-indicator');
  const resPanel = document.getElementById('results-panel');

  btn.style.display = 'none';
  resPanel.style.display = 'none';
  ind.style.display = 'block';

  try {
    const imageParts = [];
    for (const f of selectedFiles) {
      const b64 = await toBase64(f);
      imageParts.push({ inlineData: { mimeType: f.type, data: b64 } });
    }

    const payload = {
      contents: [{ parts: [...imageParts, { text: PROMPT }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent?key=${appConfig.apiKey}`;
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    if (result.error) throw new Error(result.error.message);

    const txt = result.candidates[0].content.parts[0].text;
    const data = JSON.parse(txt);

    renderResults(data);
    showToast('Processing complete');

  } catch(e) {
    console.error(e);
    showToast('Failed to process. Check configuration.');
    btn.style.display = 'block';
  } finally {
    ind.style.display = 'none';
  }
}

function renderResults(data) {
  currentResults = {
    TL: Number(data.TL) || 0,
    USD: Number(data.USD) || 0,
    EUR: Number(data.EUR) || 0,
    GBP: Number(data.GBP) || 0
  };

  const setVal = (curr) => {
    const total = currentResults[curr];
    const net = total * 0.96; // 4% deduction
    
    document.getElementById(`res-val-${curr.toLowerCase()}`).textContent = total.toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2});
    document.getElementById(`res-net-${curr.toLowerCase()}`).textContent = net.toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2});
  };

  setVal('TL');
  setVal('USD');
  setVal('EUR');
  setVal('GBP');

  document.getElementById('results-panel').style.display = 'block';
}

// ==========================================
// DATABASE LOGIC (SUPABASE)
// ==========================================
async function saveRecordToDatabase() {
  if (!supabase) {
    showToast('Database not configured');
    return;
  }
  if (!currentResults) return;

  const btn = document.getElementById('btn-save-record');
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try {
    const { error } = await supabase
      .from('receipt_analyses')
      .insert([
        { 
          tl: currentResults.TL, 
          usd: currentResults.USD, 
          eur: currentResults.EUR, 
          gbp: currentResults.GBP,
          raw_data: currentResults
        }
      ]);

    if (error) throw error;
    
    showToast('Record saved successfully');
    resetScanUI();
    
    // Switch back to start of scan UI
    document.getElementById('results-panel').style.display = 'none';

  } catch(e) {
    console.error(e);
    showToast('Failed to save record.');
  } finally {
    btn.textContent = 'Save Record';
    btn.disabled = false;
  }
}

async function loadHistory() {
  if (!supabase) return;
  const container = document.getElementById('history-container');
  
  try {
    const { data, error } = await supabase
      .from('receipt_analyses')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
      
    if (error) throw error;

    if (data.length === 0) {
      container.innerHTML = '<div class="history-empty">No records found.</div>';
      return;
    }

    container.innerHTML = data.map(row => {
      const d = new Date(row.created_at);
      const dateStr = d.toLocaleDateString('en-GB') + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      
      const format = (v) => Number(v || 0).toLocaleString('tr-TR', {minimumFractionDigits:2, maximumFractionDigits:2});
      
      let statsHTML = '';
      if(row.tl > 0) statsHTML += `<div class="h-stat"><span>TL:</span> ${format(row.tl)} (Net: ${format(row.tl*0.96)})</div>`;
      if(row.usd > 0) statsHTML += `<div class="h-stat"><span>USD:</span> ${format(row.usd)} (Net: ${format(row.usd*0.96)})</div>`;
      if(row.eur > 0) statsHTML += `<div class="h-stat"><span>EUR:</span> ${format(row.eur)} (Net: ${format(row.eur*0.96)})</div>`;
      if(row.gbp > 0) statsHTML += `<div class="h-stat"><span>GBP:</span> ${format(row.gbp)} (Net: ${format(row.gbp*0.96)})</div>`;
      
      if(statsHTML === '') statsHTML = '<div class="h-stat">No amounts detected</div>';

      return `
        <div class="history-item">
          <div class="history-date">${dateStr}</div>
          <div class="history-stats">${statsHTML}</div>
        </div>
      `;
    }).join('');

  } catch(e) {
    console.error(e);
    container.innerHTML = '<div class="history-empty">Error loading records.</div>';
  }
}
