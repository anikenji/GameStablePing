import { Database } from "bun:sqlite";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";

const DATA_DIR = path.resolve("server/data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, "gsp.db");
export const db = new Database(dbPath);

// Initialize schema
db.run("PRAGMA journal_mode = WAL;");

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id TEXT NOT NULL, -- 'trial', 'standard_49k', 'dual_79k'
    status TEXT NOT NULL, -- 'active', 'expired'
    expires_at INTEGER NOT NULL, -- Unix timestamp in seconds
    max_devices INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_public_key TEXT UNIQUE NOT NULL,
    device_label TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS auth_codes (
    code TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    redirect_uri TEXT NOT NULL,
    verifier TEXT,
    expires_at INTEGER NOT NULL
  );
`);

db.run(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    order_code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'paid'
    created_at INTEGER NOT NULL
  );
`);

// Helper: Hash password
function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
}

// -------------------------------------------------------------
// USER & AUTH FUNCTIONS
// -------------------------------------------------------------

export function registerUser(email: string, password: string): { id: number; email: string } {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password || password.length < 6) {
    throw new Error("Email và mật khẩu (ít nhất 6 ký tự) không hợp lệ");
  }

  const existing = db.query("SELECT id FROM users WHERE email = ?").get(cleanEmail);
  if (existing) {
    throw new Error("Email này đã được đăng ký tài khoản");
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const now = Math.floor(Date.now() / 1000);

  const insertUser = db.query("INSERT INTO users (email, password_hash, salt, created_at) VALUES (?, ?, ?, ?) RETURNING id");
  const user = insertUser.get(cleanEmail, hash, salt, now) as { id: number };

  // Grant automatic 3-day trial subscription
  const trialExpiry = now + 86400 * 3; // 3 days
  db.run(
    "INSERT INTO subscriptions (user_id, plan_id, status, expires_at, max_devices) VALUES (?, ?, ?, ?, ?)",
    [user.id, "trial", "active", trialExpiry, 1]
  );

  return { id: user.id, email: cleanEmail };
}

