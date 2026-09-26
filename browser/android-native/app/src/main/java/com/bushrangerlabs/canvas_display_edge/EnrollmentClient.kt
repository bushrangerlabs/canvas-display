package com.bushrangerlabs.canvas_display_edge

import android.util.Base64
import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.Signature
import java.util.concurrent.TimeUnit

class EnrollmentClient(
    context: Context,
    private val config: EdgeConfig,
    private val identity: EdgeIdentity,
) {
    private val http = CoreTls.client()
        .callTimeout(30, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    fun enrollIfNeeded(): Result<JSONObject?> {
        if (config.credentialJson.isNotBlank()) return Result.success(JSONObject(config.credentialJson))
        if (config.invitationToken.isBlank()) return Result.success(null)
        if (config.coreUrl.isBlank()) return Result.failure(IllegalStateException("Core URL is required"))

        return runCatching {
            val base = config.coreUrl.trimEnd('/')
            val begin = post(
                "$base/api/pairing/begin",
                JSONObject()
                    .put("invitation_token", config.invitationToken)
                    .put("installation_id", identity.installationId)
                    .put("public_key", identity.publicKeyHex),
            )
            val challengeId = begin.getString("challenge_id")
            val nonce = begin.getString("nonce_hex")
            val proofPayload = listOf(
                "canvas-edge-enrollment-v1",
                challengeId,
                nonce,
                identity.installationId,
                identity.fingerprint,
            ).joinToString("\n").toByteArray(Charsets.UTF_8)
            val signer = Signature.getInstance("Ed25519")
            signer.initSign(identity.privateKey)
            signer.update(proofPayload)
            val signature = Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
            val complete = post(
                "$base/api/pairing/complete",
                JSONObject()
                    .put("invitation_token", config.invitationToken)
                    .put("installation_id", identity.installationId)
                    .put("public_key", identity.publicKeyHex)
                    .put("challenge_id", challengeId)
                    .put("proof", JSONObject().put("challenge_id", challengeId).put("signature_bytes", signature)),
            )
            config.credentialJson = complete.toString()
            complete
        }
    }

    private fun post(url: String, payload: JSONObject): JSONObject {
        val response = http.newCall(
            Request.Builder().url(url).post(payload.toString().toRequestBody(jsonType)).build(),
        ).execute()
        val body = response.body?.string().orEmpty()
        if (!response.isSuccessful) error("Core enrollment HTTP ${response.code}: $body")
        return JSONObject(body)
    }
}
