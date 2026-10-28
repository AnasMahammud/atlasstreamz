package com.anasstudios.atlas;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Minimal JSON-over-HTTP helper for calls to the ATLAS server. Run off the main thread. */
final class Http {
    private Http() {}

    /** The server answered with an error; the message is written for the viewer. */
    static final class ServerError extends IOException {
        ServerError(String message) {
            super(message);
        }
    }

    static String request(String method, String url, String jsonBody, String cookie) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10_000);
        c.setReadTimeout(15_000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", "ATLAS-Android/" + BuildConfig.VERSION_NAME);
        if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
        if (jsonBody != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream out = c.getOutputStream()) {
                out.write(jsonBody.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String body = "";
        if (in != null) {
            try (InputStream stream = in) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int n;
                while ((n = stream.read(chunk)) > 0) buf.write(chunk, 0, n);
                body = buf.toString("UTF-8");
            }
        }
        c.disconnect();
        if (code >= 400) {
            String message = null;
            try {
                message = new org.json.JSONObject(body).optString("error", null);
            } catch (Exception ignored) {
                // Not an ATLAS error response.
            }
            throw message != null && !message.isEmpty() ? new ServerError(message) : new IOException("HTTP " + code);
        }
        return body;
    }
}
