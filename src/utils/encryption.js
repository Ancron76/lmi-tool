/**
 * PII Field-Level Encryption Utilities
 *
 * IMPORTANT: This module requires CryptoJS and an encryption key.
 * In a build-system app (Vite/webpack), use:
 *   const KEY = import.meta.env.VITE_ENCRYPTION_KEY;
 *
 * In the current vanilla JS app, the key would need to be
 * loaded from a secure source (not hardcoded).
 *
 * This file is a reference implementation for when
 * the app migrates to a build system.
 */

import CryptoJS from "crypto-js";

const KEY = import.meta.env?.VITE_ENCRYPTION_KEY || "";

if (!KEY || KEY.length < 32) {
  console.error("SECURITY: Encryption key missing or too short");
}

export function encryptField(value) {
  if (value === null || value === undefined || value === "") return value;
  try {
    return CryptoJS.AES.encrypt(String(value), KEY).toString();
  } catch (e) {
    console.error("Encryption failed", e);
    return value;
  }
}

export function decryptField(encrypted) {
  if (!encrypted || typeof encrypted !== "string") return encrypted;
  if (!encrypted.startsWith("U2FsdGVk")) return encrypted; // not encrypted
  try {
    const bytes = CryptoJS.AES.decrypt(encrypted, KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    console.error("Decryption failed", e);
    return "[encrypted]";
  }
}

export function encryptPII(data, fields) {
  const encrypted = { ...data };
  fields.forEach(field => {
    if (encrypted[field]) encrypted[field] = encryptField(encrypted[field]);
  });
  return encrypted;
}

export function decryptPII(data, fields) {
  if (!data) return data;
  const decrypted = { ...data };
  fields.forEach(field => {
    if (decrypted[field]) decrypted[field] = decryptField(decrypted[field]);
  });
  return decrypted;
}

// PII field lists per collection
export const PII_FIELDS = {
  borrowers: ["phone", "email", "firstName", "lastName"],
  pastCustomers: ["phone", "email", "borrowerName"],
  prequal: ["phone", "email", "borrowerName"],
  deals: ["borrowerName"],
  realtors: ["phone", "email"],
  communications: ["body"],
};
