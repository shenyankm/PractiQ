import { NextResponse } from "next/server";
import { dbPool } from "@/lib/db";
import type { ApiResponse, HealthCheck } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<ApiResponse<HealthCheck>>> {
  try {
    const client = await dbPool.connect();
    let dbConnected = false;
    try {
      await client.query("SELECT 1");
      dbConnected = true;
    } finally {
      client.release();
    }

    const health: HealthCheck = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: dbConnected,
      version: "1.0.0",
    };

    return NextResponse.json({ success: true, data: health });
  } catch (error) {
    const health: HealthCheck = {
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      database: false,
      version: "1.0.0",
    };

    return NextResponse.json(
      {
        success: false,
        data: health,
        error: error instanceof Error ? error.message : "Health check failed",
      },
      { status: 503 }
    );
  }
}
