import type { NextFunction, Request, Response } from "express";
import { auth } from "../services/firebaseService/firebaseService";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
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
