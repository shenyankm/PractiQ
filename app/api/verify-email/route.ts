import { NextRequest, NextResponse } from "next/server";
import { createVerificationCode } from "@/lib/verification";
import { sendVerificationEmail } from "@/lib/email";
import type { ApiResponse, SendVerificationRequest } from "@/lib/types";

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  return "unknown";
}

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<{ code?: string }>>> {
  try {
    const body: SendVerificationRequest = await request.json();

    if (!body.email) {
      return NextResponse.json(
        { success: false, error: "Email is required" },
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

    const ipAddress = getClientIp(request);
    const purpose = body.purpose || "register";

    const result = await createVerificationCode(body.email, purpose, ipAddress);

    if (!result.success || !result.code) {
      return NextResponse.json(
        { success: false, error: result.error || "Failed to generate verification code" },
        { status: 429 }
      );
    }

    const sendResult = await sendVerificationEmail(body.email, result.code);

    if (!sendResult.success) {
      console.error("Failed to send verification email:", sendResult.error);
      return NextResponse.json(
        { success: false, error: sendResult.error || "Failed to send verification email" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Verification code sent successfully. Please check your email.",
    });
  } catch (error) {
    console.error("POST /api/verify-email error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to send verification code",
      },
      { status: 500 }
    );
  }
}
