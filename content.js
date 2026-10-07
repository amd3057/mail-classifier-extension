// content.js
function normalizeText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

function collectMatchingText(selectors) {
  const collected = [];

  selectors.forEach((selector) => {
    const nodes = document.querySelectorAll(selector);
    nodes.forEach((node) => {
      const text = normalizeText(node.innerText || node.textContent || '');
      if (text && text.length > 20 && !collected.includes(text)) {
        collected.push(text);
      }
    });
  });

  return collected;
}

function getEmailContent() {
  const subjectCandidates = [
    'h2[role="heading"]',
    'h1',
    '.hP',
    '.aoD',
    '.bog',
    '[data-thread-title]',
    '[data-testid="message-title"]',
    '[role="heading"]'
  ];

  let subject = '';
  for (const selector of subjectCandidates) {
    const el = document.querySelector(selector);
    const text = normalizeText(el?.innerText || el?.textContent || '');
    if (text && text.length > 2) {
      subject = text;
      break;
    }
  }

  const bodyCandidates = [
    'div[role="article"]',
    '[data-message-id]',
    '[data-testid="message-body"]',
    '.ii.gt',
    '.a3s.aiL',
    '.gmail_quote',
    'div[dir="ltr"]',
    '.adn.ads',
    'body'
  ];

  const parts = collectMatchingText(bodyCandidates);
  const emailBody = parts.join('\n\n') || normalizeText(document.body?.innerText || '');
  const finalText = [subject, emailBody].filter(Boolean).join('\n\n').trim();

  return finalText.length > 10 ? finalText : '';
}

const inboxRowSelector = 'tr.zA';
const rowSubjects = new WeakMap();
const resultCache = new Map();
const inFlightBySubject = new Map();
const pendingRows = [];
let processingRows = false;
let scanTimer;

function getSubjectFromRow(row) {
  return normalizeText(row.querySelector('.bog')?.innerText || row.querySelector('.bog')?.textContent || '');
}

function getSenderFromRow(row) {
  const senderElement = row.querySelector('.yW [email]');
  const senderEmail = normalizeText(senderElement?.getAttribute('email') || '');
  const senderName = normalizeText(senderElement?.innerText || senderElement?.textContent || row.querySelector('.yW')?.innerText || '');
  if (senderEmail && !senderName.includes(senderEmail)) {
    return `${senderName} <${senderEmail}>`.trim();
  }
  return senderName || senderEmail;
}

function getClassificationKey(subject, sender) {
  return `${sender.toLowerCase()}\n${subject.toLowerCase()}`;
}

function isRowVisible(row) {
  const bounds = row.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
}

function getOrCreateBadge(row) {
  let badge = row.querySelector('.mail-classifier-badge');
  if (badge) return badge;

  const subjectElement = row.querySelector('.bog');
  if (!subjectElement) return null;

  badge = document.createElement('span');
  badge.className = 'mail-classifier-badge mail-classifier-pending';
  badge.textContent = 'Checking';
  badge.setAttribute('aria-label', 'Mail Classifier is checking this subject');
  subjectElement.insertAdjacentElement('afterend', badge);
  return badge;
}

function showRowResult(row, subject, sender, result) {
  if (!row.isConnected || getSubjectFromRow(row) !== subject || getSenderFromRow(row) !== sender) return;

  const badge = getOrCreateBadge(row);
  if (!badge) return;

  const confidence = Number(result.confidence_score ?? 0);
  const minimumConfidence = Number(result.minimum_confidence ?? 0.8);
  const isConfident = result.is_confident ?? confidence >= minimumConfidence;
  if (!isConfident) {
    const predictedLabel = result.category === 'high_priority' ? 'High Priority' : 'Low Priority';
    badge.className = 'mail-classifier-badge mail-classifier-review';
    badge.textContent = 'Review';
    badge.setAttribute('aria-label', 'Mail Classifier: Needs review');
    badge.title = `Model leaned ${predictedLabel}, but confidence was ${(confidence * 100).toFixed(1)}%; the minimum is ${(minimumConfidence * 100).toFixed(0)}%.`;
    return;
  }

  const isHighPriority = result.category === 'high_priority';
  badge.className = `mail-classifier-badge ${isHighPriority ? 'mail-classifier-high' : 'mail-classifier-low'}`;
  badge.textContent = isHighPriority ? 'High Priority' : 'Low Priority';
  badge.setAttribute('aria-label', `Mail Classifier: ${badge.textContent}`);
  badge.title = `Classified from sender and subject (${(confidence * 100).toFixed(1)}% confidence)`;
}