export function authenticateUser(email: string, password: string): { id: number; email: string; subscription: any } {
  const cleanEmail = email.trim().toLowerCase();
  const user = db.query("SELECT * FROM users WHERE email = ?").get(cleanEmail) as any;

  if (!user) {
    throw new Error("Email hoặc mật khẩu không chính xác");
  }

  const computedHash = hashPassword(password, user.salt);
  if (computedHash !== user.password_hash) {
    throw new Error("Email hoặc mật khẩu không chính xác");
  }

  const sub = db.query("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.id);

  return {
    id: user.id,
    email: user.email,
    subscription: sub
  };
}

export function getUserDashboard(userId: number) {
  const user = db.query("SELECT id, email, created_at FROM users WHERE id = ?").get(userId) as any;
  if (!user) return null;

  const subscription = db.query("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId) as any;
  const devices = db.query("SELECT id, device_label, registered_at, last_seen_at, device_public_key FROM devices WHERE user_id = ?").all(userId) as any[];

  const now = Math.floor(Date.now() / 1000);
  const isActive = subscription && subscription.expires_at > now;
  const remainingSeconds = subscription ? Math.max(0, subscription.expires_at - now) : 0;
  const daysLeft = Math.ceil(remainingSeconds / 86400);

  return {
    user,
    subscription: {
      ...subscription,
      isActive,
      daysLeft
    },
    devices
  };
}

// -------------------------------------------------------------
// RFC 8252 LOOPBACK AUTH CODE FUNCTIONS
// -------------------------------------------------------------

export function createAuthCode(userId: number, redirectUri: string, verifier?: string): string {
  const code = "gsp_code_" + crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 300_000; // 5 minutes

  db.run(
    "INSERT INTO auth_codes (code, user_id, redirect_uri, verifier, expires_at) VALUES (?, ?, ?, ?, ?)",
    [code, userId, redirectUri, verifier || null, expiresAt]
  );

  return code;
}

export function exchangeAuthCode(code: string): { userId: number; refreshToken: string; deviceLimit: number } {
  const row = db.query("SELECT * FROM auth_codes WHERE code = ?").get(code) as any;
  if (!row) {
    throw new Error("Mã xác thực không hợp lệ hoặc đã hết hạn");
  }

  if (Date.now() > row.expires_at) {
    db.run("DELETE FROM auth_codes WHERE code = ?", [code]);
    throw new Error("Mã xác thực đã hết hạn");
  }

  db.run("DELETE FROM auth_codes WHERE code = ?", [code]);

  const sub = db.query("SELECT max_devices FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(row.user_id) as any;
  const deviceLimit = sub ? sub.max_devices : 1;

  const refreshToken = "gsp_rt_" + crypto.randomBytes(32).toString("hex") + "_" + row.user_id;

  return {
    userId: row.user_id,
    refreshToken,
    deviceLimit
  };
}

// -------------------------------------------------------------
// DEVICE BINDING & VERIFICATION
// -------------------------------------------------------------

export function bindDeviceAndCheckLimit(userId: number, devicePublicKey: string, deviceLabel: string): { ok: boolean; message?: string } {
  const now = Math.floor(Date.now() / 1000);
  const sub = db.query("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId) as any;

  if (!sub || sub.expires_at <= now) {
    return { ok: false, message: "Tài khoản của bạn đã hết hạn đăng ký. Vui lòng gia hạn gói cước." };
  }

  // Check if device is already registered for this user
  const existingDevice = db.query("SELECT id FROM devices WHERE device_public_key = ?").get(devicePublicKey) as any;

  if (existingDevice) {
    db.run("UPDATE devices SET last_seen_at = ?, device_label = ? WHERE id = ?", [now, deviceLabel, existingDevice.id]);
    return { ok: true };
  }

  // Count existing devices for this user
  const countRow = db.query("SELECT COUNT(*) as count FROM devices WHERE user_id = ?").get(userId) as any;
  const currentCount = countRow ? countRow.count : 0;

  if (currentCount >= sub.max_devices) {
    return {
      ok: false,
      message: `Tài khoản đã đạt giới hạn tối đa (${sub.max_devices} máy). Hãy vào Dashboard trên web để hủy liên kết máy cũ.`
    };
  }

  db.run(
    "INSERT INTO devices (user_id, device_public_key, device_label, registered_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
    [userId, devicePublicKey, deviceLabel, now, now]
  );

  return { ok: true };
}

export function unbindDevice(userId: number, deviceId: number): boolean {
  const res = db.run("DELETE FROM devices WHERE id = ? AND user_id = ?", [deviceId, userId]);
  return res.changes > 0;
}

// -------------------------------------------------------------
// BILLING & VIETQR PAYMENT
// -------------------------------------------------------------

export function createPaymentOrder(userId: number, planId: string): { orderCode: string; amount: number; qrUrl: string } {
  let amount = 49000;
  let maxDevices = 1;

  if (planId === "dual_79k") {
    amount = 79000;
    maxDevices = 2;
  }

  const orderCode = "GSP" + Math.floor(100000 + Math.random() * 900000);
  const now = Math.floor(Date.now() / 1000);

  db.run(
    "INSERT INTO payments (user_id, plan_id, amount, order_code, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    [userId, planId, amount, orderCode, now]
  );

  // VietQR QuickLink (MBBank or custom bank template)
  const qrUrl = `https://img.vietqr.io/image/MB-0335836486-compact2.png?amount=${amount}&addInfo=${orderCode}&accountName=GSP%20GAMESTABLEPING`;

  return {
    orderCode,
    amount,
    qrUrl
  };
}

export function confirmPayment(orderCode: string): boolean {
  const payment = db.query("SELECT * FROM payments WHERE order_code = ? AND status = 'pending'").get(orderCode) as any;
  if (!payment) return false;

  const now = Math.floor(Date.now() / 1000);
  const sub = db.query("SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(payment.user_id) as any;

  let newExpiry = now + 86400 * 30; // 30 days
  if (sub && sub.expires_at > now) {
    newExpiry = sub.expires_at + 86400 * 30; // Extend from current expiry
  }

  let maxDevices = payment.plan_id === "dual_79k" ? 2 : 1;

  db.run("UPDATE payments SET status = 'paid' WHERE id = ?", [payment.id]);
  db.run(
    "INSERT INTO subscriptions (user_id, plan_id, status, expires_at, max_devices) VALUES (?, ?, 'active', ?, ?)",
    [payment.user_id, payment.plan_id, newExpiry, maxDevices]
  );

  return true;
}

// Seed default VIP test account if no users exist
const userCount = db.query("SELECT COUNT(*) as count FROM users").get() as any;
if (!userCount || userCount.count === 0) {
  console.log("[DB] Seeding default VIP account (vip@gamepingbooster.com / 123456)...");
  const defaultUser = registerUser("vip@gamepingbooster.com", "123456");
  const oneYear = Math.floor(Date.now() / 1000) + 86400 * 365;
  db.run("UPDATE subscriptions SET plan_id = 'standard_49k', expires_at = ?, max_devices = 2 WHERE user_id = ?", [oneYear, defaultUser.id]);
}
