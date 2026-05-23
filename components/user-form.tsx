"use client";

import { useState, useCallback } from "react";
import type { User, CreateUserRequest, ApiResponse } from "@/lib/types";

interface UserFormProps {
  onUserCreated: (user: User) => void;
}

export function UserForm({ onUserCreated }: UserFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const startCountdown = useCallback((seconds: number) => {
    setCountdown(seconds);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const handleSendCode = async () => {
    setError(null);
    setSuccessMessage(null);

    if (!email) {
      setError("Please enter your email address first.");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }

    setIsSendingCode(true);

    try {
      const response = await fetch("/api/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const result: ApiResponse = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Failed to send verification code");
      }

      setSuccessMessage(result.message || "Verification code sent! Please check your email.");
      startCountdown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send verification code");
    } finally {
      setIsSendingCode(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          verificationCode,
        } as CreateUserRequest),
      });

      const result: ApiResponse<User> = await response.json();

      if (!result.success || !result.data) {
        throw new Error(result.error || "Failed to create user");
      }

      onUserCreated(result.data);
      setName("");
      setEmail("");
      setVerificationCode("");
      setSuccessMessage("User created successfully!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="name"
          className="block text-sm font-medium text-foreground"
        >
          Name
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div>
        <label
          htmlFor="email"
          className="block text-sm font-medium text-foreground"
        >
          Email
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isSubmitting}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleSendCode}
            disabled={isSendingCode || countdown > 0 || !email}
            className="inline-flex shrink-0 items-center justify-center rounded-md bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground shadow transition-colors hover:bg-secondary/80 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
          >
            {isSendingCode
              ? "Sending..."
              : countdown > 0
              ? `${countdown}s`
              : "Send Code"}
          </button>
        </div>
      </div>

      <div>
        <label
          htmlFor="verificationCode"
          className="block text-sm font-medium text-foreground"
        >
          Verification Code
        </label>
        <input
          id="verificationCode"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={verificationCode}
          onChange={(e) => {
            const val = e.target.value.replace(/\D/g, "");
            setVerificationCode(val);
          }}
          required
          disabled={isSubmitting}
          placeholder="Enter 6-digit code"
          className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Enter the 6-digit code sent to your email. Valid for 10 minutes.
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {successMessage && (
        <p className="text-sm text-green-600 dark:text-green-400">{successMessage}</p>
      )}

      <button
        type="submit"
        disabled={isSubmitting || !verificationCode}
        className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      >
        {isSubmitting ? "Creating..." : "Create User"}
      </button>
    </form>
  );
}