function addBadgeStyles() {
  if (document.getElementById('mail-classifier-styles')) return;

  const style = document.createElement('style');
  style.id = 'mail-classifier-styles';
  style.textContent = `
    .mail-classifier-badge {
      display: inline-block;
      margin-inline-start: 8px;
      padding: 2px 7px;
      border-radius: 10px;
      font: 600 11px/1.5 Arial, sans-serif;
      white-space: nowrap;
      vertical-align: middle;
    }
    .mail-classifier-pending { background: #eef2f7; color: #526171; }
    .mail-classifier-high { background: #fee2e2; color: #991b1b; }
    .mail-classifier-low { background: #dcfce7; color: #166534; }
    .mail-classifier-review { background: #fef3c7; color: #92400e; }
  `;
  document.documentElement.appendChild(style);
}

async function classifySubject(subject, sender) {
  const key = getClassificationKey(subject, sender);
  const existingRequest = inFlightBySubject.get(key);
  if (existingRequest) return existingRequest;

  const request = chrome.runtime.sendMessage({
    action: 'classify_email',
    emailContent: subject,
    sender,
    mode: 'subject'
  }).then((response) => {
    if (!response?.success) {
      throw new Error(response?.error || 'Unable to classify this subject.');
    }
    return response.result;
  }).finally(() => {
    inFlightBySubject.delete(key);
  });

  inFlightBySubject.set(key, request);
  return request;
}

async function processVisibleRows() {
  if (processingRows) return;
  processingRows = true;

  try {
    while (pendingRows.length) {
      const { row, subject, sender } = pendingRows.shift();
      if (!row.isConnected || getSubjectFromRow(row) !== subject || getSenderFromRow(row) !== sender) continue;

      try {
        const key = getClassificationKey(subject, sender);
        let result = resultCache.get(key);
        if (!result) {
          getOrCreateBadge(row);
          result = await classifySubject(subject, sender);
          resultCache.set(key, result);
        }
        showRowResult(row, subject, sender, result);
      } catch (error) {
        console.warn('[Mail Classifier] Could not classify inbox subject:', error);
        const badge = getOrCreateBadge(row);
        if (badge) {
          badge.className = 'mail-classifier-badge mail-classifier-pending';
          badge.textContent = 'Unavailable';
          badge.title = error.message;
        }
      }
    }
  } finally {
    processingRows = false;
  }
}

function scanVisibleRows() {
  addBadgeStyles();

  document.querySelectorAll(inboxRowSelector).forEach((row) => {
    const subject = getSubjectFromRow(row);
    const sender = getSenderFromRow(row);
    const previous = rowSubjects.get(row);
    if (!subject || !isRowVisible(row) || (previous?.subject === subject && previous?.sender === sender)) return;

    rowSubjects.set(row, { subject, sender });
    const key = getClassificationKey(subject, sender);
    const cachedResult = resultCache.get(key);
    if (cachedResult) {
      showRowResult(row, subject, sender, cachedResult);
      return;
    }

    pendingRows.push({ row, subject, sender });
  });

  processVisibleRows();
}

function scheduleVisibleRowScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanVisibleRows, 250);
}

function startAutomaticInboxClassification() {
  scheduleVisibleRowScan();
  new MutationObserver(scheduleVisibleRowScan).observe(document.body, {
    childList: true,
    subtree: true
  });
  window.addEventListener('scroll', scheduleVisibleRowScan, true);
  window.addEventListener('resize', scheduleVisibleRowScan);
}

async function triggerClassification() {
  const emailContent = getEmailContent();
  console.log("[Mail Classifier] Email content extracted length:", emailContent.length);

  if (!emailContent || emailContent.length < 10) {
    const msg = "Unable to read the email body from this Gmail page. Open a message and try again.";
    console.warn("[Mail Classifier]", msg);
    chrome.runtime.sendMessage({
      action: "display_result",
      result: {
        category: "error",
        confidence_score: 0,
        message: msg
      }
    });
    return;
  }

  console.log("[Mail Classifier] Attempting to send email content to background script for classification...");

  const response = await Promise.race([
    chrome.runtime.sendMessage({
      action: "classify_email",
      emailContent
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Classification request timed out after 20 seconds.')), 20000);
    })
  ]);

  if (response && response.success) {
    console.log("[Mail Classifier] Classification successful. Result received:", response.result);
    chrome.runtime.sendMessage({ action: "display_result", result: response.result });
  } else {
    console.error("[Mail Classifier] Classification failed:", response?.error || "unknown error");
    chrome.runtime.sendMessage({
      action: "display_result",
      result: {
        category: "error",
        confidence_score: 0,
        message: response?.error || "Unknown error while classifying the email."
      }
    });
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "ping") {
    console.log("[Mail Classifier] Ping received on Gmail page");
    sendResponse({ ok: true, url: location.href });
    return true;
  }

  if (request.action === "run_classifier") {
    console.log("[Mail Classifier] run_classifier received from popup");
    triggerClassification()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error("[Mail Classifier] run_classifier failed:", error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

window.triggerClassification = triggerClassification;
console.log("[Mail Classifier] Content script loaded on:", location.href);
startAutomaticInboxClassification();