package com.anasstudios.atlas;

import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts the ATLAS interface (served by your ATLAS server) in a WebView and hands playback to
 * {@link PlayerActivity}, which uses Media3/ExoPlayer for hardware-decoded video.
 *
 * Only pages from the configured ATLAS server (or the bundled connect screen) may call the
 * native bridge; everything else is opened outside the app.
 */
public class MainActivity extends Activity {
    static final String PREFS = "atlas";
    static final String KEY_SERVER = "server";
    private static final String CONNECT_PAGE = "file:///android_asset/connect.html";

    private WebView web;
    private String server = "";
    private volatile String currentUrl = "";
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    static boolean isTv(Context ctx) {
        UiModeManager ui = (UiModeManager) ctx.getSystemService(Context.UI_MODE_SERVICE);
        PackageManager pm = ctx.getPackageManager();
        return (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || pm.hasSystemFeature("amazon.hardware.fire_tv");
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        boolean tv = isTv(this);
        if (tv) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(8, 10, 14));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        // The web app reads this to pick its TV (remote-first) or touch layout.
        s.setUserAgentString(s.getUserAgentString() + " AtlasApp/" + BuildConfig.VERSION_NAME + (tv ? " (TV)" : " (Mobile)"));

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "AtlasNative");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new Client());

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        server = prefs.getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER);
        if (state != null) web.restoreState(state);
        else loadHome(null);
        web.requestFocus();
    }

    private void loadHome(String error) {
        if (server == null || server.isEmpty() || error != null) {
            String q = "?server=" + Uri.encode(server == null ? "" : server) + (error != null ? "&error=" + Uri.encode(error) : "");
            web.loadUrl(CONNECT_PAGE + q);
        } else {
            web.loadUrl(server + "/");
        }
    }

    private boolean trusted() {
        String url = currentUrl;
        return url.startsWith(CONNECT_PAGE) || (!server.isEmpty() && (url.equals(server) || url.startsWith(server + "/")));
    }

    /** Normalise what the user typed into a scheme + host (+ port) origin. */
    static String normaliseServer(String raw) {
        String v = raw.trim();
        if (v.isEmpty()) return v;
        if (!v.startsWith("http://") && !v.startsWith("https://")) {
            boolean local = v.matches("^(\\d{1,3}\\.){3}\\d{1,3}(:\\d+)?(/.*)?$") || v.startsWith("localhost") || v.matches("^[^/]+:\\d+(/.*)?$");
            v = (local ? "http://" : "https://") + v;
        }
        Uri u = Uri.parse(v);
        String origin = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        return origin.toLowerCase();
    }

    private final class Bridge {
        /** Connect screen: check the address really is an ATLAS server, then open it. */
        @JavascriptInterface
        public void connect(String raw) {
            if (!currentUrl.startsWith(CONNECT_PAGE)) return;
            final String candidate = normaliseServer(raw);
            io.execute(() -> {
                String error = null;
                try {
                    if (candidate.isEmpty() || Uri.parse(candidate).getHost() == null) throw new Exception("Enter your ATLAS server address.");
                    JSONObject status = new JSONObject(Http.request("GET", candidate + "/api/status", null, null));
                    if (!status.has("server")) throw new Exception("That address isn't an ATLAS server.");
                } catch (Exception e) {
                    error = e.getMessage() != null && !e.getMessage().isEmpty() ? e.getMessage() : "Couldn't reach that address.";
                    if (error.contains("Unable to resolve host") || error.contains("failed to connect") || error.contains("timeout")) {
                        error = "Couldn't reach that address. Check it and that the server is running.";
                    }
                }
                final String err = error;
                runOnUiThread(() -> {
                    if (err != null) {
                        web.evaluateJavascript("window.onConnectError && window.onConnectError(" + JSONObject.quote(err) + ")", null);
                        return;
                    }
                    server = candidate;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, server).apply();
                    web.clearHistory();
                    loadHome(null);
                });
            });
        }

        /** Settings → Change server. */
        @JavascriptInterface
        public void changeServer() {
            if (!trusted()) return;
            runOnUiThread(() -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_SERVER).apply();
                String previous = server;
                server = "";
                web.loadUrl(CONNECT_PAGE + "?server=" + Uri.encode(previous));
            });
        }

        /** Hand a title to the native player. `json` is the server's /api/play response. */
        @JavascriptInterface
        public void play(String json) {
            if (!trusted() || server.isEmpty()) return;
            Intent i = new Intent(MainActivity.this, PlayerActivity.class);
            i.putExtra(PlayerActivity.EXTRA_INFO, json);
            i.putExtra(PlayerActivity.EXTRA_SERVER, server);
            runOnUiThread(() -> startActivity(i));
        }

        @JavascriptInterface
        public String info() {
            if (!trusted()) return "{}";
            try {
                return new JSONObject().put("version", BuildConfig.VERSION_NAME).put("tv", isTv(MainActivity.this)).put("server", server).toString();
            } catch (Exception e) {
                return "{}";
            }
        }
    }

    private final class Client extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            currentUrl = url == null ? "" : url;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            currentUrl = url == null ? "" : url;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (url.startsWith(CONNECT_PAGE) || (!server.isEmpty() && url.startsWith(server))) return false;
            // Anything else (help links, provider pages) opens outside the app where possible.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
                // No browser on most TVs: stay put.
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && !server.isEmpty() && request.getUrl().toString().startsWith(server)) {
                loadHome("Couldn't reach " + server + ". " + error.getDescription());
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (currentUrl.startsWith(CONNECT_PAGE)) {
            super.onBackPressed();
            return;
        }
        // Let the app close dialogs/menus and navigate back; at the top level, leave the app.
        web.evaluateJavascript("(window.__atlasBack ? window.__atlasBack() : false)", value -> {
            if (!"true".equals(value)) {
                if (web.canGoBack()) web.goBack();
                else finish();
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // Returning from the player: refresh Continue Watching and progress.
        web.evaluateJavascript("window.__atlasResumed && window.__atlasResumed()", null);
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }
}
