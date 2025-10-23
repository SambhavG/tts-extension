const api = chrome;

async function getActiveTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function sendCommandToActiveTab(command) {
  return getActiveTabId().then((tabId) => {
    if (!tabId) return { ok: false, error: "no_active_tab" };
    return new Promise((resolve) => {
      api.tabs.sendMessage(tabId, { type: "kokoro:executeCommand", command }, (response) => {
        if (api.runtime.lastError) {
          resolve({ ok: false, error: api.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  });
}

api.commands.onCommand.addListener(async (command) => {
  await sendCommandToActiveTab(command);
});
