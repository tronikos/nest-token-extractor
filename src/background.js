const FIRST_PARTY_AUTH_COOKIES = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID",
  "__Secure-1PSID", "__Secure-3PSID",
  "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS",
]);

let capturedData = {
  issueToken: null,
  cookies: null,
  accessToken: null,
  listening: false,
};

let fetchInterval = null;
let targetDomain = "https://home.nest.com";

function startListening() {
  capturedData = { issueToken: null, cookies: null, accessToken: null, listening: true };

  // Listeners for Google Account Authentication
  if (!chrome.webRequest.onBeforeRequest.hasListener(captureIssueToken)) {
    chrome.webRequest.onBeforeRequest.addListener(captureIssueToken, {
      urls:["https://accounts.google.com/o/oauth2/iframerpc*"],
      types: ["xmlhttprequest", "sub_frame", "main_frame"],
    });
  }

  if (!chrome.webRequest.onSendHeaders.hasListener(captureRequestCookies)) {
    chrome.webRequest.onSendHeaders.addListener(
      captureRequestCookies,
      {
        urls: ["https://accounts.google.com/o/oauth2/iframerpc*"],
        types: ["xmlhttprequest", "sub_frame", "main_frame"],
      },["requestHeaders"]
    );
  }

  // Poll for Legacy Nest Account Access Token
  if (fetchInterval) clearInterval(fetchInterval);
  fetchInterval = setInterval(fetchSessionInfo, 2000);
}

function stopListening() {
  capturedData.listening = false;
  if (chrome.webRequest.onBeforeRequest.hasListener(captureIssueToken)) {
    chrome.webRequest.onBeforeRequest.removeListener(captureIssueToken);
  }
  if (chrome.webRequest.onSendHeaders.hasListener(captureRequestCookies)) {
    chrome.webRequest.onSendHeaders.removeListener(captureRequestCookies);
  }
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
}

async function fetchSessionInfo() {
  try {
    const response = await fetch(`${targetDomain}/session`, {
      headers: { "Cache-Control": "no-cache" }
    });
    if (response.ok) {
      const data = await response.json();
      if (data.access_token && !capturedData.accessToken) {
        capturedData.accessToken = data.access_token;
        checkComplete();
      }
    }
  } catch (err) {
    // Ignore errors (e.g., user is not logged in yet)
  }
}

function captureIssueToken(details) {
  if (details.url.includes("action=issueToken")) {
    capturedData.issueToken = details.url;
    checkComplete();
  }
}

function captureRequestCookies(details) {
  if (!details.url.includes("action=issueToken")) return;

  const cookieMap = new Map();
  const cookieHeader = details.requestHeaders.find(
    (h) => h.name.toLowerCase() === "cookie"
  );
  if (cookieHeader) {
    cookieHeader.value.split("; ").forEach((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        cookieMap.set(pair.substring(0, eqIdx), pair.substring(eqIdx + 1));
      }
    });
  }

  chrome.cookies.getAll({ url: "https://accounts.google.com" }, (cookies) => {
    if (cookies) {
      for (const c of cookies) {
        if (FIRST_PARTY_AUTH_COOKIES.has(c.name) && !cookieMap.has(c.name)) {
          cookieMap.set(c.name, c.value);
        }
      }
    }

    if (cookieMap.size > 0) {
      capturedData.cookies = Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      checkComplete();
    }
  });
}

function checkComplete() {
  const hasGoogle = capturedData.issueToken && capturedData.cookies;
  const hasLegacy = capturedData.accessToken;
  
  if (hasGoogle || hasLegacy) {
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startCapture") {
    const env = message.env || "prod";
    targetDomain = env === "ft" ? "https://home.ft.nest.com" : "https://home.nest.com";
    
    startListening();
    chrome.action.setBadgeText({ text: "..." });
    chrome.action.setBadgeBackgroundColor({ color: "#FF9800" });

    chrome.tabs.create({ url: targetDomain + "/" }, () => {
      sendResponse({ status: "started" });
    });
    return true;
  }

  if (message.action === "getStatus") {
    sendResponse(capturedData);
    return false;
  }

  if (message.action === "reset") {
    stopListening();
    capturedData = { issueToken: null, cookies: null, accessToken: null, listening: false };
    chrome.action.setBadgeText({ text: "" });
    sendResponse({ status: "reset" });
    return false;
  }
});
