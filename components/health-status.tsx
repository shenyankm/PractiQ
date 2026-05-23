"use client";

import { useEffect, useState } from "react";
import type { ApiResponse, HealthCheck } from "@/lib/types";

export function HealthStatus() {
  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const response = await fetch("/api/health");
        const result: ApiResponse<HealthCheck> = await response.json();

        if (result.success && result.data) {
          setHealth(result.data);
          setError(null);
        } else {
          setError(result.error || "Health check failed");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Connection failed");
      } finally {
        setLoading(false);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-muted-foreground"></span>
        Checking system health...
      </div>
    );
  }

  if (error || !health) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <span className="inline-block h-2 w-2 rounded-full bg-destructive"></span>
        {error || "System unavailable"}
      </div>
    );
  }

  const isHealthy = health.status === "healthy";

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            isHealthy ? "bg-green-500" : "bg-destructive"
          }`}
        ></span>
        <span
          className={
            isHealthy ? "text-green-600 dark:text-green-400" : "text-destructive"
          }
        >
          {isHealthy ? "System Healthy" : "System Unhealthy"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span
          className={`inline-block h-2 w-2 rounded-full ${
            health.database ? "bg-green-500" : "bg-destructive"
          }`}
        ></span>
        Database: {health.database ? "Connected" : "Disconnected"}
      </div>
      <p className="text-xs text-muted-foreground">
        Last checked: {new Date(health.timestamp).toLocaleTimeString()}
      </p>
    </div>
  );
}
