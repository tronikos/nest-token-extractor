"use strict";

// Firefox exposes promise-based APIs on "browser" and callback-based ones on
// "chrome"; Chrome MV3 only has "chrome" (promise-based). Safari has both.
// Preferring "browser" means every await below resolves to a real value on all
// three browsers instead of silently awaiting undefined.
const api = typeof browser !== "undefined" && browser.runtime ? browser : chrome;

// Cookies that Google's OAuth endpoints rely on. Used as a fallback when the
// browser does not expose the outgoing "Cookie" header to the extension
// (e.g. Firefox's Enhanced Tracking Protection strips it in cross-origin
// frames, and Safari never reveals the Cookie header to webRequest at all).
const FIRST_PARTY_AUTH_COOKIES = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID",
  "__Secure-1PSID", "__Secure-3PSID",
  "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS",
]);

// Every one of these is HttpOnly. Requiring at least one proves the capture got
// real cookie access rather than only the subset that JavaScript can see: Safari
// never hands HttpOnly cookies to extensions, so there it yields cookies like
// SID and SAPISID but none of these, which authenticates nothing. A harvest
// without one of them is treated as partial and retried rather than reported as
// a finished extraction.
const ESSENTIAL_AUTH_COOKIES = ["HSID", "SSID", "__Secure-1PSID", "__Secure-3PSID"];

// Browsers disagree about whether a cookie is matched by the URL it would be
// sent to or by its own domain, so both shapes are tried.
const COOKIE_QUERIES = [
  { url: "https://accounts.google.com/" },
  { domain: "google.com" },
];

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
  // False while "cookies" holds a partial harvest that is still being retried.
  cookiesComplete: false,
  // True once "cookies" came from the request header, which outranks any
  // later read of the cookie jar.
  cookiesFromHeader: false,
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
    const stored = await api.storage.session.get("state");
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
    await api.storage.session.set({ state });
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
    await api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
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
    await api.alarms.clear(POLL_ALARM);
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
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
  pollTick();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollTick() {
  if (!state.listening || captureComplete()) {
    stopPolling();
    return;
  }
  if (isExpired()) {
    await stopListening();
    return;
  }
  // Once the OAuth request has been seen the account is signed in, so the
  // cookie jar is worth re-reading: on browsers that hide the Cookie header
  // this retry is what eventually completes the capture.
  if (state.issueToken) await captureJarCookies();
  await fetchSessionInfo();
}

async function fetchSessionInfo() {
  if (!state.listening || captureComplete()) return;
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
  return Boolean(state.issueToken && state.cookies && state.cookiesComplete);
}

async function captureIssueToken(details) {
  await ready;
  if (!state.listening || googleCaptureDone()) return;
  if (!details.url.includes("action=issueToken")) return;
  if (state.issueToken !== details.url) {
    state.issueToken = details.url;
    await persist();
  }
  // onSendHeaders is the better cookie source but it does not fire everywhere
  // (Safari never hands the Cookie header to webRequest), so read the jar here
  // too rather than leaving the capture stuck on "waiting for cookies".
  await captureJarCookies();
  await markComplete();
}

// Reads the Google auth cookies straight out of the cookie jar. Several query
// shapes are tried because browsers disagree about whether a cookie is matched
// by the URL it is sent to or by its own domain.
async function readAuthCookiesFromJar() {
  const found = new Map();
  for (const query of COOKIE_QUERIES) {
    let cookies;
    try {
      cookies = await api.cookies.getAll(query);
    } catch (err) {
      continue; // Query shape unsupported or not permitted; try the next.
    }
    for (const c of cookies || []) {
      if (FIRST_PARTY_AUTH_COOKIES.has(c.name) && !found.has(c.name)) {
        found.set(c.name, c.value);
      }
    }
  }
  return found;
}

async function captureJarCookies() {
  if (!state.listening || googleCaptureDone()) return;
  const cookieMap = await readAuthCookiesFromJar();
  // The jar can only ever produce the known auth cookies, so it is authoritative
  // only when the session-defining ones are present.
  await storeCookies(cookieMap, hasEssentialCookies(cookieMap), false);
  await markComplete();
}

async function captureRequestCookies(details) {
  await ready;
  // Unlike the other handlers this one still runs after the capture completes,
  // as long as the completed value came from the jar: the header carries the
  // full cookie set Google received and is worth upgrading to.
  if (!state.listening || (googleCaptureDone() && state.cookiesFromHeader)) return;
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
  // The header is the exact set Google itself received, so it completes the
  // capture on its own; the jar only fills gaps it left behind.
  const fromHeader = cookieMap.size > 0;
  for (const [name, value] of await readAuthCookiesFromJar()) {
    if (!cookieMap.has(name)) cookieMap.set(name, value);
  }

  await storeCookies(cookieMap, fromHeader || hasEssentialCookies(cookieMap), fromHeader);
  await markComplete();
}

function hasEssentialCookies(cookieMap) {
  return ESSENTIAL_AUTH_COOKIES.some((name) => cookieMap.has(name));
}

// A partial harvest is still shown in the popup, but it never blocks a later
// complete one from replacing it.
async function storeCookies(cookieMap, complete, fromHeader) {
  if (cookieMap.size === 0) return;
  if (state.cookies && state.cookiesFromHeader && !fromHeader) return;
  if (state.cookies && state.cookiesComplete && !complete) return;
  state.cookies = Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  state.cookiesComplete = complete;
  state.cookiesFromHeader = Boolean(fromHeader);
  await persist();
}

async function markComplete() {
  if (!captureComplete()) return;
  // Everything needed is in hand, so stop hitting home.nest.com in the
  // background. The webRequest listeners stay armed and keep the values fresh
  // if the sign-in flow issues another token request.
  stopPolling();
  try {
    await api.alarms.clear(POLL_ALARM);
  } catch (err) {
    // Ignore.
  }
  await setBadge("✓", "#4CAF50");
}

async function setBadge(text, color) {
  try {
    await api.action.setBadgeText({ text });
    if (color) await api.action.setBadgeBackgroundColor({ color });
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
if (api.webRequest.OnSendHeadersOptions && api.webRequest.OnSendHeadersOptions.EXTRA_HEADERS) {
  sendHeadersOptions.push(api.webRequest.OnSendHeadersOptions.EXTRA_HEADERS);
}

api.webRequest.onBeforeRequest.addListener(captureIssueToken, OAUTH_FILTER);
try {
  api.webRequest.onSendHeaders.addListener(captureRequestCookies, OAUTH_FILTER, sendHeadersOptions);
} catch (err) {
  try {
    // Retry without the Chromium-only option rather than losing cookie capture.
    api.webRequest.onSendHeaders.addListener(captureRequestCookies, OAUTH_FILTER, ["requestHeaders"]);
  } catch (err2) {
    // No header access at all; captureIssueToken's jar read still covers it.
  }
}

if (api.alarms) {
  api.alarms.onAlarm.addListener(async (alarm) => {
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

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action;

  if (action === "startCapture") {
    (async () => {
      await ready;
      const env = message.env === "ft" ? "ft" : "prod";
      await startListening(env);
      await setBadge("...", "#FF9800");
      try {
        await api.tabs.create({ url: `${targetDomain()}/` });
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
        // The popup needs this to tell a finished capture apart from a partial
        // one that is missing the session-defining cookies.
        cookiesComplete: state.cookiesComplete,
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
