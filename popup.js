// --- State ---
let results = [];
let currentPage = 1;
const PAGE_SIZE = 20;
let timerInterval = null;
let currentView = 'search'; // 'search' or 'saved'

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    setupChipListeners();
    setupEventListeners();
});

// --- Settings ---
function loadSettings() {
    chrome.storage.local.get(['apiToken', 'actorId'], (data) => {
        if (data.apiToken) document.getElementById('api-token').value = data.apiToken;
        if (data.actorId) document.getElementById('actor-id').value = data.actorId;
    });
}

function saveSettings() {
    const token = document.getElementById('api-token').value.trim();
    const actorId = document.getElementById('actor-id').value.trim();
    chrome.storage.local.set({ apiToken: token, actorId: actorId }, () => {
        showToast('Settings saved!', 'success');
    });
}

// --- Event Listeners ---
function setupEventListeners() {
    document.getElementById('settings-toggle').addEventListener('click', () => {
        const panel = document.getElementById('settings-panel');
        const btn = document.getElementById('settings-toggle');
        panel.classList.toggle('open');
        btn.classList.toggle('active');
    });

    // Saved Data tab toggle
    document.getElementById('saved-data-toggle').addEventListener('click', () => {
        if (currentView === 'search') {
            switchToSavedView();
        } else {
            switchToSearchView();
        }
    });

    document.getElementById('save-settings').addEventListener('click', saveSettings);
    document.getElementById('run-btn').addEventListener('click', runLeadFinder);
    document.getElementById('fetch-by-website-btn').addEventListener('click', runByWebsite);
    document.getElementById('copy-emails-btn').addEventListener('click', copyEmails);
    document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
    document.getElementById('clear-saved-btn').addEventListener('click', clearSavedData);
}

function setupChipListeners() {
    document.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const checkbox = chip.querySelector('input[type="checkbox"]');
            checkbox.checked = !checkbox.checked;
            chip.classList.toggle('selected', checkbox.checked);
        });
    });
}

// --- View Switching ---
function switchToSavedView() {
    currentView = 'saved';
    document.getElementById('search-view').style.display = 'none';
    document.getElementById('saved-view').style.display = 'block';
    document.getElementById('saved-data-toggle').classList.add('active');
    document.getElementById('saved-data-toggle').querySelector('span').textContent = 'Search';
    document.getElementById('saved-data-toggle').querySelector('i').className = 'fas fa-search';
    loadSavedData();
}

function switchToSearchView() {
    currentView = 'search';
    document.getElementById('search-view').style.display = 'block';
    document.getElementById('saved-view').style.display = 'none';
    document.getElementById('saved-data-toggle').classList.remove('active');
    document.getElementById('saved-data-toggle').querySelector('span').textContent = 'Saved Data';
    document.getElementById('saved-data-toggle').querySelector('i').className = 'fas fa-database';
}

// --- Collect Filters ---
function getSelectedValues(containerId) {
    const container = document.getElementById(containerId);
    const selected = [];
    container.querySelectorAll('.chip.selected').forEach(chip => {
        selected.push(chip.dataset.value);
    });
    return selected;
}

// Parse company size chips into min/max employee count
function getEmployeeBounds() {
    const selected = getSelectedValues('filter-size');
    if (selected.length === 0) {
        return { min: 200, max: null };
    }

    let overallMin = Infinity;
    let overallMax = 0;

    selected.forEach(range => {
        if (range === '50000+') {
            overallMin = Math.min(overallMin, 50000);
            overallMax = null; // no upper bound
        } else {
            const parts = range.split('-').map(Number);
            overallMin = Math.min(overallMin, parts[0]);
            if (overallMax !== null) {
                overallMax = Math.max(overallMax, parts[1]);
            }
        }
    });

    return {
        min: Math.max(overallMin, 200),
        max: overallMax
    };
}

function buildRequestBody() {
    const body = {};

    // Location
    const location = document.getElementById('filter-location').value.trim();
    if (location) {
        body.contact_location = location.split(',').map(s => s.trim()).filter(Boolean);
    }

    // Functional Level
    const funcLevel = getSelectedValues('filter-functional-level');
    if (funcLevel.length) body.functional_level = funcLevel;

    // Seniority
    const seniority = getSelectedValues('filter-seniority');
    if (seniority.length) body.seniority_level = seniority;

    // Company employee count
    const bounds = getEmployeeBounds();
    if (bounds.min) body.company_employee_count_min = bounds.min;
    if (bounds.max) body.company_employee_count_max = bounds.max;

    // Fetch count
    const maxItems = parseInt(document.getElementById('max-items').value) || 100;
    body.fetch_count = maxItems;

    return body;
}

