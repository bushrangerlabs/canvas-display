package com.bushrangerlabs.canvas_display_edge

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest

class EdgeIdentity {
    companion object {
        private const val ALIAS = "canvas-edge-device-identity"
    }

    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    init {
        if (!keyStore.containsAlias(ALIAS)) {
            val generator = KeyPairGenerator.getInstance("Ed25519", "AndroidKeyStore")
            generator.initialize(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setDigests(KeyProperties.DIGEST_NONE)
                    .build(),
            )
            generator.generateKeyPair()
        }
    }

    private val publicKeyBytes: ByteArray
        get() = keyStore.getCertificate(ALIAS).publicKey.encoded.takeLast(32).toByteArray()

    val installationId: String = "android-${MessageDigest.getInstance("SHA-256").digest(publicKeyBytes).toHex().take(24)}"
    val fingerprint: String get() = MessageDigest.getInstance("SHA-256").digest(publicKeyBytes).toHex()
    val publicKeyHex: String get() = publicKeyBytes.toHex()
    val privateKey: java.security.PrivateKey
        get() = keyStore.getKey(ALIAS, null) as java.security.PrivateKey

    fun sign(payload: ByteArray): ByteArray {
        val signature = java.security.Signature.getInstance("Ed25519")
        signature.initSign(privateKey)
        signature.update(payload)
        return signature.sign()
    }
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
