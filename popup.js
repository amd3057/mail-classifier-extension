// popup.js
const triggerButton = document.getElementById('triggerButton');
const statusDiv = document.getElementById('status');
const manualEmailText = document.getElementById('manualEmailText');

function isLikelyGmailUrl(url) {
  if (!url) return false;
  return url.startsWith('https://mail.google.com/') || url.startsWith('https://accounts.google.com/') || url.startsWith('https://gmail.google.com/');
}

function normalizeText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

function extractGmailTextFromPage() {
  const subjectCandidates = [
    'h2[role="heading"]',
    'h1',
    '.hP',
    '.aoD',
    '.bog',
    '[data-thread-title]',
    '[data-testid="message-title"]',
    '[role="heading"]',
    'title'
  ];

  const bodyCandidates = [
    '.a3s.aiL',
    '.ii.gt',
    '.gs',
    'div[role="listitem"]',
    'div[role="main"]',
    '.nH',
    'body'
  ];

  let subject = '';
  for (const selector of subjectCandidates) {
    const el = selector === 'title' ? document.title : document.querySelector(selector);
    const text = normalizeText(el?.innerText || el?.textContent || el || '');
    if (text && text.length > 2 && !/^Gmail$/i.test(text)) {
      subject = text;
      break;
    }
  }

  let bodyText = '';
  for (const selector of bodyCandidates) {
    const node = document.querySelector(selector);
    const text = normalizeText(node?.innerText || node?.textContent || '');
    if (text && text.length > 80) {
      bodyText = text;
      break;
    }
  }

  if (!bodyText) {
    bodyText = normalizeText(document.body?.innerText || document.documentElement?.innerText || '');
  }

  const safeBody = bodyText
    .replace(new RegExp(`\\b(${['Inbox','Sent','Drafts','Starred','Snoozed','More','Google','Mail','Compose','Search mail','Get the Gmail app','Respond','Reply','Forward','Archive','Delete','Mark as read','Move to','Show original','Print'].join('|')})\\b`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const finalText = [subject, safeBody].filter(Boolean).join('\n\n').trim();
  return finalText.length > 60 ? finalText : '';
}

async function classifyEmailContent(emailContent) {
  const trimmed = normalizeText(emailContent);
  if (!trimmed || trimmed.length < 20) {
    throw new Error('Email content is too short to classify.');
  }

  const response = await chrome.runtime.sendMessage({
    action: 'classify_email',
    emailContent: trimmed
  });

  if (!response || !response.success) {
    throw new Error(response?.error || 'Unable to classify the email.');
  }

  return response.result;
}

function updateStatus(message, className = '') {
  statusDiv.textContent = message;
  statusDiv.className = className;
}

function displayResult(result) {
  const conf = Number(result.confidence_score ?? 0) * 100;
  const minimumConfidence = Number(result.minimum_confidence ?? 0.8);
  const isConfident = result.is_confident ?? conf / 100 >= minimumConfidence;
  let message = `Result: ${result.category} (${conf.toFixed(1)}%)`;
  let className = 'result-error';

  if ((result.category === 'high_priority' || result.category === 'low_priority') && !isConfident) {
    const predictedLabel = result.category === 'high_priority' ? 'High Priority' : 'Low Priority';
    message = `NEEDS REVIEW: Model leaned ${predictedLabel} (${conf.toFixed(1)}% confidence; ${(minimumConfidence * 100).toFixed(0)}% required).`;
  } else if (result.category === 'high_priority') {
    message = `🚨 HIGH PRIORITY: This email needs attention (${conf.toFixed(1)}% confidence).`;
    className = 'result-action-required';
  } else if (result.category === 'low_priority') {
    message = `✅ LOW PRIORITY: This email looks safe to read later (${conf.toFixed(1)}% confidence).`;
    className = 'result-no-action-required';
  } else if (result.message) {
    message = result.message;
  }

  updateStatus(message, className);
  triggerButton.disabled = false;
}

async function initiateClassification() {
  updateStatus("Retrieving Gmail content and classifying... please wait.", "");
  triggerButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      updateStatus("Error: Could not find an active tab.", "result-error");
      triggerButton.disabled = false;
      return;
    }

    const url = tab.url || '';
    if (!isLikelyGmailUrl(url)) {
      const manualValue = normalizeText(manualEmailText.value);
      if (!manualValue) {
        updateStatus("Open Gmail and select a message thread, or paste the email text into the box below.", "result-error");
        triggerButton.disabled = false;
        return;
      }

      const result = await classifyEmailContent(manualValue);
      displayResult(result);
      return;
    }

    let emailContent = '';
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractGmailTextFromPage
      });

      emailContent = (results && results[0] && results[0].result) || '';
    } catch (pageError) {
      console.warn('[Mail Classifier] Gmail page extraction failed:', pageError);
      emailContent = '';
    }

    if (!emailContent || emailContent.length < 60) {
      const manualValue = normalizeText(manualEmailText.value);
      if (manualValue) {
        const result = await classifyEmailContent(manualValue);
        displayResult(result);
        return;
      }

      updateStatus("Open a specific Gmail message and try again, or paste the email text into the box below.", "result-error");
      triggerButton.disabled = false;
      return;
    }

    console.log("[Mail Classifier] Extracted email content length:", emailContent.length);

    const result = await classifyEmailContent(emailContent);
    console.log("[Mail Classifier] Result received:", result);
    displayResult(result);
  } catch (error) {
    console.error("[Mail Classifier] Error initiating classification:", error);
    updateStatus(error.message || "Failed to read the Gmail page. Open a message and retry.", "result-error");
    triggerButton.disabled = false;
  }
}

triggerButton.addEventListener('click', initiateClassification);
