// --- State ---
let results = [];
let currentPage = 1;
const PAGE_SIZE = 20;
let timerInterval = null;

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

    document.getElementById('save-settings').addEventListener('click', saveSettings);
    document.getElementById('run-btn').addEventListener('click', runLeadFinder);
    document.getElementById('fetch-by-website-btn').addEventListener('click', runByWebsite);
    document.getElementById('copy-emails-btn').addEventListener('click', copyEmails);
    document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
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

// --- Collect Filters ---
function getSelectedValues(containerId) {
    const container = document.getElementById(containerId);
    const selected = [];
    container.querySelectorAll('.chip.selected').forEach(chip => {
        selected.push(chip.dataset.value);
    });
    return selected;
}

function buildRequestBody() {
    const body = {};

    // Location
    const location = document.getElementById('filter-location').value.trim();
    if (location) {
        body.contact_location = location.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }

    // Email Status
    const emailStatus = getSelectedValues('filter-email-status');
    if (emailStatus.length) body.email_status = emailStatus;

    // Functional Level
    const funcLevel = getSelectedValues('filter-functional-level');
    if (funcLevel.length) body.functional_level = funcLevel;

    // Seniority
    const seniority = getSelectedValues('filter-seniority');
    if (seniority.length) body.seniority_level = seniority;

    // Funding
    const funding = getSelectedValues('filter-funding');
    if (funding.length) body.funding = funding;

    // Size
    const size = getSelectedValues('filter-size');
    if (size.length) body.size = size;

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

    // Also include any selected filters
    const emailStatus = getSelectedValues('filter-email-status');
    if (emailStatus.length) body.email_status = emailStatus;

    const funcLevel = getSelectedValues('filter-functional-level');
    if (funcLevel.length) body.functional_level = funcLevel;

    const seniority = getSelectedValues('filter-seniority');
    if (seniority.length) body.seniority_level = seniority;

    await callApifyAPI(body);
}

// --- API Call ---
async function runLeadFinder() {
    const body = buildRequestBody();
    await callApifyAPI(body);
}

// --- Shared API Call ---
async function callApifyAPI(body) {
    const token = document.getElementById('api-token').value.trim();
    const actorId = document.getElementById('actor-id').value.trim();
    const maxItems = parseInt(document.getElementById('max-items').value) || 100;

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

    // Show loading, hide others
    showLoading(true);
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('stats-bar').style.display = 'none';
    document.getElementById('results-container').style.display = 'none';
    document.getElementById('run-btn').disabled = true;

    // Timer
    let elapsed = 0;
    timerInterval = setInterval(() => {
        elapsed++;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        document.getElementById('loading-timer').textContent =
            `Elapsed: ${mins > 0 ? mins + 'm ' : ''}${secs}s`;
    }, 1000);

    try {
        const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&maxItems=${maxItems}&format=json&clean=true`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (response.status === 408) {
            throw new Error('Request timed out (>300s). Try with fewer filters or smaller max results.');
        }

        if (response.status === 401) {
            throw new Error('Invalid API token. Check your Apify token in Settings.');
        }

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`API Error (${response.status}): ${err.substring(0, 150)}`);
        }

        results = await response.json();
        currentPage = 1;

        if (!Array.isArray(results)) {
            results = [results];
        }

        showLoading(false);
        renderStats();
        renderResults();

    } catch (err) {
        showLoading(false);
        showToast(err.message, 'error');
        document.getElementById('empty-state').style.display = 'flex';
    } finally {
        clearInterval(timerInterval);
        document.getElementById('run-btn').disabled = false;
    }
}

// --- Rendering ---
function renderStats() {
    const statsBar = document.getElementById('stats-bar');
    const withEmail = results.filter(r => r.email || r.Email || r.emailAddress).length;

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
        const name = item.name || item.full_name || item.firstName && item.lastName
            ? `${item.firstName || ''} ${item.lastName || ''}`.trim()
            : item.Name || '-';
        const email = item.email || item.Email || item.emailAddress || item.email_address || '-';
        const title = item.title || item.Title || item.job_title || item.headline || '-';
        const company = item.company || item.Company || item.organization || item.company_name || '-';
        const location = item.location || item.Location || item.city || item.contact_location || '-';

        row.innerHTML = `
            <td style="color: var(--text-secondary)">${start + i + 1}</td>
            <td>${escapeHtml(typeof name === 'string' ? name : '-')}</td>
            <td class="email-cell" title="Click to copy" onclick="copySingle('${escapeHtml(typeof email === 'string' ? email : '-')}')">${escapeHtml(typeof email === 'string' ? email : '-')}</td>
            <td>${escapeHtml(typeof title === 'string' ? title : '-')}</td>
            <td>${escapeHtml(typeof company === 'string' ? company : '-')}</td>
            <td style="color: var(--text-secondary)">${escapeHtml(typeof location === 'string' ? location : '-')}</td>
        `;
        tbody.appendChild(row);
    });

    renderPagination(totalPages);
}

function renderPagination(totalPages) {
    const container = document.getElementById('pagination');
    container.innerHTML = '';

    if (totalPages <= 1) return;

    // Prev
    const prevBtn = document.createElement('button');
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.onclick = () => { currentPage--; renderResults(); };
    container.appendChild(prevBtn);

    // Page info
    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = `${currentPage} / ${totalPages}`;
    container.appendChild(info);

    // Next
    const nextBtn = document.createElement('button');
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.onclick = () => { currentPage++; renderResults(); };
    container.appendChild(nextBtn);
}

// --- Actions ---
function copyEmails() {
    const emails = results
        .map(r => r.email || r.Email || r.emailAddress || r.email_address)
        .filter(Boolean);

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

function exportCSV() {
    if (results.length === 0) {
        showToast('No data to export', 'error');
        return;
    }

    // Determine columns from first item
    const allKeys = new Set();
    results.forEach(item => {
        Object.keys(item).forEach(k => allKeys.add(k));
    });
    const keys = Array.from(allKeys);

    let csv = keys.map(k => `"${k}"`).join(',') + '\n';
    results.forEach(item => {
        csv += keys.map(k => {
            let val = item[k];
            if (val === undefined || val === null) val = '';
            if (typeof val === 'object') val = JSON.stringify(val);
            return `"${String(val).replace(/"/g, '""')}"`;
        }).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('CSV exported!', 'success');
}

// --- Helpers ---
function showLoading(show) {
    document.getElementById('loading').style.display = show ? 'flex' : 'none';
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
    setTimeout(() => toast.remove(), 3000);
}
