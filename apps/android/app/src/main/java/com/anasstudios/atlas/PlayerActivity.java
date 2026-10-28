package com.anasstudios.atlas;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.net.Uri;
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
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
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
 *
 * Online subtitles: "Find subtitles" (or the remote's Menu key) searches OpenSubtitles through
 * the ATLAS server, which holds the API key. A chosen file is added to the title as a WebVTT
 * track and switched on; the player's own subtitle button then switches between tracks.
 */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public class PlayerActivity extends Activity {
    static final String EXTRA_INFO = "info";
    static final String EXTRA_SERVER = "server";

    private static final String[][] SUBTITLE_LANGUAGES = {
            {"en", "English"}, {"es", "Spanish"}, {"fr", "French"}, {"de", "German"}, {"it", "Italian"}, {"pt", "Portuguese"},
            {"nl", "Dutch"}, {"ar", "Arabic"}, {"tr", "Turkish"}, {"pl", "Polish"}, {"all", "All languages"},
    };

    private PlayerView view;
    private ExoPlayer player;
    private LinearLayout banner;
    private TextView bannerTitle;
    private TextView bannerSub;
    private TextView errorView;
    private TextView subsButton;

    /** Subtitles added from OpenSubtitles for the current title, and the one to switch on next. */
    private final List<MediaItem.SubtitleConfiguration> onlineSubs = new ArrayList<>();
    private String pendingSubLabel;

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
        subsButton = findViewById(R.id.subs_online);
        subsButton.setOnClickListener(v -> findSubtitles(null));
        // Keep the controls (and this button) up while it has focus.
        subsButton.setOnFocusChangeListener((v, focused) -> {
            view.setControllerShowTimeoutMs(focused ? 0 : 3500);
            view.showController();
        });

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
        view.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) visibility -> showSubsButton(visibility == View.VISIBLE));
        view.requestFocus();
    }

    private boolean onlineSubtitles() {
        return !isLive() && info.optBoolean("onlineSubtitles", false);
    }

    private void showSubsButton(boolean controlsVisible) {
        subsButton.setVisibility(controlsVisible && onlineSubtitles() ? View.VISIBLE : View.GONE);
    }

    /** Start (or restart) the current title from its first source. */
    private void begin(double resumeAtSec) {
        sources = info.optJSONArray("sources");
        sourceIndex = 0;
        retries = 0;
        reportedQuality = false;
        liveRecorded = false;
        // Subtitles found online belong to the previous title.
        onlineSubs.clear();
        pendingSubLabel = null;
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT).build());
        showSubsButton(view.isControllerFullyVisible());
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
        if (!onlineSubs.isEmpty()) item.setSubtitleConfigurations(new ArrayList<>(onlineSubs));
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

        /** Switch on subtitles just added from OpenSubtitles once the player knows about the track. */
        @Override
        public void onTracksChanged(@NonNull Tracks tracks) {
            if (pendingSubLabel == null) return;
            for (Tracks.Group group : tracks.getGroups()) {
                if (group.getType() != C.TRACK_TYPE_TEXT) continue;
                for (int i = 0; i < group.length; i++) {
                    Format f = group.getTrackFormat(i);
                    if (pendingSubLabel.equals(f.label)) {
                        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                                .setOverrideForType(new TrackSelectionOverride(group.getMediaTrackGroup(), i))
                                .build());
                        pendingSubLabel = null;
                        return;
                    }
                }
            }
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

    /* ---------------- online subtitles ---------------- */

    /** Search OpenSubtitles through the server. `lang` null uses the profile's subtitle language. */
    private void findSubtitles(String lang) {
        if (!onlineSubtitles()) return;
        String path = "/api/subtitles/search?id=" + enc(info.optString("id")) + (lang != null ? "&lang=" + enc(lang) : "");
        toast("Searching OpenSubtitles…");
        final String cookie = cookie();
        io.execute(() -> {
            try {
                JSONObject res = new JSONObject(Http.request("GET", server + path, null, cookie));
                runOnUiThread(() -> showSubtitleResults(res));
            } catch (Exception e) {
                runOnUiThread(() -> toast(viewerMessage(e, "Couldn't search OpenSubtitles. Try again in a moment.")));
            }
        });
    }

    private void showSubtitleResults(JSONObject res) {
        if (isFinishing()) return;
        JSONArray results = res.optJSONArray("results");
        String language = res.optString("language", "en");
        boolean byName = "title".equals(res.optString("match"));
        AlertDialog.Builder dialog = new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Subtitles · " + languageName(language) + (byName && results != null && results.length() > 0 ? " (found by name, check the title)" : ""))
                .setNeutralButton("Other language", (d, w) -> chooseSubtitleLanguage())
                .setNegativeButton(android.R.string.cancel, null);
        if (results == null || results.length() == 0) {
            dialog.setMessage("No " + ("all".equals(language) ? "" : languageName(language) + " ") + "subtitles found for this title. Try another language.");
        } else {
            CharSequence[] labels = new CharSequence[results.length()];
            for (int i = 0; i < results.length(); i++) {
                JSONObject r = results.optJSONObject(i);
                StringBuilder meta = new StringBuilder(String.format(Locale.getDefault(), "%,d downloads", r.optInt("downloads")));
                if (r.optBoolean("hearingImpaired")) meta.append(" · SDH");
                if (r.optBoolean("machineTranslated")) meta.append(" · Machine translated");
                if ("title".equals(r.optString("match")) && !r.optString("feature").isEmpty()) meta.append(" · ").append(r.optString("feature"));
                labels[i] = r.optString("language").toUpperCase(Locale.ROOT) + "   " + r.optString("release") + "\n" + meta;
            }
            dialog.setItems(labels, (d, which) -> downloadSubtitle(results.optJSONObject(which)));
        }
        dialog.show();
    }

    private void chooseSubtitleLanguage() {
        CharSequence[] names = new CharSequence[SUBTITLE_LANGUAGES.length];
        for (int i = 0; i < names.length; i++) names[i] = SUBTITLE_LANGUAGES[i][1];
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Subtitle language")
                .setItems(names, (d, which) -> findSubtitles(SUBTITLE_LANGUAGES[which][0]))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void downloadSubtitle(JSONObject r) {
        if (r == null) return;
        long fileId = r.optLong("fileId");
        String language = r.optString("language", "und");
        String label = languageName(language) + (r.optBoolean("hearingImpaired") ? " (SDH)" : "") + " · OpenSubtitles";
        toast("Loading subtitles…");
        final String cookie = cookie();
        io.execute(() -> {
            try {
                JSONObject res = new JSONObject(Http.request("POST", server + "/api/subtitles/download", "{\"fileId\":" + fileId + "}", cookie));
                String url = server + res.optString("url");
                int remaining = res.optInt("remaining", -1);
                runOnUiThread(() -> addOnlineSubtitle(url, language, label, fileId, remaining));
            } catch (Exception e) {
                runOnUiThread(() -> toast(viewerMessage(e, "Couldn't load those subtitles. Try another result.")));
            }
        });
    }

    /** Add the file as a subtitle track and restart the title where it was, with that track on. */
    private void addOnlineSubtitle(String url, String language, String label, long fileId, int remaining) {
        if (player == null || isLive()) return;
        String id = "atlas-online-" + fileId;
        boolean added = false;
        for (MediaItem.SubtitleConfiguration c : onlineSubs) added |= id.equals(c.id);
        String lang = language.split("-")[0];
        if (!added) {
            onlineSubs.add(new MediaItem.SubtitleConfiguration.Builder(Uri.parse(url))
                    .setId(id)
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(lang)
                    .setLabel(label)
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                    .build());
        }
        pendingSubLabel = label;
        player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setPreferredTextLanguage(lang)
                .build());
        if (added) listener.onTracksChanged(player.getCurrentTracks());
        else startSource(player.getCurrentPosition());
        toast("Subtitles on: " + label + (remaining >= 0 && remaining <= 5 ? ". " + remaining + " OpenSubtitles downloads left today." : ""));
    }

    private static String languageName(String code) {
        for (String[] l : SUBTITLE_LANGUAGES) if (l[0].equals(code)) return l[1];
        String name = new Locale(code.split("-")[0]).getDisplayLanguage(Locale.ENGLISH);
        return name.isEmpty() || name.equalsIgnoreCase(code) ? code.toUpperCase(Locale.ROOT) : name;
    }

    /** Server messages are written for viewers; anything else gets a plain fallback. */
    private static String viewerMessage(Exception e, String fallback) {
        return e instanceof Http.ServerError ? e.getMessage() : fallback;
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
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
        // Menu (Fire TV's ☰ key) or a Subtitles/CC key: find subtitles online.
        if (event.getAction() == KeyEvent.ACTION_DOWN && onlineSubtitles()
                && (event.getKeyCode() == KeyEvent.KEYCODE_MENU || event.getKeyCode() == KeyEvent.KEYCODE_CAPTIONS)) {
            findSubtitles(null);
            return true;
        }
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
