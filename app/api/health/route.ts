import { getPool } from "@/db/pool";
import { connectFalkorDB } from "@/graph/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ServiceStatus = "ok" | "unavailable";

// Reports reachability only; never echoes connection strings or driver error text to callers.
export async function GET() {
  const [postgres, falkordb] = await Promise.all([checkPostgres(), checkFalkorDB()]);
  const ok = postgres === "ok" && falkordb === "ok";
  return Response.json({ status: ok ? "ok" : "degraded", services: { postgres, falkordb } }, { status: ok ? 200 : 503 });
}

async function checkPostgres(): Promise<ServiceStatus> {
  try {
    await getPool().query("SELECT 1");
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function checkFalkorDB(): Promise<ServiceStatus> {
  try {
    const db = await connectFalkorDB();
    try {
      await db.list();
      return "ok";
    } finally {
      await db.close();
    }
  } catch {
    return "unavailable";
  }
}
