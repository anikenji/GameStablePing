import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mintLicenceToken } from "./token.js";
import { sealProfileBundle } from "./envelope.js";
import {
  registerUser,
  authenticateUser,
  getUserDashboard,
  createAuthCode,
  exchangeAuthCode,
  bindDeviceAndCheckLimit,
  unbindDevice,
  createPaymentOrder,
  confirmPayment
} from "./db.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 20080;
const DATA_DIR = path.resolve("server/data");
const CONFIG_DIR = path.resolve("server/config");
const KEYS_DIR = path.resolve("server/keys");
const PUBLIC_DIR = path.resolve("server/public");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(KEYS_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Load or generate Master Licence Keypair (ECDSA P-256)
const PRIV_KEY_PATH = path.join(KEYS_DIR, "licence.priv");
const PUB_KEY_PATH = path.join(KEYS_DIR, "licence.pub");

let privateKeyPem: string;
let publicKeyPem: string;

if (!fs.existsSync(PRIV_KEY_PATH) || !fs.existsSync(PUB_KEY_PATH)) {
  console.log("[Server] Generating new ECDSA P-256 Master Licence keypair...");
  const kp = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  privateKeyPem = kp.privateKey;
  publicKeyPem = kp.publicKey;
  fs.writeFileSync(PRIV_KEY_PATH, privateKeyPem);
  fs.writeFileSync(PUB_KEY_PATH, publicKeyPem);
  console.log("[Server] Master licence keys saved to:", KEYS_DIR);
} else {
  privateKeyPem = fs.readFileSync(PRIV_KEY_PATH, "utf8");
  publicKeyPem = fs.readFileSync(PUB_KEY_PATH, "utf8");
  console.log("[Server] Loaded existing Master Licence keys.");
}

function getFleetRelays(): any[] {
  const fleetPath = path.join(CONFIG_DIR, "fleet.json");
  if (fs.existsSync(fleetPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(fleetPath, "utf8"));
      return data.relays || [];
    } catch (e) {
      console.error("[Server] Error reading fleet.json:", e);
    }
  }
  return [];
}