// --- Clean website domain ---
function cleanDomain(input) {
    let d = input.trim().toLowerCase();
    if (!d) return null;
    d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
    return d || null;
}

// --- Website Search ---
async function runByWebsite() {
    const websiteInput = document.getElementById('website-input').value.trim();
    if (!websiteInput) {
        showToast('Please enter at least one website or domain', 'error');
        return;
    }

    const websites = websiteInput
        .split(/[,\n]+/)
        .map(s => cleanDomain(s))
        .filter(Boolean);

    if (websites.length === 0) {
        showToast('No valid domains found. Enter domains like google.com', 'error');
        return;
    }

    const body = { website: websites };

    const funcLevel = getSelectedValues('filter-functional-level');
    if (funcLevel.length) body.functional_level = funcLevel;

    const seniority = getSelectedValues('filter-seniority');
    if (seniority.length) body.seniority_level = seniority;

    const bounds = getEmployeeBounds();
    if (bounds.min) body.company_employee_count_min = bounds.min;
    if (bounds.max) body.company_employee_count_max = bounds.max;

    const maxItems = parseInt(document.getElementById('max-items').value) || 100;
    body.fetch_count = maxItems;

    await callApifyAPI(body);
}

// --- API Call ---
async function runLeadFinder() {
    const body = buildRequestBody();
    await callApifyAPI(body);
}

// --- Normalize a single result item ---
function normalizeItem(item) {
    // Handle various possible response schemas
    const name = item.first_name && item.last_name
        ? `${item.first_name} ${item.last_name}`.trim()
        : item.name || item.full_name || item.Name
        || (item.firstName && item.lastName ? `${item.firstName} ${item.lastName}`.trim() : '')
        || '-';
    const email = item.email || item.Email || item.emailAddress || item.email_address || '';
    const title = item.title || item.Title || item.job_title || item.headline || item.position || '';
    const company = item.organization_name || item.company || item.Company || item.organization
        || item.company_name || item.companyName || '';
    const location = buildLocation(item);
    const linkedin = item.linkedin_url || item.linkedin || item.linkedinUrl
        || item.linkedin_profile_url || item.LinkedInUrl || '';
    const phone = item.phone || item.phone_number || item.Phone || '';

    return { name, email, title, company, location, linkedin, phone, _raw: item };
}

