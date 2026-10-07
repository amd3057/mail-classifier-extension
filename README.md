# Mail Classifier

A standalone Manifest V3 Chrome extension that classifies Gmail messages as High Priority, Low Priority, or Review. Inbox badges are visual overlays, not Gmail labels. Automatic inbox classification uses the sender and subject; the popup can classify an open message or pasted text.

## Requirements

- Google Chrome
- Ollama running locally at `http://127.0.0.1:11434`
- The `nimble` model and the `/v1/systemone` endpoint

## Install in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this `mail-classifier-extension` directory.
3. Copy the extension ID shown on its extension card.
4. Allow that ID in Ollama and restart its service:

   ```sh
   launchctl setenv OLLAMA_ORIGINS 'chrome-extension://YOUR_EXTENSION_ID'
   launchctl kickstart -k "gui/$(id -u)/com.ollama.ollama"
   ```

   Replace `YOUR_EXTENSION_ID` with the ID from step 3. If `OLLAMA_ORIGINS` already contains other allowed origins, keep them and append this extension origin to the comma-separated value.
5. Refresh Gmail. The extension scans visible inbox rows and adds priority badges based on sender and subject.

After editing the extension, use **Reload** on its card in `chrome://extensions`, then refresh Gmail.

## Privacy

Automatic inbox classification sends the visible email's sender and subject to the local Ollama service. Clicking **Classify Email** on an open message sends extracted message text to that same local service. No hosted classification API is configured.