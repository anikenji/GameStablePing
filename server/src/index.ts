import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mintLicenceToken } from "./token.js";
import { sealProfileBundle } from "./envelope.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 20080;
const DATA_DIR = path.resolve("server/data");
const CONFIG_DIR = path.resolve("server/config");
const KEYS_DIR = path.resolve("server/keys");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(KEYS_DIR, { recursive: true });

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

// In-memory mock database of accounts and auth codes
const usersDb = new Map<string, { id: bigint; email: string; tier: number; expiry: bigint }>();
usersDb.set("vip_player", {
  id: 1001n,
  email: "gamer@gamepingbooster.com",
  tier: 1, // VIP
  expiry: BigInt(Math.floor(Date.now() / 1000) + 86400 * 365) // 1 year
});

const authCodes = new Map<string, { userId: bigint; redirectUri: string; expiry: number }>();

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
      "Access-Control-Allow-Origin": "*"
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

  try {
    // -------------------------------------------------------------
    // Serve One-Click VPS Setup Script directly from this server
    // -------------------------------------------------------------
    if ((pathname === "/setup-vps.sh" || pathname === "/install.sh") && method === "GET") {
      const scriptPath = path.resolve("relay/deploy/setup-vps.sh");
      if (fs.existsSync(scriptPath)) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(fs.readFileSync(scriptPath, "utf8"));
      }
    }

    // -------------------------------------------------------------
    // Serve Master Licence Public Key (for VPS setup-vps.sh)
    // -------------------------------------------------------------
    if ((pathname === "/api/v1/licence.pub" || pathname === "/keys/licence.pub") && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(publicKeyPem);
    }

    // -------------------------------------------------------------
    // Direct Download Endpoint for Windows App (.ZIP)
    // -------------------------------------------------------------
    if (pathname === "/download" && (method === "GET" || method === "HEAD")) {
      const zipPath = path.resolve("dist/GamePingBooster-v0.2.2-win-x64.zip");
      if (fs.existsSync(zipPath)) {
        const stat = fs.statSync(zipPath);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="GameStablePing-v0.2.2-win-x64.zip"',
          "Content-Length": stat.size
        });
        const readStream = fs.createReadStream(zipPath);
        return readStream.pipe(res);
      } else {
        return sendJson(404, { error: "Installer package not found" });
      }
    }

    // -------------------------------------------------------------
    // 1. Landing Page & Health check
    // -------------------------------------------------------------
    if (pathname === "/" && (method === "GET" || method === "HEAD")) {
      const accept = req.headers["accept"] || "";
      const htmlPath = path.resolve("server/public/index.html");
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
    // 2. Loopback OAuth2 Authorize (RFC 8252)
    // -------------------------------------------------------------
    if (pathname === "/app/authorize" && method === "GET") {
      const redirectUri = parsedUrl.searchParams.get("redirect_uri") || "http://127.0.0.1:51821/callback";
      const state = parsedUrl.searchParams.get("state") || "";

      // In a real system, show a sign-in form. For seamless dev/production, auto-grant code
      const code = "auth_" + crypto.randomBytes(16).toString("hex");
      authCodes.set(code, {
        userId: 1001n,
        redirectUri,
        expiry: Date.now() + 300_000 // 5 minutes
      });

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      if (state) callbackUrl.searchParams.set("state", state);

      return sendHtml(200, `
        <!DOCTYPE html>
        <html>
        <head><title>GamePingBooster Authentication</title>
        <style>body{font-family:sans-serif;background:#18181b;color:#f4f4f5;text-align:center;padding:50px;}</style>
        </head>
        <body>
          <h2>Xác thực tài khoản thành công!</h2>
          <p>Đang chuyển hướng về ứng dụng GamePingBooster trên máy tính của bạn...</p>
          <p><a href="${callbackUrl.toString()}" style="color:#38bdf8;">Nhấn vào đây nếu trình duyệt không tự chuyển</a></p>
          <script>setTimeout(() => { window.location.href = "${callbackUrl.toString()}"; }, 500);</script>
        </body>
        </html>
      `);
    }

    // -------------------------------------------------------------
    // 3. Issue 150-byte Licence Token (/auth/token)
    // -------------------------------------------------------------
    if ((pathname === "/auth/token" || pathname === "/api/token") && method === "POST") {
      const body = await readBodyJson();
      const devicePubKeyHex = body.device || body.devicePublicKey;
      const refreshToken = body.refreshToken || body.code || "valid_refresh_token";

      if (!devicePubKeyHex) {
        return sendJson(400, { error: "device (hex public key) is required" });
      }

      const deviceKeyRaw = Buffer.from(devicePubKeyHex, "hex");
      if (deviceKeyRaw.length !== 65) {
        return sendJson(400, { error: "device public key must be 65 bytes uncompressed P-256" });
      }

      const userId = 1001n;
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
        userId: Number(userId),
        tier: 1
      });
    }

    // -------------------------------------------------------------
    // 4. Dynamic Profile & Relay Fleet (/profile)
    // -------------------------------------------------------------
    if (pathname === "/profile" && method === "GET") {
      const devicePubKeyHex = parsedUrl.searchParams.get("device");
      const profileData = getMultiGameProfile();
      // Ensure dynamic relays from fleet.json are injected into profile
      profileData.relays = getFleetRelays();

      const jsonStr = JSON.stringify(profileData);

      // If client requests sealed envelope (LicenceClient expects { "envelope": "..." })
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
    // 5. One-Click Relay VPS Auto-Registration (/api/v1/relays/register)
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

      // Check if relay already exists, update or append
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

    // -------------------------------------------------------------
    // 6. Relay Telemetry Ingestion (/api/relay/report)
    // -------------------------------------------------------------
    if (pathname === "/api/relay/report" && method === "POST") {
      const body = await readBodyJson();
      return sendJson(200, { status: "received", timestamp: Date.now() });
    }

    // 404 Not Found
    sendJson(404, { error: "Endpoint not found" });

  } catch (err: any) {
    console.error("[Server Error]", err);
    sendJson(500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[GamePingBooster Server] Listening on http://0.0.0.0:${PORT}`);
});
