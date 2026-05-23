import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { validateVerificationCode } from "@/lib/verification";
import type { ApiResponse, User, CreateUserRequest } from "@/lib/types";

export async function GET(): Promise<NextResponse<ApiResponse<User[]>>> {
  try {
    const { rows } = await query<User>(
      `SELECT id, name, email, created_at 
       FROM users 
       ORDER BY created_at DESC 
       LIMIT 100`
    );

    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error("GET /api/users error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch users",
      },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<User>>> {
  try {
    const body: CreateUserRequest = await request.json();

    if (!body.name || !body.email) {
      return NextResponse.json(
        { success: false, error: "Name and email are required" },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.email)) {
      return NextResponse.json(
        { success: false, error: "Invalid email format" },
        { status: 400 }
      );
    }

    if (!body.verificationCode) {
      return NextResponse.json(
        { success: false, error: "Email verification code is required" },
        { status: 400 }
      );
    }

    // Validate verification code
    const validationResult = await validateVerificationCode(
      body.email,
      body.verificationCode,
      "register"
    );

    if (!validationResult.success) {
      return NextResponse.json(
        { success: false, error: validationResult.error || "Invalid verification code" },
        { status: 400 }
      );
    }

    const { rows } = await query<User>(
      `INSERT INTO users (name, email) 
       VALUES ($1, $2) 
       RETURNING id, name, email, created_at`,
      [body.name, body.email]
    );

    return NextResponse.json(
      { success: true, data: rows[0], message: "User created successfully" },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/users error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create user",
      },
      { status: 500 }
    );
  }
}
