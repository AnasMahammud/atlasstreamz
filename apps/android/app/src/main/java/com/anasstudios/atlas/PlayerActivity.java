package com.anasstudios.atlas;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native playback with Media3/ExoPlayer: hardware decoding, HLS, MPEG-TS, MP4 and MKV, embedded
 * audio/subtitle track selection, and remote/media keys. Streams come from the ATLAS server's
 * proxy using the signed-in session, so provider credentials never reach this device.
 *
 * Recovery: a failed source falls back to the next engine the server offered (e.g. HLS →
 * MPEG-TS); live streams that fall behind rejoin the live edge; transient failures retry twice.
 */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public class PlayerActivity extends Activity {
    static final String EXTRA_INFO = "info";
    static final String EXTRA_SERVER = "server";

    private PlayerView view;
    private ExoPlayer player;
    private LinearLayout banner;
    private TextView bannerTitle;
    private TextView bannerSub;
    private TextView errorView;

    private String server;
    private JSONObject info;
    private JSONArray sources;
    private int sourceIndex;
    private int retries;
    private boolean reportedQuality;
    private boolean liveRecorded;
    private boolean switching;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Runnable saver = new Runnable() {
        @Override
        public void run() {
            saveProgress();
            handler.postDelayed(this, 10_000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_player);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        view = findViewById(R.id.player_view);
        banner = findViewById(R.id.banner);
        bannerTitle = findViewById(R.id.banner_title);
        bannerSub = findViewById(R.id.banner_sub);
        errorView = findViewById(R.id.error);

        server = getIntent().getStringExtra(EXTRA_SERVER);
        try {
            info = new JSONObject(getIntent().getStringExtra(EXTRA_INFO));
        } catch (Exception e) {
            finish();
            return;
        }
        buildPlayer();
        begin(info.optDouble("resumeAt", 0));
    }

    private boolean isLive() {
        return "live".equals(info.optString("kind"));
    }

    private String cookie() {
        String c = CookieManager.getInstance().getCookie(server);
        return c == null ? "" : c;
    }

    private void buildPlayer() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cookie", cookie());
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("ATLAS-Android/" + BuildConfig.VERSION_NAME)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15_000)
                .setReadTimeoutMs(20_000)
                .setDefaultRequestProperties(headers);
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
                .setSeekBackIncrementMs(10_000)
                .setSeekForwardIncrementMs(10_000)
                .build();
        player.setAudioAttributes(AudioAttributes.DEFAULT, true);
        player.addListener(listener);
        view.setPlayer(player);
        view.setShowNextButton(false);
        view.setShowPreviousButton(false);
        view.setControllerShowTimeoutMs(3500);
        view.requestFocus();
    }

    /** Start (or restart) the current title from its first source. */
    private void begin(double resumeAtSec) {
        sources = info.optJSONArray("sources");
        sourceIndex = 0;
        retries = 0;
        reportedQuality = false;
        liveRecorded = false;
        errorView.setVisibility(View.GONE);
        showBanner();
        if (sources == null || sources.length() == 0) {
            showError("Nothing to play for this title.");
            return;
        }
        startSource(isLive() ? C.TIME_UNSET : (long) (resumeAtSec * 1000));
    }

    private void startSource(long startMs) {
        JSONObject src = sources.optJSONObject(sourceIndex);
        if (src == null) return;
        String url = server + src.optString("url");
        String engine = src.optString("engine");
        MediaItem.Builder item = new MediaItem.Builder().setUri(url);
        if ("hls".equals(engine)) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        else if ("mpegts".equals(engine)) item.setMimeType(MimeTypes.VIDEO_MP2T);
        if (startMs != C.TIME_UNSET && startMs > 0) player.setMediaItem(item.build(), startMs);
        else player.setMediaItem(item.build());
        player.prepare();
        player.setPlayWhenReady(true);
        handler.removeCallbacks(saver);
        handler.postDelayed(saver, 10_000);
    }

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onPlayerError(@NonNull PlaybackException e) {
            if (isLive() && e.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                player.seekToDefaultPosition();
                player.prepare();
                return;
            }
            long position = isLive() ? C.TIME_UNSET : player.getCurrentPosition();
            if (sourceIndex + 1 < sources.length()) {
                sourceIndex++;
                startSource(position);
                return;
            }
            if (retries < 2 && isTransient(e)) {
                retries++;
                handler.postDelayed(() -> {
                    sourceIndex = 0;
                    startSource(position);
                }, 2000L * retries);
                return;
            }
            showError(describe(e));
        }

        @Override
        public void onVideoSizeChanged(@NonNull VideoSize size) {
            if (reportedQuality || size.height <= 0) return;
            reportedQuality = true;
            post("POST", "/api/me/quality/" + enc(info.optString("id")), "{\"width\":" + size.width + ",\"height\":" + size.height + "}");
        }

        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) {
                errorView.setVisibility(View.GONE);
                retries = 0;
            }
            if (state == Player.STATE_ENDED && !isLive()) {
                saveProgress();
                JSONObject next = info.optJSONObject("nextEpisode");
                if (next != null && info.optBoolean("autoplayNext", true)) openTitle(next.optString("id"));
                else finish();
            }
        }
    };

    private boolean isTransient(PlaybackException e) {
        int c = e.errorCode;
        return c == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || c == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
                || c == PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                || c == PlaybackException.ERROR_CODE_TIMEOUT;
    }

    private String describe(PlaybackException e) {
        switch (e.errorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
                return "Can't reach the stream. Check your internet connection and try again.";
            case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS:
                return isLive() ? "This channel isn't available right now. The provider may be off air or at its stream limit." : "The provider refused this title. Try again in a moment.";
            case PlaybackException.ERROR_CODE_DECODER_INIT_FAILED:
            case PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED:
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED:
                return "This device can't decode this video format.";
            default:
                return "Playback stopped: " + e.getErrorCodeName().replace("ERROR_CODE_", "").replace('_', ' ').toLowerCase(Locale.ROOT) + ".";
        }
    }

    private void showError(String message) {
        errorView.setText(message + "\n\nPress Back to return.");
        errorView.setVisibility(View.VISIBLE);
    }

    private void showBanner() {
        String title = info.optString("title");
        String sub = info.optString("subtitle", "");
        JSONObject live = info.optJSONObject("live");
        if (live != null) {
            int number = live.optInt("number", 0);
            if (number > 0) title = number + "  " + title;
            JSONObject now = live.optJSONObject("now");
            sub = now != null ? now.optString("title") : "Live";
        } else {
            JSONObject ep = info.optJSONObject("episode");
            if (ep != null) sub = "S" + ep.optInt("season") + " · E" + ep.optInt("episode") + " · " + ep.optString("title");
        }
        bannerTitle.setText(title);
        bannerSub.setText(sub);
        bannerSub.setVisibility(sub.isEmpty() ? View.GONE : View.VISIBLE);
        banner.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideBanner);
        handler.postDelayed(hideBanner, 4500);
    }

    private final Runnable hideBanner = () -> banner.setVisibility(View.GONE);

    /** Switch to another channel or episode by asking the server for its play info. */
    private void openTitle(String id) {
        if (id == null || id.isEmpty() || switching) return;
        switching = true;
        saveProgress();
        io.execute(() -> {
            try {
                JSONObject next = new JSONObject(Http.request("GET", server + "/api/play/" + enc(id), null, cookie()));
                runOnUiThread(() -> {
                    switching = false;
                    info = next;
                    begin(next.optDouble("resumeAt", 0));
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    switching = false;
                    showError("Couldn't open that title.");
                });
            }
        });
    }

    private void switchChannel(boolean up) {
        JSONObject live = info.optJSONObject("live");
        if (live == null) return;
        // Channel Up goes to the next (higher) number, like a TV.
        String target = live.optString(up ? "nextChannel" : "prevChannel", "");
        if (!target.isEmpty()) openTitle(target);
    }

    private void saveProgress() {
        if (player == null || info == null) return;
        String id = info.optString("id");
        if (isLive()) {
            if (!liveRecorded && player.isPlaying()) {
                liveRecorded = true;
                post("PUT", "/api/me/progress/" + enc(id), "{\"position\":0,\"duration\":1}");
            }
            return;
        }
        long duration = player.getDuration();
        long position = player.getCurrentPosition();
        if (duration == C.TIME_UNSET || duration <= 0 || position < 5_000) return;
        post("PUT", "/api/me/progress/" + enc(id), String.format(Locale.ROOT, "{\"position\":%.1f,\"duration\":%.1f}", position / 1000.0, duration / 1000.0));
    }

    private void post(String method, String path, String body) {
        final String cookie = cookie();
        io.execute(() -> {
            try {
                Http.request(method, server + path, body, cookie);
            } catch (Exception ignored) {
                // Progress is best-effort; the next save will catch up.
            }
        });
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return s;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN && isLive()) {
            int code = event.getKeyCode();
            boolean controlsHidden = !view.isControllerFullyVisible();
            if (code == KeyEvent.KEYCODE_CHANNEL_UP || code == KeyEvent.KEYCODE_PAGE_UP || (controlsHidden && code == KeyEvent.KEYCODE_DPAD_UP)) {
                switchChannel(true);
                return true;
            }
            if (code == KeyEvent.KEYCODE_CHANNEL_DOWN || code == KeyEvent.KEYCODE_PAGE_DOWN || (controlsHidden && code == KeyEvent.KEYCODE_DPAD_DOWN)) {
                switchChannel(false);
                return true;
            }
            if (code == KeyEvent.KEYCODE_INFO || code == KeyEvent.KEYCODE_GUIDE) {
                showBanner();
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onBackPressed() {
        if (view.isControllerFullyVisible() && errorView.getVisibility() != View.VISIBLE) {
            view.hideController();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Phones: keep watching in a small window when leaving the app.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && player != null && player.isPlaying() && !MainActivity.isTv(this)) {
            try {
                enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(16, 9)).build());
            } catch (Exception ignored) {
                // PiP not supported on this device.
            }
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        saveProgress();
        if (player != null && !(Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode())) player.pause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        saveProgress();
        if (player != null) {
            player.release();
            player = null;
        }
        io.shutdown();
        super.onDestroy();
    }
}
