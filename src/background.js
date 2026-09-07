"use strict";

// Cookies that Google's OAuth endpoints rely on. Used as a fallback when the
// browser does not expose the outgoing "Cookie" header to the extension
// (e.g. Firefox's Enhanced Tracking Protection strips it in cross-origin frames).
const FIRST_PARTY_AUTH_COOKIES = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID",
  "__Secure-1PSID", "__Secure-3PSID",
  "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS",
]);

const DOMAINS = {
  prod: "https://home.nest.com",
  ft: "https://home.ft.nest.com",
};

const OAUTH_FILTER = {
  urls: ["https://accounts.google.com/o/oauth2/iframerpc*"],
  types: ["xmlhttprequest", "sub_frame", "main_frame"],
};

const POLL_ALARM = "nest-session-poll";
const POLL_INTERVAL_MS = 2000;
// Stop listening (and polling) after this long so a forgotten extraction does
// not keep hitting home.nest.com in the background forever.
const LISTEN_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_STATE = {
  issueToken: null,
  cookies: null,
  accessToken: null,
  listening: false,
  env: "prod",
  startedAt: 0,
};

let state = { ...DEFAULT_STATE };
let pollTimer = null;

// Both Chrome's service worker and Firefox's event page are torn down when
// idle, so the capture state lives in session storage and is restored on every
// start of this script.
const ready = (async () => {
  try {
    const stored = await chrome.storage.session.get("state");
    if (stored && stored.state) state = { ...DEFAULT_STATE, ...stored.state };
  } catch (err) {
    // storage.session unavailable; fall back to in-memory state only.
  }
  if (state.listening) {
    if (isExpired()) {
      await stopListening();
    } else {
      startPolling();
    }
  }
})();

function isExpired() {
  return state.startedAt > 0 && Date.now() - state.startedAt > LISTEN_TIMEOUT_MS;
}

function targetDomain() {
  return DOMAINS[state.env] || DOMAINS.prod;
}

async function persist() {
  try {
    await chrome.storage.session.set({ state });
  } catch (err) {
    // Ignore: capture still works for the lifetime of this worker.
  }
}

async function startListening(env) {
  state = { ...DEFAULT_STATE, listening: true, env, startedAt: Date.now() };
  await persist();
  // The alarm both polls for the legacy session and revives the worker if the
  // browser shut it down mid-login.
  try {
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  } catch (err) {
    // Ignore: the interval below still covers the common case.
  }
  startPolling();
}

async function stopListening() {
  state.listening = false;
  stopPolling();
  await persist();
  try {
    await chrome.alarms.clear(POLL_ALARM);
  } catch (err) {
    // Ignore.
  }
}

function captureComplete() {
  return Boolean(state.accessToken || googleCaptureDone());
}

