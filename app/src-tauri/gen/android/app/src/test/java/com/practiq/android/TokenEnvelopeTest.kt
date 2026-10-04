package com.practiq.android

import org.junit.Assert.*
import org.junit.Test

class TokenEnvelopeTest {
    private val account = "ai-service-token-" + "a".repeat(64)

    @Test fun accountAcceptsOnlyCanonicalHashedNamespace() {
        TokenRules.validateAccount(account)
        for (invalid in listOf("", "../$account", account.uppercase(), account + ".bak", "ai-service-token-" + "a".repeat(63))) {
            assertThrows(IllegalArgumentException::class.java) { TokenRules.validateAccount(invalid) }
        }
    }

    @Test fun tokenMatchesRustAsciiAndSizeBoundary() {
        TokenRules.validateToken("x".repeat(8192))
        TokenRules.validateToken(" ")
        TokenRules.validateToken("")
        for (invalid in listOf("x".repeat(8193), "secret\n", "secret\u007f", "é", "\u0000")) {
            assertThrows(IllegalArgumentException::class.java) { TokenRules.validateToken(invalid) }
        }
    }

    @Test fun envelopeRoundTripsIvAndCiphertextAtBothBounds() {
        for (size in listOf(16, 16 + TokenRules.MAX_TOKEN_BYTES)) {
            val iv = ByteArray(12) { it.toByte() }
            val ciphertext = ByteArray(size) { 42 }
            val envelope = TokenEnvelope.decode(TokenEnvelope.encode(iv, ciphertext))
            assertArrayEquals(iv, envelope.iv)
            assertArrayEquals(ciphertext, envelope.ciphertext)
        }
    }

    @Test fun envelopeRejectsWrongVersionTruncationOversizeAndIvLength() {
        val valid = TokenEnvelope.encode(ByteArray(12), ByteArray(16))
        for (invalid in listOf(ByteArray(0), valid.copyOf(31), valid.copyOf().apply { this[3] = 2 }, ByteArray(TokenEnvelope.MAX_BYTES + 1))) {
            assertThrows(IllegalArgumentException::class.java) { TokenEnvelope.decode(invalid) }
        }
        assertThrows(IllegalArgumentException::class.java) { TokenEnvelope.encode(ByteArray(11), ByteArray(16)) }
        assertThrows(IllegalArgumentException::class.java) { TokenEnvelope.encode(ByteArray(12), ByteArray(15)) }
    }
}