function buildLocation(item) {
    // Try structured fields first
    const parts = [
        item.city || '',
        item.state || '',
        item.country || ''
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');

    // Fallback to generic location fields
    if (item.contact_location) {
        return Array.isArray(item.contact_location) ? item.contact_location.join(', ') : item.contact_location;
    }
    return item.location || item.Location || '-';
}

// --- Shared API Call (with async fallback) ---
async function callApifyAPI(body) {
    const token = document.getElementById('api-token').value.trim();
    const actorId = document.getElementById('actor-id').value.trim();

    if (!token) {
        showToast('Please enter your Apify API token in Settings', 'error');
        document.getElementById('settings-panel').classList.add('open');
        document.getElementById('settings-toggle').classList.add('active');
        return;
    }

    if (!actorId) {
        showToast('Please enter the Actor ID in Settings', 'error');
        document.getElementById('settings-panel').classList.add('open');
        document.getElementById('settings-toggle').classList.add('active');
        return;
    }

    // Show loading
    showLoading(true);
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('stats-bar').style.display = 'none';
    document.getElementById('results-container').style.display = 'none';
    document.getElementById('run-btn').disabled = true;
    document.getElementById('fetch-by-website-btn').disabled = true;

    // Timer
    let elapsed = 0;
    const loadingTimer = document.getElementById('loading-timer');
    const loadingText = document.getElementById('loading-text');
    timerInterval = setInterval(() => {
        elapsed++;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        loadingTimer.textContent = `Elapsed: ${mins > 0 ? mins + 'm ' : ''}${secs}s`;
    }, 1000);

    try {
        // Normalize actor ID — replace ~ with / for the API URL
        const normalizedActorId = actorId.includes('/') ? actorId : actorId.replace('~', '/');

        console.log('[Lead Gen] Actor ID:', normalizedActorId);
        console.log('[Lead Gen] Request Body:', JSON.stringify(body, null, 2));

        // --- Method 1: Try sync endpoint first ---
        loadingText.textContent = 'Starting actor run...';
        let rawResults = null;

        try {
            rawResults = await trySyncCall(normalizedActorId, token, body);
        } catch (syncErr) {
            console.log('[Lead Gen] Sync call failed, falling back to async:', syncErr.message);
        }

        // --- Method 2: Async fallback (start run → poll → fetch dataset) ---
        if (!rawResults) {
            loadingText.textContent = 'Running actor (async mode)...';
            rawResults = await asyncCallWithPolling(normalizedActorId, token, body, loadingText);
        }

        currentPage = 1;

        console.log('[Lead Gen] Raw results count:', Array.isArray(rawResults) ? rawResults.length : 'not array');
        if (rawResults.length > 0) {
            console.log('[Lead Gen] Sample raw result keys:', Object.keys(rawResults[0]));
            console.log('[Lead Gen] Sample raw result:', JSON.stringify(rawResults[0], null, 2));
        }

        // Normalize
        results = rawResults.map(normalizeItem);

        console.log('[Lead Gen] Normalized results:', results.length);

        showLoading(false);
        renderStats();
        renderResults();

        // Auto-save to chrome.storage.local
        if (results.length > 0) {
            saveResultsToStorage(results);
        }

    } catch (err) {
        showLoading(false);
        console.error('[Lead Gen] Error:', err);
        let errorMsg = err.message;
        if (err.message.includes('Failed to fetch')) {
            errorMsg = 'Network error — check your API token and Actor ID. Make sure the extension has permission to access api.apify.com.';
        }
        showToast(errorMsg, 'error');
        document.getElementById('empty-state').style.display = 'flex';
    } finally {
        clearInterval(timerInterval);
        document.getElementById('run-btn').disabled = false;
        document.getElementById('fetch-by-website-btn').disabled = false;
    }
}

// --- Sync API call ---
async function trySyncCall(actorId, token, body) {
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&format=json&clean=true`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    console.log('[Lead Gen] Sync response status:', response.status);

    if (response.status === 408) {
        throw new Error('Sync timeout');
    }
    if (response.status === 401) {
        throw new Error('Invalid API token. Check your Apify token in Settings.');
    }
    if (!response.ok) {
        const errText = await response.text();
        console.log('[Lead Gen] Sync error response:', errText.substring(0, 500));
        throw new Error(`Sync API Error (${response.status}): ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) return [data];
    return data;
}

// --- Async API call with polling ---
async function asyncCallWithPolling(actorId, token, body, statusEl) {
    // Step 1: Start the run
    const startUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}`;

    const startResp = await fetch(startUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (startResp.status === 401) {
        throw new Error('Invalid API token. Check your Apify token in Settings.');
    }

    if (!startResp.ok) {
        const errText = await startResp.text();
        console.log('[Lead Gen] Start run error:', errText.substring(0, 500));
        throw new Error(`Failed to start actor (${startResp.status}): ${errText.substring(0, 200)}`);
    }

    const runData = await startResp.json();
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;

    if (!runId) {
        throw new Error('Failed to get run ID from Apify response.');
    }

    console.log('[Lead Gen] Run started:', runId, 'Dataset:', datasetId);
    statusEl.textContent = 'Actor is running... waiting for results';

    // Step 2: Poll for completion
    const pollUrl = `https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`;
    let status = 'RUNNING';
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes max

    while (status === 'RUNNING' || status === 'READY') {
        if (attempts >= maxAttempts) {
            throw new Error('Actor run timed out after 10 minutes. Try with fewer results.');
        }

        await new Promise(r => setTimeout(r, 5000)); // Poll every 5s
        attempts++;

        try {
            const pollResp = await fetch(pollUrl);
            if (pollResp.ok) {
                const pollData = await pollResp.json();
                status = pollData.data?.status;
                statusEl.textContent = `Actor status: ${status}...`;
                console.log('[Lead Gen] Poll #' + attempts + ':', status);
            }
        } catch (pollErr) {
            console.warn('[Lead Gen] Poll error:', pollErr.message);
        }
    }

    if (status !== 'SUCCEEDED') {
        throw new Error(`Actor run finished with status: ${status}. Check your filters and try again.`);
    }

    // Step 3: Fetch dataset items
    statusEl.textContent = 'Fetching results...';
    const dsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&format=json&clean=true`;

    const dsResp = await fetch(dsUrl);
    if (!dsResp.ok) {
        const errText = await dsResp.text();
        throw new Error(`Failed to fetch dataset (${dsResp.status}): ${errText.substring(0, 200)}`);
    }

    const items = await dsResp.json();
    if (!Array.isArray(items)) return [items];
    return items;
}