function startPolling() {
  if (captureComplete()) return; // Nothing left to poll for.
  stopPolling();
  pollTimer = setInterval(fetchSessionInfo, POLL_INTERVAL_MS);
  fetchSessionInfo();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function fetchSessionInfo() {
  if (!state.listening || captureComplete()) {
    stopPolling();
    return;
  }
  if (isExpired()) {
    await stopListening();
    return;
  }
  try {
    const response = await fetch(`${targetDomain()}/session`, {
      // The extension's own origin is not home.nest.com, so the session cookies
      // are only attached when credentials are explicitly included.
      credentials: "include",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) return;
    const data = await response.json();
    if (data && data.access_token && !state.accessToken) {
      state.accessToken = data.access_token;
      stopPolling();
      await persist();
      await markComplete();
    }
  } catch (err) {
    // Ignore errors (e.g., user is not logged in yet).
  }
}

// The Google pair is only overwritten until it is complete, so an unrelated
// sign-in elsewhere in the browser cannot clobber a finished extraction.
function googleCaptureDone() {
  return Boolean(state.issueToken && state.cookies);
}

async function captureIssueToken(details) {
  await ready;
  if (!state.listening || googleCaptureDone()) return;
  if (!details.url.includes("action=issueToken")) return;
  if (state.issueToken === details.url) return;
  state.issueToken = details.url;
  await persist();
  await markComplete();
}

async function captureRequestCookies(details) {
  await ready;
  if (!state.listening || googleCaptureDone()) return;
  if (!details.url.includes("action=issueToken")) return;

  const cookieMap = new Map();
  const cookieHeader = (details.requestHeaders || []).find(
    (h) => h.name.toLowerCase() === "cookie"
  );
  if (cookieHeader && cookieHeader.value) {
    for (const pair of cookieHeader.value.split(";")) {
      const entry = pair.trim();
      const eqIdx = entry.indexOf("=");
      if (eqIdx > 0) {
        cookieMap.set(entry.substring(0, eqIdx), entry.substring(eqIdx + 1));
      }
    }
  }

  try {
    const cookies = await chrome.cookies.getAll({ url: "https://accounts.google.com/" });
    for (const c of cookies || []) {
      if (FIRST_PARTY_AUTH_COOKIES.has(c.name) && !cookieMap.has(c.name)) {
        cookieMap.set(c.name, c.value);
      }
    }
  } catch (err) {
    // Ignore: whatever the request header gave us is still usable.
  }

  if (cookieMap.size === 0) return;

  state.cookies = Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  await persist();
  await markComplete();
}

async function markComplete() {
  if (!captureComplete()) return;
  // Everything needed is in hand, so stop hitting home.nest.com in the
  // background. The webRequest listeners stay armed and keep the values fresh
  // if the sign-in flow issues another token request.
  stopPolling();
  try {
    await chrome.alarms.clear(POLL_ALARM);
  } catch (err) {
    // Ignore.
  }
  await setBadge("✓", "#4CAF50");
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (err) {
    // Ignore: the badge is cosmetic.
  }
}

// Listeners are registered unconditionally at the top level: a listener added
// later from inside a message handler is lost as soon as the browser suspends
// this script, and would never be restored. Each handler is a no-op unless an
// extraction is currently running.
//
// "extraHeaders" is required by Chromium to see the Cookie request header but
// is rejected by Firefox, where passing it throws and aborts the whole capture.
const sendHeadersOptions = ["requestHeaders"];
if (chrome.webRequest.OnSendHeadersOptions && chrome.webRequest.OnSendHeadersOptions.EXTRA_HEADERS) {
  sendHeadersOptions.push(chrome.webRequest.OnSendHeadersOptions.EXTRA_HEADERS);
}

chrome.webRequest.onBeforeRequest.addListener(captureIssueToken, OAUTH_FILTER);
try {
  chrome.webRequest.onSendHeaders.addListener(captureRequestCookies, OAUTH_FILTER, sendHeadersOptions);
} catch (err) {
  // Retry without the Chromium-only option rather than losing cookie capture.
  chrome.webRequest.onSendHeaders.addListener(captureRequestCookies, OAUTH_FILTER, ["requestHeaders"]);
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== POLL_ALARM) return;
    await ready;
    if (!state.listening || isExpired()) {
      await stopListening();
      return;
    }
    if (captureComplete()) {
      await markComplete();
      return;
    }
    startPolling();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action;

  if (action === "startCapture") {
    (async () => {
      await ready;
      const env = message.env === "ft" ? "ft" : "prod";
      await startListening(env);
      await setBadge("...", "#FF9800");
      try {
        await chrome.tabs.create({ url: `${targetDomain()}/` });
      } catch (err) {
        // The capture is already armed even if the tab could not be opened.
      }
      sendResponse({ status: "started" });
    })();
    return true;
  }

  if (action === "getStatus") {
    (async () => {
      await ready;
      if (state.listening && isExpired()) await stopListening();
      sendResponse({
        issueToken: state.issueToken,
        cookies: state.cookies,
        accessToken: state.accessToken,
        listening: state.listening,
      });
    })();
    return true;
  }

  if (action === "reset") {
    (async () => {
      await ready;
      await stopListening();
      state = { ...DEFAULT_STATE };
      await persist();
      await setBadge("");
      sendResponse({ status: "reset" });
    })();
    return true;
  }

  return false;
});
