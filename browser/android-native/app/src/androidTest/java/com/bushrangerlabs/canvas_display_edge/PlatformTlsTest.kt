package com.bushrangerlabs.canvas_display_edge

import android.net.http.SslError
import android.security.NetworkSecurityPolicy
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PlatformTlsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun withClient(dns: Dns? = null, action: (OkHttpClient) -> Unit) {
        val client = CoreTls.client().callTimeout(15, TimeUnit.SECONDS)
            .apply { if (dns != null) dns(dns) }
            .build()
        try { action(client) } finally {
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdownNow()
        }
    }

    private data class PageResult(val error: String? = null, val sslError: SslError? = null)

    // Uses the target app context and its real NSC. Never overrides certificate trust.
    private fun loadPage(url: String): PageResult {
        val done = CountDownLatch(1)
        val result = AtomicReference<PageResult>()
        lateinit var view: WebView
        instrumentation.runOnMainSync {
            view = WebView(instrumentation.targetContext)
            view.webViewClient = object : WebViewClient() {
                private fun finish(value: PageResult) {
                    result.compareAndSet(null, value)
                    done.countDown()
                }
                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                    finish(PageResult("TLS rejected", error))
                    handler.cancel()
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) finish(PageResult(error.description.toString()))
                }
                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    if (request.isForMainFrame) finish(PageResult("HTTP ${response.statusCode}"))
                }
                override fun onPageFinished(view: WebView, finishedUrl: String) {
                    if (finishedUrl == url) finish(PageResult())
                }
            }
            view.loadUrl(url)
        }
        try {
            assertTrue("WebView timed out: $url", done.await(20, TimeUnit.SECONDS))
            return result.get()
        } finally {
            instrumentation.runOnMainSync { view.stopLoading(); view.destroy() }
        }
    }

    @Test fun coreHttpIsProhibitedByPlatformAndBothClients() {
        val policy = NetworkSecurityPolicy.getInstance()
        for (host in listOf("192.168.1.108", "canvas-core.local")) {
            assertFalse("Core HTTP must be prohibited for $host", policy.isCleartextTrafficPermitted(host))
        }
        // DNS resolution can precede OkHttp's policy check. Use the IP for runtime
        // checks in both clients so tablet mDNS support is not a prerequisite.
        val url = "http://192.168.1.108:3100/"
        withClient { client ->
            val error = assertThrows(IOException::class.java) {
                client.newCall(Request.Builder().url(url).build()).execute().close()
            }
            assertTrue(error.toString(), error.message.orEmpty().contains("CLEARTEXT"))
        }
        val page = loadPage(url)
        assertTrue(page.toString(), page.error.orEmpty().contains("CLEARTEXT"))
        assertTrue(policy.isCleartextTrafficPermitted("external-panel.invalid"))
        assertTrue(policy.isCleartextTrafficPermitted("localhost"))
    }

    @Test fun untrustedHttpsIsRejectedByPlatformOkHttpAndWebView() {
        val cert = HeldCertificate.Builder().rsa2048().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        MockWebServer().use { server ->
            server.useHttps(tls.sslSocketFactory(), false)
            server.start()
            server.enqueue(MockResponse().setBody("must not load"))
            val url = server.url("/health").newBuilder().host("localhost").build().toString()
            withClient { client ->
                assertThrows(SSLException::class.java) {
                    client.newCall(Request.Builder().url(url).build()).execute().close()
                }
            }
            assertNotNull("Expected WebView certificate error", loadPage(url).sslError)
            assertEquals(0, server.requestCount)
        }
    }

    // Coordinator opt-in: -e coreHealthUrl https://192.168.1.108:3100/<health-path>
    // Run again with canvas-core.local to cover DNS/SAN resolution on the tablet.
    @Test fun liveCoreHealthUsesPlatformTrustInOkHttpAndWebView() {
        val url = InstrumentationRegistry.getArguments().getString("coreHealthUrl")
        assumeTrue("Coordinator must provide coreHealthUrl", !url.isNullOrBlank())
        val parsed = url!!.toHttpUrl()
        assertTrue(parsed.isHttps)
        assertTrue(parsed.host in setOf("192.168.1.108", "canvas-core.local"))
        withClient { client ->
            client.newCall(Request.Builder().url(parsed).build()).execute().use {
                assertTrue("Health HTTP ${it.code}", it.isSuccessful)
                assertTrue("HTTPS must not redirect to HTTP", it.request.url.isHttps)
            }
        }
        assertNull(loadPage(url).error)
    }

    // Optional OkHttp-only variant: wrongHostnameIp is a literal IPv4 destination.
    // DNS mapping preserves the URL host, SNI, NSC trust scope and hostname verifier.
    // WebView has no equivalent per-instance DNS hook; its test below stays separate.
    @Test fun wrongHostnameIsRejectedByOkHttpWithDnsMapping() {
        val arguments = InstrumentationRegistry.getArguments()
        val url = arguments.getString("wrongHostnameUrl")
        val ip = arguments.getString("wrongHostnameIp")
        assumeTrue("Coordinator must provide wrongHostnameUrl and wrongHostnameIp",
            !url.isNullOrBlank() && !ip.isNullOrBlank())
        val parsed = url!!.toHttpUrl()
        assertTrue(parsed.isHttps)
        val octets = ip!!.split('.')
        require(octets.size == 4 && octets.all {
            it.matches(Regex("[0-9]{1,3}")) && it.toInt() in 0..255
        }) { "wrongHostnameIp must be a literal IPv4 address" }
        val address = InetAddress.getByAddress(octets.map { it.toInt().toByte() }.toByteArray())
        val dns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                require(hostname == parsed.host) { "Unexpected DNS lookup: $hostname" }
                return listOf(address)
            }
        }
        withClient(dns) { client ->
            assertThrows(javax.net.ssl.SSLPeerUnverifiedException::class.java) {
                client.newCall(Request.Builder().url(parsed).build()).execute().close()
            }
        }
    }

    // Optional coordinator-provided, reachable fixture with a trusted chain but wrong SAN.
    // No DNS failure, timeout, or generic trust failure is accepted as a hostname test pass.
    @Test fun wrongHostnameIsRejectedByBothClients() {
        val url = InstrumentationRegistry.getArguments().getString("wrongHostnameUrl")
        assumeTrue("Coordinator must provide wrongHostnameUrl", !url.isNullOrBlank())
        assertTrue(url!!.toHttpUrl().isHttps)
        withClient { client ->
            assertThrows(javax.net.ssl.SSLPeerUnverifiedException::class.java) {
                client.newCall(Request.Builder().url(url).build()).execute().close()
            }
        }
        val error = loadPage(url).sslError
        assertNotNull("Expected WebView hostname error", error)
        assertTrue(error!!.hasError(SslError.SSL_IDMISMATCH))
    }
}
