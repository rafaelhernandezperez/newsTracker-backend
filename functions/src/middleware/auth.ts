import type { NextFunction, Request, Response } from "express";
import { auth } from "../services/firebaseService/firebaseService";

/**
 * TEMPORARY: while Firebase Auth is not configured in the frontend, set
 * AUTH_DISABLED=true (functions/.env) to accept every request as a fixed dev
 * user. Remove the flag (or set it to false) once real login is enabled —
 * never deploy to production with it on.
 */
const DEV_UID = "dev-user";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  if (process.env.AUTH_DISABLED === "true") {
    (req as Request & { user?: unknown }).user = { uid: DEV_UID };
    return next();
  }

  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const token = header.replace("Bearer ", "").trim();
    const decoded = await auth.verifyIdToken(token);

    (req as Request & { user?: unknown }).user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: "Invalid token" });
  }
}
