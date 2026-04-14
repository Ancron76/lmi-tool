import { addDoc, collection } from "firebase/firestore";
import { db } from "../firebase";

/**
 * Write an immutable audit log entry.
 * Audit logs cannot be updated or deleted (enforced by Firestore rules).
 */
export async function logAuditEvent({
  action,        // "view" | "create" | "update" | "delete" | "login" | "export"
  resource,      // "borrower" | "deal" | "realtor" | "report" | etc
  resourceId,    // Firestore document ID
  resourceName,  // Human-readable name
  userId,        // current user uid
  userName,      // current user display name
  tenantId,      // current tenant
  details,       // optional: what changed
  ipAddress,     // optional
}) {
  try {
    await addDoc(collection(db, "auditLog"), {
      action,
      resource,
      resourceId: resourceId || null,
      resourceName: resourceName || null,
      userId,
      userName,
      tenantId,
      details: details || null,
      ipAddress: ipAddress || null,
      timestamp: new Date(),
      userAgent: navigator.userAgent,
    });
  } catch (e) {
    // Audit log failure should never crash the app
    console.error("Audit log write failed", e);
  }
}