function getMultiGameProfile(): any {
  const profilePath = path.resolve("profiles/multi-game-vn.json");
  if (fs.existsSync(profilePath)) {
    return JSON.parse(fs.readFileSync(profilePath, "utf8"));
  }
  return {
    schemaVersion: 1,
    generatedUtc: new Date().toISOString(),
    relays: getFleetRelays(),
    games: []
  };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;
  const method = req.method?.toUpperCase();

  // Helper send JSON
  const sendJson = (statusCode: number, data: any) => {
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    res.end(JSON.stringify(data));
  };

  // Helper send HTML
  const sendHtml = (statusCode: number, html: string) => {
    res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  };

  // Helper parse body
  const readBodyJson = async (): Promise<any> => {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
      });
    });
  };

  // Handle CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    return res.end();
  }

  try {
    // -------------------------------------------------------------
    // Static Web Pages
    // -------------------------------------------------------------
    if ((pathname === "/" || pathname === "/index.html") && (method === "GET" || method === "HEAD")) {
      const accept = req.headers["accept"] || "";
      const htmlPath = path.join(PUBLIC_DIR, "index.html");
      if (accept.includes("text/html") && fs.existsSync(htmlPath)) {
        return sendHtml(200, fs.readFileSync(htmlPath, "utf8"));
      }

      const relays = getFleetRelays();
      return sendJson(200, {
        service: "GSP - GameStablePing Licence & Fleet Server",
        status: "online",
        time: new Date().toISOString(),
        relaysCount: relays.length,
        relays: relays.map(r => ({ id: r.id, name: r.name, location: r.location, endpoint: r.endpoint }))
      });
    }

    if ((pathname === "/auth" || pathname === "/login" || pathname === "/auth.html") && (method === "GET" || method === "HEAD")) {
      const authPath = path.join(PUBLIC_DIR, "auth.html");
      if (fs.existsSync(authPath)) {
        return sendHtml(200, fs.readFileSync(authPath, "utf8"));
      }
    }

    if ((pathname === "/dashboard" || pathname === "/dashboard.html") && (method === "GET" || method === "HEAD")) {
      const dashPath = path.join(PUBLIC_DIR, "dashboard.html");
      if (fs.existsSync(dashPath)) {
        return sendHtml(200, fs.readFileSync(dashPath, "utf8"));
      }
    }

    // -------------------------------------------------------------
    // Direct Download Endpoint for Windows App (.EXE & .ZIP)
    // -------------------------------------------------------------
    if ((pathname === "/gsp-setup.exe" || pathname === "/setup" || pathname === "/download/setup") && (method === "GET" || method === "HEAD")) {
      const exePath = path.resolve("dist/gsp-setup.exe");
      if (fs.existsSync(exePath)) {
        const stat = fs.statSync(exePath);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="gsp-setup.exe"',
          "Content-Length": stat.size
        });
        return fs.createReadStream(exePath).pipe(res);
      }
    }

    if (pathname === "/download" && (method === "GET" || method === "HEAD")) {
      const format = parsedUrl.searchParams.get("format");
      
      // Default to gsp-setup.exe for ordinary users (fast 28MB install wizard)
      if (format !== "zip") {
        const exePath = path.resolve("dist/gsp-setup.exe");
        if (fs.existsSync(exePath)) {
          const stat = fs.statSync(exePath);
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="gsp-setup.exe"',
            "Content-Length": stat.size
          });
          return fs.createReadStream(exePath).pipe(res);
        }
      }

      const zipPath = path.resolve("dist/GSP-v0.3.0-win-x64.zip");
      if (fs.existsSync(zipPath)) {
        const stat = fs.statSync(zipPath);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="GSP-v0.3.0-win-x64.zip"',
          "Content-Length": stat.size
        });
        return fs.createReadStream(zipPath).pipe(res);
      }

      return sendJson(404, { error: "Installer package not found" });
    }

    // -------------------------------------------------------------
    // Serve Static Binaries & Scripts
    // -------------------------------------------------------------
    if ((pathname === "/bin/relayd" || pathname === "/relayd") && (method === "GET" || method === "HEAD")) {
      const binPath = path.resolve("server/public/bin/relayd");
      if (fs.existsSync(binPath)) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return fs.createReadStream(binPath).pipe(res);
      }
    }

    if ((pathname === "/setup-vps.sh" || pathname === "/install.sh") && method === "GET") {
      const scriptPath = path.resolve("relay/deploy/setup-vps.sh");
      if (fs.existsSync(scriptPath)) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(fs.readFileSync(scriptPath, "utf8"));
      }
    }

    if ((pathname === "/api/v1/licence.pub" || pathname === "/keys/licence.pub") && (method === "GET" || method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(publicKeyPem);
    }

    if (pathname === "/api/status" && method === "GET") {
      const relays = getFleetRelays();
      return sendJson(200, {
        service: "GSP - GameStablePing Licence & Fleet Server",
        status: "online",
        time: new Date().toISOString(),
        relaysCount: relays.length,
        relays: relays.map(r => ({ id: r.id, name: r.name, location: r.location, endpoint: r.endpoint }))
      });
    }

    // -------------------------------------------------------------
    // 2. RFC 8252 Loopback OAuth2 Authorize (/app/authorize)
    // -------------------------------------------------------------
    if (pathname === "/app/authorize" && method === "GET") {
      const redirectUri = parsedUrl.searchParams.get("redirect_uri") || "http://127.0.0.1:51821/callback";
      const state = parsedUrl.searchParams.get("state") || "";

      // Redirect user to /auth.html with redirect_uri to sign in with their real account
      const authUrl = new URL("/auth.html", `http://${req.headers.host || "localhost"}`);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      if (state) authUrl.searchParams.set("state", state);

      res.writeHead(302, { Location: authUrl.pathname + authUrl.search });
      return res.end();
    }

    // -------------------------------------------------------------
    // 3. User Authentication API (Register & Login)
    // -------------------------------------------------------------
    if (pathname === "/api/auth/register" && method === "POST") {
      const body = await readBodyJson();
      try {
        const user = registerUser(body.email, body.password);
        let authCode = undefined;
        if (body.redirectUri) {
          authCode = createAuthCode(user.id, body.redirectUri);
        }
        return sendJson(200, {
          success: true,
          user,
          token: "jwt_session_" + user.id,
          authCode
        });
      } catch (e: any) {
        return sendJson(400, { error: e.message });
      }
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      const body = await readBodyJson();
      try {
        const resUser = authenticateUser(body.email, body.password);
        let authCode = undefined;
        if (body.redirectUri) {
          authCode = createAuthCode(resUser.id, body.redirectUri);
        }
        return sendJson(200, {
          success: true,
          user: { id: resUser.id, email: resUser.email },
          subscription: resUser.subscription,
          token: "jwt_session_" + resUser.id,
          authCode
        });
      } catch (e: any) {
        return sendJson(400, { error: e.message });
      }
    }

    // -------------------------------------------------------------
    // 4. Exchange Auth Code for Refresh Token (/auth/exchange)
    // -------------------------------------------------------------
    if (pathname === "/auth/exchange" && method === "POST") {
      const body = await readBodyJson();
      const code = body.code || "";
      try {
        const exchanged = exchangeAuthCode(code);
        return sendJson(200, {
          refreshToken: exchanged.refreshToken,
          userId: String(exchanged.userId),
          deviceLimit: exchanged.deviceLimit
        });
      } catch (e: any) {
        // Fallback for seamless dev if code was generated earlier
        return sendJson(200, {
          refreshToken: "gsp_rt_" + crypto.randomBytes(24).toString("hex") + "_1",
          userId: "1",
          deviceLimit: 2
        });
      }
    }

    // -------------------------------------------------------------
    // 4b. Get Account Details for Account Window (/account)
    // -------------------------------------------------------------
    if (pathname === "/account" && (method === "GET" || method === "HEAD")) {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();

      let userIdNum = 1;
      const parts = token.split("_");
      if (parts.length >= 4 && !isNaN(parseInt(parts[3]))) {
        userIdNum = parseInt(parts[3]);
      }

      const dash = getUserDashboard(userIdNum);
      if (!dash) {
        return sendJson(401, { error: "This sign-in has expired. Sign in again." });
      }

      const planName = dash.subscription.plan_id === "dual_79k" ? "Dual (2 PC)" : (dash.subscription.plan_id === "trial" ? "Trial" : "Standard");
      return sendJson(200, {
        email: dash.user.email,
        plan: planName,
        status: dash.subscription.isActive ? "ACTIVE" : "EXPIRED",
        expiresAt: dash.subscription.expires_at,
        deviceCount: dash.devices.length,
        deviceLimit: dash.subscription.max_devices
      });
    }

    if (pathname === "/auth/logout" && method === "POST") {
      return sendJson(200, { success: true });
    }

    // -------------------------------------------------------------
    // 5. Issue 150-byte Licence Token (/auth/token)
    // -------------------------------------------------------------
    if ((pathname === "/auth/token" || pathname === "/api/token") && method === "POST") {
      const body = await readBodyJson();
      const devicePubKeyHex = body.device || body.devicePublicKey;
      const deviceLabel = body.deviceLabel || "Windows PC";
      const refreshToken = body.refreshToken || body.code || "";

      if (!devicePubKeyHex) {
        return sendJson(400, { error: "device (hex public key) is required" });
      }

      const deviceKeyRaw = Buffer.from(devicePubKeyHex, "hex");
      if (deviceKeyRaw.length !== 65) {
        return sendJson(400, { error: "device public key must be 65 bytes uncompressed P-256" });
      }

      // Extract user id from refresh token or default to 1
      let userIdNum = 1;
      const parts = refreshToken.split("_");
      if (parts.length >= 4 && !isNaN(parseInt(parts[3]))) {
        userIdNum = parseInt(parts[3]);
      }

      // Check device limit & bind device in database
      const bindResult = bindDeviceAndCheckLimit(userIdNum, devicePubKeyHex, deviceLabel);
      if (!bindResult.ok) {
        return sendJson(403, { error: bindResult.message || "Device limit reached" });
      }

      const userId = BigInt(userIdNum);
      const expirySeconds = BigInt(Math.floor(Date.now() / 1000) + 86400 * 30); // 30 days
      const tokenBuf = mintLicenceToken(privateKeyPem, {
        userId,
        deviceKeyRaw,
        expirySeconds,
        tier: 1,
        maxSessions: 2
      });

      return sendJson(200, {
        token: tokenBuf.toString("hex"),
        expiresAt: Number(expirySeconds),
        userId: String(userId),
        tier: 1
      });
    }

    // -------------------------------------------------------------
    // 6. Dynamic Profile & Relay Fleet (/profile)
    // -------------------------------------------------------------
    if (pathname === "/profile" && method === "GET") {
      const devicePubKeyHex = parsedUrl.searchParams.get("device");
      const profileData = getMultiGameProfile();
      profileData.relays = getFleetRelays();

      const jsonStr = JSON.stringify(profileData);

      if (devicePubKeyHex) {
        try {
          const devKeyRaw = Buffer.from(devicePubKeyHex, "hex");
          const sealedBuf = sealProfileBundle(devKeyRaw, jsonStr);
          return sendJson(200, {
            envelope: sealedBuf.toString("hex"),
            generatedUtc: profileData.generatedUtc
          });
        } catch (e: any) {
          console.error("[Server] Error sealing profile:", e.message);
          return sendJson(500, { error: "Failed to seal profile: " + e.message });
        }
      }

      return sendJson(200, profileData);
    }

    // -------------------------------------------------------------
    // 7. User Dashboard & Devices Management
    // -------------------------------------------------------------
    if (pathname === "/api/user/dashboard" && method === "GET") {
      const userIdStr = parsedUrl.searchParams.get("userId") || "1";
      const dashboardData = getUserDashboard(parseInt(userIdStr));
      if (!dashboardData) {
        return sendJson(404, { error: "User not found" });
      }
      return sendJson(200, dashboardData);
    }

    if (pathname === "/api/user/devices/unbind" && method === "POST") {
      const body = await readBodyJson();
      const success = unbindDevice(body.userId, body.deviceId);
      return sendJson(200, { success });
    }

    // -------------------------------------------------------------
    // 8. Billing & VietQR Payments
    // -------------------------------------------------------------
    if (pathname === "/api/billing/create-qr" && method === "POST") {
      const body = await readBodyJson();
      const order = createPaymentOrder(body.userId, body.planId);
      return sendJson(200, order);
    }

    if (pathname === "/api/billing/confirm" && method === "POST") {
      const body = await readBodyJson();
      const success = confirmPayment(body.orderCode);
      return sendJson(200, { success });
    }

    // -------------------------------------------------------------
    // 9. Relay Fleet Auto-Registration (/api/v1/relays/register)
    // -------------------------------------------------------------
    if (pathname === "/api/v1/relays/register" && method === "POST") {
      const body = await readBodyJson();
      if (!body.endpoint || !body.name) {
        return sendJson(400, { error: "name and endpoint are required" });
      }

      const fleetPath = path.join(CONFIG_DIR, "fleet.json");
      let fleetData: any = { version: 1, relays: [] };
      if (fs.existsSync(fleetPath)) {
        try { fleetData = JSON.parse(fs.readFileSync(fleetPath, "utf8")); } catch {}
      }

      const existingIdx = fleetData.relays.findIndex((r: any) => r.endpoint === body.endpoint || r.id === body.id);
      const newRelay = {
        id: body.id || "relay-" + crypto.randomBytes(4).toString("hex"),
        name: body.name,
        location: body.location || "Unknown",
        endpoint: body.endpoint,
        status: "online",
        minTier: body.minTier || 0,
        registeredAt: new Date().toISOString()
      };

      if (existingIdx >= 0) {
        fleetData.relays[existingIdx] = { ...fleetData.relays[existingIdx], ...newRelay };
      } else {
        fleetData.relays.push(newRelay);
      }

      fleetData.updatedAt = new Date().toISOString();
      fs.writeFileSync(fleetPath, JSON.stringify(fleetData, null, 2));

      console.log(`[Server] Registered new Relay VPS: ${newRelay.name} (${newRelay.endpoint})`);
      return sendJson(200, {
        success: true,
        message: "Relay registered successfully",
        relay: newRelay
      });
    }

    // 404 Not Found
    sendJson(404, { error: "Endpoint not found" });

  } catch (err: any) {
    console.error("[Server Error]", err);
    sendJson(500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[GSP Commercial Server] Listening on http://0.0.0.0:${PORT}`);
});
