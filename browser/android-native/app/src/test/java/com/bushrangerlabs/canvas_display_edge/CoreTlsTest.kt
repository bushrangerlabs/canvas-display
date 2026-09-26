package com.bushrangerlabs.canvas_display_edge

import java.io.File
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.xml.parsers.DocumentBuilderFactory
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class CoreTlsTest {
    private val main = File("src/main")

    @Test fun platformDefaultsAndAllFourCallSites() {
        assertSame(OkHttpClient().hostnameVerifier, CoreTls.client().build().hostnameVerifier)
        val sources = listOf("CoreEdgeClient.kt", "EnrollmentClient.kt", "voice/VoiceConfigClient.kt", "voice/VoiceTurnClient.kt")
        for (name in sources) {
            val source = File(main, "java/com/bushrangerlabs/canvas_display_edge/$name").readText()
            assertTrue(name, source.contains("private val http = CoreTls.client()"))
            assertFalse(name, source.contains(".hostnameVerifier"))
            assertFalse(name, source.contains(".sslSocketFactory"))
        }
        val factory = File(main, "java/com/bushrangerlabs/canvas_display_edge/CoreTls.kt").readText()
        assertTrue(factory.contains("fun client(): OkHttpClient.Builder = OkHttpClient.Builder()"))
    }

    @Test fun bundledCaMatchesAuthenticatedFingerprint() {
        val certificate = File(main, "res/raw/canvas_core_ca.pem").inputStream().use {
            java.security.cert.CertificateFactory.getInstance("X.509")
                .generateCertificate(it) as java.security.cert.X509Certificate
        }
        val fingerprint = java.security.MessageDigest.getInstance("SHA-256")
            .digest(certificate.encoded).joinToString(":") { "%02X".format(it) }
        assertEquals("6F:A2:C5:29:BB:12:39:AB:5D:07:1B:6D:B5:87:7D:34:A2:15:E6:14:41:4D:D7:18:92:8C:A1:81:B6:76:D9:86", fingerprint)
        assertTrue("Trust anchor must be a CA", certificate.basicConstraints >= 0)
        assertEquals("RSA", certificate.publicKey.algorithm)
    }

    @Test fun packagedPolicyScopesCaTrustProhibitsCoreHttpAndPreservesExternalPanels() {
        val parser = DocumentBuilderFactory.newInstance().newDocumentBuilder()
        val policy = parser.parse(File(main, "res/xml/network_security_config.xml"))
        val base = policy.getElementsByTagName("base-config").item(0) as Element
        assertEquals("true", base.getAttribute("cleartextTrafficPermitted"))
        fun anchors(element: Element): Set<String> {
            val nodes = element.getElementsByTagName("certificates")
            return (0 until nodes.length).map { (nodes.item(it) as Element).getAttribute("src") }.toSet()
        }
        assertEquals(setOf("system", "user"), anchors(base))
        val configs = policy.getElementsByTagName("domain-config")
        assertEquals(1, configs.length)
        val core = configs.item(0) as Element
        assertEquals("false", core.getAttribute("cleartextTrafficPermitted"))
        assertEquals(setOf("@raw/canvas_core_ca"), anchors(core))
        val domains = core.getElementsByTagName("domain")
        assertEquals(setOf("192.168.1.108", "canvas-core.local"),
            (0 until domains.length).map {
                val domain = domains.item(it) as Element
                assertEquals("false", domain.getAttribute("includeSubdomains"))
                domain.textContent.trim()
            }.toSet())
        val manifest = parser.parse(File(main, "AndroidManifest.xml"))
        val app = manifest.getElementsByTagName("application").item(0) as Element
        assertEquals("@xml/network_security_config", app.getAttribute("android:networkSecurityConfig"))
        val activity = File(main, "java/com/bushrangerlabs/canvas_display_edge/MainActivity.kt").readText()
        assertTrue(activity.contains("private fun rendererUrl(url: String): String = url"))
        assertFalse(activity.contains("http://192.168.1.108:3101"))
    }

    // JVM tests cannot execute Android NSC. Use ephemeral test-only trust to exercise
    // real TLS requests and the production builder's unchanged hostname verifier.
    private fun tlsRequest(san: String, trusted: Boolean, action: (OkHttpClient, MockWebServer) -> Unit) {
        val certificate = HeldCertificate.Builder().rsa2048().addSubjectAlternativeName(san).build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        MockWebServer().use { server ->
            server.useHttps(serverTls.sslSocketFactory(), false)
            server.start()
            server.enqueue(MockResponse().setBody("ok"))
            val builder = CoreTls.client().callTimeout(5, TimeUnit.SECONDS)
            if (trusted) {
                val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
                builder.sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
            }
            val client = builder.build()
            try { action(client, server) } finally {
                client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdownNow()
            }
        }
    }

    @Test fun matchingTrustedHostnameSendsRequest() = tlsRequest("localhost", true) { client, server ->
        val url = server.url("/api/pairing/begin").newBuilder().host("localhost").build()
        client.newCall(Request.Builder().url(url).build()).execute().use {
            assertEquals(200, it.code)
            assertEquals("ok", it.body!!.string())
        }
        assertEquals("/api/pairing/begin", server.takeRequest(1, TimeUnit.SECONDS)!!.path)
    }

    @Test fun trustedCertificateWithWrongHostnameIsRejectedBeforeHttp() = tlsRequest("wrong.invalid", true) { client, server ->
        assertThrows(SSLPeerUnverifiedException::class.java) {
            client.newCall(Request.Builder().url(server.url("/")).build()).execute().close()
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun untrustedCertificateIsRejectedBeforeHttp() = tlsRequest("localhost", false) { client, server ->
        assertThrows(SSLHandshakeException::class.java) {
            client.newCall(Request.Builder().url(server.url("/")).build()).execute().close()
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun explicitHttpPanelRequestIsNotRewritten() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("panel"))
            val client = CoreTls.client().build()
            try {
                client.newCall(Request.Builder().url(server.url("/panel?q=1")).build()).execute().use {
                    assertEquals("panel", it.body!!.string())
                    assertFalse(it.request.url.isHttps)
                }
                assertEquals("/panel?q=1", server.takeRequest(1, TimeUnit.SECONDS)!!.path)
            } finally {
                client.connectionPool.evictAll()
                client.dispatcher.executorService.shutdownNow()
            }
        }
    }
}
