# Nest Token Extractor (Cross-Browser Extension)

A unified browser extension that easily extracts the authentication credentials required for home automation projects integrating Nest devices. It breaks down the outputs into distinct, copyable fields so you can plug them directly into your integration.

Supports major custom components and plugins including:

- [Home Assistant: Nest Legacy](https://github.com/tronikos/nest_legacy)
- [Home Assistant: ha-nest-protect](https://github.com/iMicknl/ha-nest-protect)
- [Homebridge Nest](https://github.com/chrisjshull/homebridge-nest)
- [Homebridge Nest Accfactory](https://github.com/n0rt0nthec4t/homebridge-nest-accfactory)

## Features

- **Multi-Browser Support**: Works identically on Google Chrome, Mozilla Firefox, and Apple Safari.
- **Google Accounts Support**: Automatically extracts both `issueToken` and `cookies` values.
- **Legacy Nest Accounts Support**: Directly fetches the legacy `access_token` session token.
- **Field Test Environment**: Easily toggle between Production (`home.nest.com`) and Field Test (`home.ft.nest.com`).
- **Isolated Fields**: Outputs raw, unencoded fields so you can extract exactly what you need.

## Installation

Download the respective zip file for your browser from the [Releases page](https://github.com/tronikos/nest-token-extractor/releases/latest).

### Google Chrome (and Chromium browsers)

1. Unzip `nest-token-extractor-chrome.zip`.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the unzipped folder.

### Mozilla Firefox

Requires Firefox 115 or newer.

1. Unzip `nest-token-extractor-firefox.zip`.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**
4. Select the `manifest.json` file inside the unzipped folder (not `manifest.firefox.json` from the source tree).

### Apple Safari (macOS)

This is an ad-hoc signed community build, so macOS quarantines it on download and Safari needs its developer settings enabled to load it. Follow the steps in order:

1. Unzip `nest-token-extractor-safari.zip` and move `Nest Token Extractor.app` into `/Applications`.
2. Clear the download quarantine flag, otherwise macOS reports the app as "damaged" and refuses to run it:

    ```sh
    xattr -dr com.apple.quarantine "/Applications/Nest Token Extractor.app"
    ```

3. Launch `Nest Token Extractor.app` once. This registers the bundled extension with macOS. You can quit it right after.
4. Open Safari and go to **Safari > Settings > Advanced** and check **Show features for web developers**.
5. Go to **Safari > Settings > Developer** and check **Allow unsigned extensions** (you will be asked for your password).
6. Go to **Safari > Settings > Extensions** and enable the checkbox next to **Nest Token Extractor**.
7. With the extension selected, set its website access for `nest.com` and `google.com` to **Allow**. Safari grants no host access by default, and the extension cannot read the Google authentication cookies without it.

> [!IMPORTANT]
> macOS resets **Allow unsigned extensions** every time Safari restarts. If the extension disappears from the toolbar after quitting Safari, re-check that box (step 5) and the extension comes back — you do not need to reinstall it.

> [!NOTE]
> Safari sometimes does not redraw the extension list after you re-enable **Allow unsigned extensions**, so **Nest Token Extractor** stays missing even though macOS has it registered. With the Extensions pane still open, rename `Nest Token Extractor.app` in the Finder to anything else and the list refreshes immediately; you can rename it back afterwards and it stays listed.

## Usage

> [!WARNING]
> **⚠️ CRITICAL BROWSER WARNING (Google Chrome):**
> Do **NOT** use Google Chrome or Microsoft Edge to extract cookies for Google Accounts. Modern Chromium-based browsers use aggressive, hardware-bound session security (Device Bound Session Credentials / DBSC) with Google. Cookies extracted via Chrome are cryptographically bound to the Chrome hardware profile and will fail with `Invalid authentication` in Python/Home Assistant or Homebridge.
> **You MUST use Firefox or Safari** to run this extraction and get a long-lived, portable cookie.

> [!TIP]
> **💡 FIREFOX ENHANCED TRACKING PROTECTION:**
> Firefox's Enhanced Tracking Protection (ETP) can block third-party cookie transmission in cross-origin frames. The extension falls back to reading the cookie jar directly, so this is rarely a problem, but if the **Cookies** field still comes back empty you can click the **Shield** icon in the Firefox address bar on `home.nest.com`, toggle off **Enhanced Tracking Protection**, and restart the extraction.

1. **⚠️ IMPORTANT**: Use a standard browsing window. Do **NOT** use Incognito/Private Mode, as third-party login cookies are restricted and you will face endless redirect loops during authentication.
2. Click the extension icon in your browser toolbar.
3. Select your environment (Production or Field Test).
4. Click the **Open Nest & Start Extraction** button. This will automatically redirect you to the appropriate Nest portal.
5. Sign in as you normally would:
    - Log in via Google, **OR**
    - Log in using your legacy Nest email/password.
6. Wait for the extension badge to show a green checkmark (`✓`).
7. Click the extension icon again. Your credentials will be populated in the window.
8. Use the "Copy" buttons next to the respective fields and paste them into your plugin/integration config.
9. **DO NOT explicitly log out of the Nest portal**, as this will immediately kill the session tokens you just extracted. Simply close the tab.

An extraction stops listening automatically 15 minutes after it starts. If you took longer than that, just click **Restart Extraction**.

## Troubleshooting

**The Nest tab does not open when I click the button.**
Update to the latest release. Older versions aborted before opening the tab on Firefox, which also left the **Cookies** field empty.

**The Cookies field stays empty (Firefox).**
Make sure you are on the latest release, are not in a Private window, and are signing in with a Google account (legacy Nest accounts produce an **Access Token** instead, which is expected). If it is still empty, turn off Enhanced Tracking Protection for `home.nest.com` and restart the extraction.

**It stops at "Issue Token captured, still waiting for cookies" (Safari).**
Safari never exposes the outgoing `Cookie` header to extensions, so the cookies have to be read from the cookie jar instead — and Safari only allows that if the extension has been granted access to `google.com` itself, not just `accounts.google.com`. Update to the latest release, then open **Safari > Settings > Extensions**, select **Nest Token Extractor**, and set both `nest.com` and `google.com` to **Allow** (or use **Always Allow on Every Website**). Restart the extraction afterwards.

**Credentials work at first, then fail with `Invalid authentication` (Chrome/Edge).**
This is Chromium's device-bound session security. Redo the extraction in Firefox or Safari; there is no workaround inside the extension.

**The extension does not appear in Safari > Settings > Extensions.**
Releases up to and including v1.0.2 were built with code signing turned off entirely, and macOS will not register an app extension that carries no signature at all — the app installs and launches, but nothing ever shows up in Safari (and **Add Temporary Extension...** stays greyed out for the `.appex`). Download the newest release, which is ad-hoc signed, delete the old copy from `/Applications`, and redo the Safari installation steps in order — the quarantine flag has to be cleared *before* the first launch. Also confirm **Allow unsigned extensions** is still checked; Safari clears it on every restart. If it is checked and the extension is still missing, Safari has simply not redrawn its list — rename `Nest Token Extractor.app` in the Finder while the Extensions pane is open to force a refresh, then rename it back.

## Privacy & Permissions

This extension requests the bare minimum permissions needed to function:

- **cookies**: Required to capture the Google authentication `SID`, `SSID`, etc. markers. Only that fixed list of Google auth cookie names is ever read.
- **Access to `google.com`**: Those cookies are stored on the `.google.com` domain, and Safari refuses to hand them over unless the extension holds access to that domain rather than only `accounts.google.com`.
- **webRequest**: Required to silently intercept the OAuth tokens requested securely by Google.
- **tabs**: To automatically spawn the authentication flow window.
- **storage**: Holds the captured values in session memory so they survive the browser suspending the extension mid-login. Cleared when the browser closes.
- **alarms**: Wakes the extension back up while it waits for you to finish signing in.

**Data safety guarantee**: This extension runs entirely locally in your browser. None of your tokens or cookies are ever transmitted, tracked, or sent externally. All code is open-source.
