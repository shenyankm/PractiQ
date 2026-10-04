package com.practiq.android

internal object TokenRules {
    const val MAX_TOKEN_BYTES = 8192
    private val accountPattern = Regex("ai-service-token-[0-9a-f]{64}")

    fun validateAccount(account: String) {
        require(accountPattern.matches(account)) { "SECURE_STORAGE_INVALID_INPUT" }
    }

    fun validateToken(token: String) {
        require(token.length <= MAX_TOKEN_BYTES && token.all { it.code in 32..126 }) {
            "SECURE_STORAGE_INVALID_INPUT"
        }
    }
}

internal data class TokenEnvelope(val iv: ByteArray, val ciphertext: ByteArray) {
    companion object {
        private val MAGIC = byteArrayOf(80, 81, 84, 1)
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        const val MAX_BYTES = 4 + IV_BYTES + 16 + TokenRules.MAX_TOKEN_BYTES

        fun encode(iv: ByteArray, ciphertext: ByteArray): ByteArray {
            require(iv.size == IV_BYTES && ciphertext.size in 16..(16 + TokenRules.MAX_TOKEN_BYTES)) {
                "SECURE_STORAGE_UNAVAILABLE"
            }
            return MAGIC + iv + ciphertext
        }

        fun decode(payload: ByteArray): TokenEnvelope {
            require(payload.size in (4 + IV_BYTES + 16)..MAX_BYTES &&
                payload.copyOfRange(0, 4).contentEquals(MAGIC)) { "SECURE_STORAGE_UNAVAILABLE" }
            return TokenEnvelope(payload.copyOfRange(4, 4 + IV_BYTES), payload.copyOfRange(4 + IV_BYTES, payload.size))
        }
    }
}
