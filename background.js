// background.js
const OLLAMA_API_URL = "http://127.0.0.1:11434/v1/systemone";
const MINIMUM_CLASSIFICATION_CONFIDENCE = 0.6;

/**
 * Sends the email content to the local Ollama server for categorization.
 * @param {string} emailContent The raw text content of the email.
 * @returns {Promise<Object>} The parsed JSON response from the model.
 */
async function categorizeEmail(emailContent, mode = "email", sender = "") {
  const subjectOnly = mode === "subject";
  const payload = {
    model: "nimble",
    state: subjectOnly
      ? `Sender: ${sender || "Unknown"}\nSubject: ${emailContent}`
      : emailContent,
    questions: {
      triage: {
        type: "choice",
        instructions: subjectOnly
          ? "Use the sender and subject to classify priority. Reddit and other social media notifications, digests, posts, and engagement alerts are Low Priority by default, even when their subject discusses alarming news. Only classify a social-media email as High Priority when it is a direct account-security warning or requires urgent action from the recipient. Choose exactly one of: high_priority or low_priority."
          : "Decide whether this email requires prompt action. Reddit and other social media notifications, digests, posts, and engagement alerts are Low Priority by default. Choose exactly one of: high_priority or low_priority.",
        criteria: {
          high_priority: "A direct message requiring prompt action, a time-sensitive deadline, or a direct account-security warning. General news, newsletters, and social-media digests do not qualify.",
          low_priority: "Reddit and other social-media notifications, digests, posts, and engagement alerts; general news and newsletters; and messages that do not require action."
        }
      }
    }
  };

  console.log("[Mail Classifier] Sending payload to Ollama:", payload);

  let response;
  try {
    response = await fetch(OLLAMA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    console.log("[Mail Classifier] Ollama HTTP status:", response.status);
  } catch (error) {
    console.error("[Mail Classifier] Fetch error while calling Ollama:", error);
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 403) {
      const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
      throw new Error(
        `Ollama blocked this extension origin (403). Allow ${extensionOrigin} by running ` +
        `launchctl setenv OLLAMA_ORIGINS '${extensionOrigin}', then fully quit and reopen Ollama.`
      );
    }

    const errMsg = `Ollama API call failed with status ${response.status}: ${text}`;
    console.error("[Mail Classifier]", errMsg);
    throw new Error(errMsg);
  }

  const data = await response.json();
  console.log("[Mail Classifier] Ollama response:", data);

  const answer = data?.answers?.triage ?? {};
  const choice = answer.choice ?? "low_priority";
  const confidence = Number(answer.confidence ?? 0);
  const confidenceScore = Number.isFinite(confidence) ? confidence : 0;

  return {
    category: choice,
    confidence_score: confidenceScore,
    is_confident: confidenceScore >= MINIMUM_CLASSIFICATION_CONFIDENCE,
    minimum_confidence: MINIMUM_CLASSIFICATION_CONFIDENCE,
    raw: data
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "classify_email") {
    console.log("Received request to classify email from content script.");

    categorizeEmail(request.emailContent, request.mode, request.sender)
      .then((result) => {
        sendResponse({ success: true, result });
      })
      .catch((error) => {
        console.error("Classification failed:", error);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }
});