// --- Save Results to chrome.storage.local ---
function saveResultsToStorage(data) {
    chrome.storage.local.get(['savedLeads'], (stored) => {
        const allSaved = stored.savedLeads || [];

        const entry = {
            id: Date.now().toString(),
            date: new Date().toISOString(),
            count: data.length,
            filters: document.getElementById('filter-location').value.trim() || 'No filters',
            leads: data.map(d => ({
                name: d.name,
                email: d.email,
                title: d.title,
                company: d.company,
                location: d.location,
                linkedin: d.linkedin,
                phone: d.phone
            }))
        };

        allSaved.unshift(entry);

        // Keep only last 20 runs
        if (allSaved.length > 20) allSaved.length = 20;

        chrome.storage.local.set({ savedLeads: allSaved }, () => {
            console.log('[Lead Gen] Saved', data.length, 'leads to storage');
            showToast(`${data.length} leads saved to Saved Data!`, 'success');
        });
    });
}

// --- Load & Display Saved Data ---
function loadSavedData() {
    chrome.storage.local.get(['savedLeads'], (stored) => {
        const allSaved = stored.savedLeads || [];
        const container = document.getElementById('saved-list');

        if (allSaved.length === 0) {
            container.innerHTML = `
                <div class="saved-empty">
                    <i class="fas fa-database"></i>
                    <p>No saved data yet. Run a search to save leads here.</p>
                </div>`;
            return;
        }

        container.innerHTML = allSaved.map((entry, idx) => {
            const date = new Date(entry.date);
            const dateStr = date.toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric'
            });
            const timeStr = date.toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit'
            });

            const withEmail = entry.leads.filter(l => l.email && l.email !== '').length;

            return `
                <div class="saved-card">
                    <div class="saved-card-header">
                        <div class="saved-card-info">
                            <span class="saved-card-date"><i class="far fa-calendar"></i> ${dateStr} ${timeStr}</span>
                            <span class="saved-card-filter"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(entry.filters)}</span>
                        </div>
                        <div class="saved-card-stats">
                            <span class="saved-card-count">${entry.count} leads</span>
                            <span class="saved-card-emails">${withEmail} emails</span>
                        </div>
                    </div>
                    <div class="saved-card-actions">
                        <button class="btn btn-accent btn-sm" onclick="viewSavedEntry(${idx})">
                            <i class="fas fa-eye"></i> View
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="exportSavedEntry(${idx})">
                            <i class="fas fa-file-csv"></i> CSV
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="copySavedEmails(${idx})">
                            <i class="fas fa-copy"></i> Emails
                        </button>
                        <button class="btn btn-danger-sm" onclick="deleteSavedEntry(${idx})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    });
}

function viewSavedEntry(index) {
    chrome.storage.local.get(['savedLeads'], (stored) => {
        const allSaved = stored.savedLeads || [];
        if (index >= allSaved.length) return;

        const entry = allSaved[index];
        results = entry.leads.map(l => ({ ...l, _raw: l }));
        currentPage = 1;

        switchToSearchView();
        renderStats();
        renderResults();
        showToast(`Loaded ${entry.count} leads from ${new Date(entry.date).toLocaleDateString()}`, 'success');
    });
}

function exportSavedEntry(index) {
    chrome.storage.local.get(['savedLeads'], (stored) => {
        const allSaved = stored.savedLeads || [];
        if (index >= allSaved.length) return;

        const entry = allSaved[index];
        const csv = buildCSV(entry.leads);
        downloadCSV(csv, `leads_${entry.date.split('T')[0]}.csv`);
    });
}

function copySavedEmails(index) {
    chrome.storage.local.get(['savedLeads'], (stored) => {
        const allSaved = stored.savedLeads || [];
        if (index >= allSaved.length) return;

        const emails = allSaved[index].leads
            .map(l => l.email)
            .filter(e => e && e !== '');

        if (emails.length === 0) {
            showToast('No emails in this saved set', 'error');
            return;
        }
        navigator.clipboard.writeText(emails.join('\n')).then(() => {
            showToast(`${emails.length} emails copied!`, 'success');
        });
    });
}

function deleteSavedEntry(index) {
    chrome.storage.local.get(['savedLeads'], (stored) => {
        const allSaved = stored.savedLeads || [];
        allSaved.splice(index, 1);
        chrome.storage.local.set({ savedLeads: allSaved }, () => {
            loadSavedData();
            showToast('Entry deleted', 'success');
        });
    });
}

function clearSavedData() {
    if (!confirm('Delete all saved leads data?')) return;
    chrome.storage.local.set({ savedLeads: [] }, () => {
        loadSavedData();
        showToast('All saved data cleared', 'success');
    });
}

// --- Rendering ---
function renderStats() {
    const statsBar = document.getElementById('stats-bar');
    const withEmail = results.filter(r => r.email && r.email !== '').length;

    document.getElementById('stat-total').textContent = results.length;
    document.getElementById('stat-emails').textContent = withEmail;
    statsBar.style.display = 'flex';
}

function renderResults() {
    if (results.length === 0) {
        document.getElementById('results-container').style.display = 'none';
        document.getElementById('empty-state').style.display = 'flex';
        document.getElementById('empty-state').querySelector('p').innerHTML =
            '<strong>No results found.</strong> Try adjusting your filters.';
        return;
    }

    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('results-container').style.display = 'block';

    const tbody = document.getElementById('results-body');
    tbody.innerHTML = '';

    const totalPages = Math.ceil(results.length / PAGE_SIZE);
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, results.length);
    const pageData = results.slice(start, end);

    pageData.forEach((item, i) => {
        const row = document.createElement('tr');

        const linkedinCell = item.linkedin
            ? `<a href="${escapeHtml(item.linkedin)}" target="_blank" title="Open LinkedIn" class="linkedin-link"><i class="fab fa-linkedin"></i></a>`
            : '-';

        row.innerHTML = `
            <td style="color: var(--text-secondary)">${start + i + 1}</td>
            <td>${escapeHtml(item.name || '-')}</td>
            <td class="email-cell" title="Click to copy" onclick="copySingle('${escapeHtml(item.email || '-')}')">${escapeHtml(item.email || '-')}</td>
            <td>${escapeHtml(item.title || '-')}</td>
            <td>${escapeHtml(item.company || '-')}</td>
            <td style="color: var(--text-secondary)">${escapeHtml(item.location || '-')}</td>
            <td>${linkedinCell}</td>
        `;
        tbody.appendChild(row);
    });

    renderPagination(totalPages);
}

function renderPagination(totalPages) {
    const container = document.getElementById('pagination');
    container.innerHTML = '';

    if (totalPages <= 1) return;

    const prevBtn = document.createElement('button');
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.onclick = () => { currentPage--; renderResults(); };
    container.appendChild(prevBtn);

    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = `${currentPage} / ${totalPages}`;
    container.appendChild(info);

    const nextBtn = document.createElement('button');
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.onclick = () => { currentPage++; renderResults(); };
    container.appendChild(nextBtn);
}

// --- Actions ---
function copyEmails() {
    const emails = results
        .map(r => r.email)
        .filter(e => e && e !== '');

    if (emails.length === 0) {
        showToast('No emails to copy', 'error');
        return;
    }

    navigator.clipboard.writeText(emails.join('\n')).then(() => {
        showToast(`${emails.length} emails copied!`, 'success');
    });
}

function copySingle(email) {
    if (!email || email === '-') return;
    navigator.clipboard.writeText(email).then(() => {
        showToast('Email copied!', 'success');
    });
}

function buildCSV(data) {
    const headers = ['Name', 'Email', 'Title', 'Company', 'Location', 'LinkedIn', 'Phone'];
    let csv = headers.map(h => `"${h}"`).join(',') + '\n';

    data.forEach(item => {
        csv += [
            item.name, item.email, item.title, item.company,
            item.location, item.linkedin, item.phone
        ].map(val => `"${String(val || '').replace(/"/g, '""')}"`).join(',') + '\n';
    });

    return csv;
}

function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('CSV exported!', 'success');
}

function exportCSV() {
    if (results.length === 0) {
        showToast('No data to export', 'error');
        return;
    }

    const csv = buildCSV(results);
    downloadCSV(csv, `leads_${new Date().toISOString().split('T')[0]}.csv`);
}

// --- Helpers ---
function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
    if (show) {
        document.getElementById('loading-text').textContent = 'Finding leads... This may take a few minutes.';
        document.getElementById('loading-timer').textContent = 'Elapsed: 0s';
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(message, type = 'error') {
    const existing = document.querySelectorAll('.error-toast, .success-toast');
    existing.forEach(e => e.remove());

    const toast = document.createElement('div');
    toast.className = type === 'success' ? 'success-toast' : 'error-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}
