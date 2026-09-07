"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const extractBtn = document.getElementById("extract_btn");
  const envSelect = document.getElementById("env_select");
  const statusArea = document.getElementById("status_area");
  const closeWarning = document.getElementById("close_warning");

  const chromeWarning = document.getElementById("chrome_warning");
  const firefoxWarning = document.getElementById("firefox_warning");

  const googleSection = document.getElementById("google_section");
  const issueTokenField = document.getElementById("issue_token");
  const cookiesField = document.getElementById("cookies");

  const legacySection = document.getElementById("legacy_section");
  const accessTokenField = document.getElementById("access_token");

  let pollInterval = null;

  // Browser detection for warnings. Chromium browsers also claim "safari" in
  // their user agent, so they have to be ruled out first.
  const userAgent = navigator.userAgent.toLowerCase();
  const isChromium = /chrome|chromium|edg\//.test(userAgent);
  if (userAgent.includes("firefox")) {
    firefoxWarning.style.display = "block";
  } else if (isChromium) {
    chromeWarning.style.display = "block";
  }

  function setStatus(msg, type) {
    statusArea.textContent = "";
    if (!msg) return;
    const div = document.createElement("div");
    div.className = `status ${type}`;
    div.textContent = msg;
    statusArea.appendChild(div);
  }

  function sendMessage(message, callback) {
    chrome.runtime.sendMessage(message, (response) => {
      // Reading lastError suppresses the "Unchecked runtime.lastError" noise
      // that appears when the background script is still starting up.
      if (chrome.runtime.lastError) {
        if (callback) callback(null);
        return;
      }
      if (callback) callback(response);
    });
  }

  function startPolling() {
    stopPolling();
    pollInterval = setInterval(() => {
      sendMessage({ action: "getStatus" }, (r) => {
        if (r) updateUI(r);
      });
    }, 1000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function updateUI(data) {
    let foundSomething = false;

    // Display Google data if available
    if (data.issueToken || data.cookies) {
      googleSection.style.display = "block";
      issueTokenField.value = data.issueToken || "";
      cookiesField.value = data.cookies || "";
      foundSomething = true;
    }

    // Display Legacy data if available
    if (data.accessToken) {
      legacySection.style.display = "block";
      accessTokenField.value = data.accessToken;
      foundSomething = true;
    }

    if (foundSomething) {
      extractBtn.disabled = false;
      extractBtn.textContent = "Restart Extraction";
      envSelect.disabled = false;
      closeWarning.style.display = "block";
      if (data.issueToken && !data.cookies) {
        setStatus(
          "Issue Token captured, still waiting for cookies. Keep the Nest tab open.",
          "info"
        );
      } else {
        setStatus("Credentials captured! Copy the needed fields below.", "success");
        if (!data.listening) stopPolling();
      }
    } else if (data.listening) {
      extractBtn.disabled = true;
      envSelect.disabled = true;
      extractBtn.textContent = "Waiting for login...";
      setStatus("Waiting for credentials... Please sign in on the opened Nest tab.", "info");
    } else {
      stopPolling();
      extractBtn.disabled = false;
      envSelect.disabled = false;
      extractBtn.textContent = "Open Nest & Start Extraction";
    }
  }

  // Check state on popup load
  sendMessage({ action: "getStatus" }, (r) => {
    if (!r) return;
    if (r.issueToken || r.cookies || r.accessToken || r.listening) {
      updateUI(r);
      if (r.listening) startPolling();
    }
  });

  // Start Extractor
  extractBtn.addEventListener("click", () => {
    extractBtn.disabled = true;
    envSelect.disabled = true;
    extractBtn.textContent = "Starting...";

    googleSection.style.display = "none";
    legacySection.style.display = "none";
    closeWarning.style.display = "none";
    issueTokenField.value = "";
    cookiesField.value = "";
    accessTokenField.value = "";

    const env = envSelect.value;
    const domainName = env === "ft" ? "home.ft.nest.com" : "home.nest.com";

    sendMessage({ action: "reset" }, () => {
      sendMessage({ action: "startCapture", env: env }, (r) => {
        if (!r) {
          extractBtn.disabled = false;
          envSelect.disabled = false;
          extractBtn.textContent = "Open Nest & Start Extraction";
          setStatus("Could not start the extraction. Please try again.", "info");
          return;
        }
        extractBtn.textContent = "Waiting for login...";
        setStatus(`Opening ${domainName}... Sign in if needed. Extraction runs automatically.`, "info");
        startPolling();
      });
    });
  });

  // Setup generic copy buttons
  document.querySelectorAll(".btn-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el = document.getElementById(btn.getAttribute("data-target"));
      if (!el || !el.value) return;
      const originalText = btn.textContent;
      const flash = (text) => {
        btn.textContent = text;
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      };
      navigator.clipboard.writeText(el.value).then(
        () => flash("Copied!"),
        () => {
          // Safari can reject the async clipboard API in extension popups.
          el.removeAttribute("readonly");
          el.select();
          const copied = document.execCommand("copy");
          el.setAttribute("readonly", "");
          flash(copied ? "Copied!" : "Press Ctrl/Cmd+C");
        }
      );
    });
  });
});
